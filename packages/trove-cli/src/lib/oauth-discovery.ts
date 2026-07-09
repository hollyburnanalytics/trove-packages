import { CliError, ExitCode } from '../errors.js';

/**
 * OAuth discovery + client registration for the `trove login` flow: resolve the
 * authorization server from the API's protected-resource metadata (RFC 9728 →
 * RFC 8414), self-register a public PKCE client (RFC 7591), and build the
 * authorization-request URL. The code/token exchange lives in
 * `oauth-tokens.ts`; the interactive flow that drives both is `oauth.ts`.
 *
 * @module
 */

/** OAuth protected-resource metadata (RFC 9728), the fields the CLI reads. */
interface ProtectedResourceMetadata {
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
