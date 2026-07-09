import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError, ExitCode } from '../errors.js';
import { buildAuthorizeUrl, discoverAuthServer, registerClient } from './oauth-discovery.js';
import { exchangeCode } from './oauth-tokens.js';

/**
 * The interactive `trove login` flow: the CLI
 * is a public OAuth client with no secret, so it uses the **loopback
 * authorization-code + PKCE** grant (RFC 8252):
 *
 * 1. Discover the protected-resource metadata from the API
 *    (`/.well-known/oauth-protected-resource`), then the authorization-server
 *    metadata it points at (Clerk). (`oauth-discovery.ts`)
 * 2. Spin a `127.0.0.1` callback server, build the authorization URL with a PKCE
 *    `code_challenge`, and open the browser.
 * 3. Capture the `code` on the loopback redirect and exchange it (with the
 *    `code_verifier`) at the token endpoint for an access token.
 *    (`oauth-tokens.ts`)
 *
 * Every external seam — `fetch`, the browser opener, the loopback server — is
 * injectable so the whole flow is unit-tested with mocks. The genuinely
 * unrunnable parts (a real browser, a live Clerk instance) are marked at the
 * call sites.
 *
 * @module
 */

export {
  type AuthServerMetadata,
  buildAuthorizeUrl,
  discoverAuthServer,
  registerClient,
} from './oauth-discovery.js';
export { exchangeCode, refreshAccessToken } from './oauth-tokens.js';

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

/** The loopback redirect path the callback server listens on. */
const REDIRECT_PATH = '/callback';

/**
 * The fixed loopback port the callback server binds. Dynamic client registration
 * pins the redirect URI to an exact `host:port`, so the port must be stable
 * across logins for a cached client id to keep working.
 */
const LOOPBACK_PORT = 9876;

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
  const state = (deps.makeState ?? ((): string => base64url(randomBytes(16))))();

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
