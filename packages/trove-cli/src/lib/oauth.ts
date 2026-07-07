import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError, ExitCode } from '../errors.js';

/**
 * The interactive `trove login` flow: the CLI
 * is a public OAuth client with no secret, so it uses the **loopback
 * authorization-code + PKCE** grant (RFC 8252):
 *
 * 1. Discover the protected-resource metadata from the API
 *    (`/.well-known/oauth-protected-resource`), then the authorization-server
 *    metadata it points at (Clerk).
 * 2. Spin a `127.0.0.1` callback server, build the authorization URL with a PKCE
 *    `code_challenge`, and open the browser.
 * 3. Capture the `code` on the loopback redirect and exchange it (with the
 *    `code_verifier`) at the token endpoint for an access token.
 *
 * Every external seam — `fetch`, the browser opener, the loopback server — is
 * injectable so the whole flow is unit-tested with mocks. The genuinely
 * unrunnable parts (a real browser, a live Clerk instance) are marked at the
 * call sites.
 *
 * @module
 */

/** OAuth protected-resource metadata (RFC 9728), the fields the CLI reads. */
export interface ProtectedResourceMetadata {
  /** The authorization servers that issue tokens for this resource. */
  authorization_servers?: string[];
}

/** OAuth authorization-server metadata (RFC 8414), the fields the CLI reads. */
export interface AuthServerMetadata {
  /** The issuer identifier. */
  issuer: string;
  /** The authorization endpoint (browser redirect target). */
  authorization_endpoint: string;
  /** The token endpoint (code → token exchange). */
  token_endpoint: string;
  /** The RFC 7591 dynamic client registration endpoint, when advertised. */
  registration_endpoint?: string;
}

/** A PKCE verifier/challenge pair. */
export interface Pkce {
  /** The high-entropy `code_verifier`. */
  verifier: string;
  /** The S256 `code_challenge` derived from the verifier. */
  challenge: string;
}

/** A started loopback callback server: its bound port and the eventual code. */
export interface LoopbackHandle {
  /** The bound `127.0.0.1` port (for the redirect URI). */
  port: number;
  /** Resolves with the captured `{ code, state }` when the browser redirects. */
  code: Promise<{ code: string; state: string }>;
}

/** Injection points for {@link runLoginFlow} (mocked in tests). */
export interface LoginFlowDeps {
  /** A `fetch` implementation for discovery + token exchange. */
  fetchImpl: typeof fetch;
  /** Opens a URL in the user's browser. Returns when the open is dispatched. */
  openBrowser: (url: string) => Promise<void>;
  /**
   * Start the loopback callback server, returning its bound port immediately and
   * a promise for the captured authorization code. The browser is opened
   * **after** this resolves so the redirect URI carries the real port.
   */
  startLoopback: (redirectPath: string) => Promise<LoopbackHandle>;
  /** PKCE generator (injected for deterministic tests). */
  makePkce?: () => Pkce;
  /** State generator (injected for deterministic tests). */
  makeState?: () => string;
  /** A sink for human progress lines (stderr). */
  onProgress?: (line: string) => void;
}

/** Inputs describing what to authorize against. */
export interface LoginFlowInput {
  /** The API base URL (protected resource) to discover metadata from. */
  apiUrl: string;
  /** The OAuth client id to present. Defaults to a public CLI client id. */
  clientId?: string;
  /** Requested scopes. */
  scope?: string;
}

/**
 * Generate a PKCE verifier + S256 challenge (RFC 7636).
 *
 * @returns A fresh {@link Pkce} pair.
 */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Base64url-encode a buffer with no padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Fetch JSON from a URL, raising a transport error on a non-2xx or non-JSON body.
 *
 * @param fetchImpl - The fetch implementation.
 * @param url - The URL to GET.
 * @param label - A label for error messages.
 * @returns The parsed JSON body.
 */
async function fetchJson(fetchImpl: typeof fetch, url: string, label: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new CliError(`${label} discovery failed (HTTP ${res.status}).`, ExitCode.Transport);
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new CliError(`${label} returned a non-JSON body.`, ExitCode.Transport);
  }
}

/**
 * Discover the authorization-server metadata for an API base URL: read the
 * protected-resource metadata, follow `authorization_servers[0]`, then read its
 * `.well-known/oauth-authorization-server`.
 *
 * @param fetchImpl - The fetch implementation.
 * @param apiUrl - The API base URL.
 * @returns The resolved {@link AuthServerMetadata}.
 * @throws {@link CliError} when discovery fails or omits required endpoints.
 */
export async function discoverAuthServer(
  fetchImpl: typeof fetch,
  apiUrl: string,
): Promise<AuthServerMetadata> {
  const base = apiUrl.replace(/\/+$/, '');
  const prm = (await fetchJson(
    fetchImpl,
    `${base}/.well-known/oauth-protected-resource`,
    'Protected-resource',
  )) as ProtectedResourceMetadata;
  const authServer = prm.authorization_servers?.[0];
  if (typeof authServer !== 'string' || authServer.length === 0) {
    throw new CliError(
      'Protected-resource metadata did not advertise an authorization server.',
      ExitCode.Transport,
    );
  }
  const asUrl = authServer.replace(/\/+$/, '');
  const meta = (await fetchJson(
    fetchImpl,
    `${asUrl}/.well-known/oauth-authorization-server`,
    'Authorization-server',
  )) as Partial<AuthServerMetadata>;
  if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new CliError(
      'Authorization-server metadata is missing required endpoints.',
      ExitCode.Transport,
    );
  }
  return {
    issuer: typeof meta.issuer === 'string' ? meta.issuer : asUrl,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    ...(typeof meta.registration_endpoint === 'string'
      ? { registration_endpoint: meta.registration_endpoint }
      : {}),
  };
}

/**
 * Dynamically register a public PKCE client with the authorization server
 * (RFC 7591) — the same self-registration an MCP client does against `/mcp`.
 *
 * The CLI holds no pre-provisioned client id; it registers a public client
 * (`token_endpoint_auth_method: "none"`) bound to the exact loopback redirect it
 * will listen on, and reuses the returned id on later logins (cached in config).
 *
 * @param fetchImpl - The fetch implementation.
 * @param registrationEndpoint - The RFC 7591 registration endpoint.
 * @param redirectUri - The exact loopback redirect to register.
 * @returns The issued `client_id`.
 * @throws {@link CliError} when registration fails or returns no client id.
 */
export async function registerClient(
  fetchImpl: typeof fetch,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Trove CLI',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid profile email offline_access',
    }),
  });
  if (!res.ok) {
    throw new CliError(`Client registration failed (HTTP ${res.status}).`, ExitCode.Auth);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CliError('Client registration returned a non-JSON body.', ExitCode.Transport);
  }
  if (typeof raw.client_id !== 'string' || raw.client_id.length === 0) {
    throw new CliError('Client registration returned no client_id.', ExitCode.Auth);
  }
  return raw.client_id;
}

/**
 * Build the authorization-request URL with PKCE + the loopback redirect.
 *
 * @param meta - The authorization-server metadata.
 * @param params - Client id, redirect URI, scope, state, and PKCE challenge.
 * @returns The full authorization URL.
 */
export function buildAuthorizeUrl(
  meta: AuthServerMetadata,
  params: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    challenge: string;
  },
): string {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * A token-endpoint result: the access token plus the optional `refresh_token`
 * (present when `offline_access` was granted) the CLI uses to mint new access
 * tokens without a browser round-trip once the short-lived one expires.
 */
export interface TokenSet {
  /** The bearer access token to present to the API. */
  accessToken: string;
  /**
   * The refresh token, when the authorization server issued one. Absent when the
   * server does not grant `offline_access` (the CLI then requires a fresh login
   * once the access token expires).
   */
  refreshToken?: string;
  /** The raw token-endpoint response. */
  raw: Record<string, unknown>;
}

/**
 * Decode a token-endpoint JSON response into a {@link TokenSet}, asserting the
 * required `access_token` and carrying through a `refresh_token` when present.
 */
function parseTokenResponse(raw: Record<string, unknown>): TokenSet {
  const accessToken = raw.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CliError('Token endpoint returned no access_token.', ExitCode.Auth);
  }
  const refreshToken = raw.refresh_token;
  return {
    accessToken,
    ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {}),
    raw,
  };
}

/**
 * Exchange an authorization code for tokens at the token endpoint.
 *
 * @param fetchImpl - The fetch implementation.
 * @param meta - The authorization-server metadata.
 * @param params - The code, verifier, client id, and redirect URI.
 * @returns The access token, optional refresh token, and raw token response.
 * @throws {@link CliError} when the exchange fails or returns no access token.
 */
export async function exchangeCode(
  fetchImpl: typeof fetch,
  meta: AuthServerMetadata,
  params: { code: string; verifier: string; clientId: string; redirectUri: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  });
  const res = await fetchImpl(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (res.status === 401 || res.status === 403) {
    throw new CliError(`Token exchange rejected (HTTP ${res.status}).`, ExitCode.Auth);
  }
  if (!res.ok) {
    throw new CliError(`Token exchange failed (HTTP ${res.status}).`, ExitCode.Transport);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CliError('Token endpoint returned a non-JSON body.', ExitCode.Transport);
  }
  return parseTokenResponse(raw);
}

/**
 * Redeem a refresh token for a fresh access token (RFC 6749 §6) at the token
 * endpoint — the grant the CLI runs when a stored access token has expired, so
 * commands recover silently without reopening the browser.
 *
 * The response may rotate the refresh token; callers must persist the returned
 * {@link TokenSet.refreshToken} when present (and keep the previous one when it
 * is not).
 *
 * @param fetchImpl - The fetch implementation.
 * @param tokenEndpoint - The authorization server's token endpoint.
 * @param params - The refresh token and public client id to present.
 * @returns The new access token (and any rotated refresh token).
 * @throws {@link CliError} with {@link ExitCode.Auth} when the refresh token is
 *   rejected (expired/revoked — the caller must fall back to `trove login`), or
 *   {@link ExitCode.Transport} on a network/server failure.
 */
export async function refreshAccessToken(
  fetchImpl: typeof fetch,
  tokenEndpoint: string,
  params: { refreshToken: string; clientId: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // 400 `invalid_grant` is how token endpoints report an expired/revoked
    // refresh token; treat it (and 401/403) as an auth failure so the caller
    // surfaces "run 'trove login'" rather than retrying.
    throw new CliError(`Token refresh rejected (HTTP ${res.status}).`, ExitCode.Auth);
  }
  if (!res.ok) {
    throw new CliError(`Token refresh failed (HTTP ${res.status}).`, ExitCode.Transport);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CliError('Token endpoint returned a non-JSON body.', ExitCode.Transport);
  }
  return parseTokenResponse(raw);
}

/** The loopback redirect path the callback server listens on. */
export const REDIRECT_PATH = '/callback';

/**
 * The fixed loopback port the callback server binds. Dynamic client registration
 * pins the redirect URI to an exact `host:port`, so the port must be stable
 * across logins for a cached client id to keep working.
 */
export const LOOPBACK_PORT = 9876;

/**
 * Run the full loopback authorization-code + PKCE flow end-to-end.
 *
 * @param input - What to authorize against (API URL, client id, scope).
 * @param deps - The injectable browser/server/fetch/PKCE seams.
 * @returns The acquired access token plus the resolved issuer.
 * @throws {@link CliError} on discovery, browser, or exchange failure, or on a
 *   CSRF `state` mismatch.
 */
export async function runLoginFlow(
  input: LoginFlowInput,
  deps: LoginFlowDeps,
): Promise<{
  token: string;
  refreshToken?: string;
  tokenEndpoint: string;
  issuer: string;
  clientId: string;
}> {
  const scope = input.scope ?? 'openid profile email offline_access';
  const progress = deps.onProgress ?? ((): void => {});

  progress('Discovering authorization server…');
  const meta = await discoverAuthServer(deps.fetchImpl, input.apiUrl);

  const pkce = (deps.makePkce ?? generatePkce)();
  const state = (deps.makeState ?? (() => base64url(randomBytes(16))))();

  // Bind the loopback server first so the redirect URI carries its real port.
  const loopback = await deps.startLoopback(REDIRECT_PATH);
  const redirectUri = `http://127.0.0.1:${String(loopback.port)}${REDIRECT_PATH}`;

  // Reuse a cached client id, else self-register one (RFC 7591) against the
  // exact loopback redirect — the same DCR an MCP client does on `/mcp`.
  let clientId = input.clientId;
  if (!clientId) {
    if (!meta.registration_endpoint) {
      throw new CliError(
        'Authorization server does not advertise dynamic registration; no client id available.',
        ExitCode.Auth,
      );
    }
    progress('Registering an OAuth client…');
    clientId = await registerClient(deps.fetchImpl, meta.registration_endpoint, redirectUri);
  }

  const authorizeUrl = buildAuthorizeUrl(meta, {
    clientId,
    redirectUri,
    scope,
    state,
    challenge: pkce.challenge,
  });
  // requires live browser: opens the system browser to the consent page.
  await deps.openBrowser(authorizeUrl);
  progress(`Opened the browser. If it did not open, visit:\n  ${authorizeUrl}`);

  progress('Waiting for the browser callback…');
  const { code, state: returnedState } = await loopback.code;
  if (returnedState !== state) {
    throw new CliError('OAuth state mismatch (possible CSRF); aborting.', ExitCode.Auth);
  }

  progress('Exchanging authorization code for a token…');
  const { accessToken, refreshToken } = await exchangeCode(deps.fetchImpl, meta, {
    code,
    verifier: pkce.verifier,
    clientId,
    redirectUri,
  });

  return {
    token: accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    tokenEndpoint: meta.token_endpoint,
    issuer: meta.issuer,
    clientId,
  };
}

/**
 * The production `startLoopback`: bind a `127.0.0.1` HTTP server, return its
 * port immediately, and resolve `code` when the redirect arrives with a `code`.
 *
 * Only the real (non-test) login path invokes this; tests inject their own
 * `startLoopback`. Marked `requires live` because it binds a real socket.
 *
 * @param redirectPath - The path to capture the redirect on.
 * @param timeoutMs - How long to wait before giving up (default 300s).
 * @returns The {@link LoopbackHandle} with the bound port and code promise.
 */
export function loopbackStart(
  redirectPath: string,
  timeoutMs = 300_000,
  port: number = LOOPBACK_PORT,
): Promise<LoopbackHandle> {
  // requires live loopback server
  return new Promise((resolveHandle, rejectHandle) => {
    let resolveCode: (v: { code: string; state: string }) => void = () => {};
    let rejectCode: (e: unknown) => void = () => {};
    const code = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== redirectPath) {
        res.writeHead(404).end('Not found');
        return;
      }
      const capturedCode = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><body><h2>Trove CLI</h2><p>You may close this window and return to the terminal.</p></body></html>',
        );
      server.close();
      clearTimeout(timer);
      if (capturedCode === '') {
        rejectCode(new CliError('No authorization code in the callback.', ExitCode.Auth));
      } else {
        resolveCode({ code: capturedCode, state });
      }
    });
    const timer = setTimeout(() => {
      server.close();
      rejectCode(new CliError('Timed out waiting for the browser callback.', ExitCode.Auth));
    }, timeoutMs);
    server.on('error', rejectHandle);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort =
        addr !== null && typeof addr === 'object' ? (addr as AddressInfo).port : port;
      resolveHandle({ port: boundPort, code });
    });
  });
}
