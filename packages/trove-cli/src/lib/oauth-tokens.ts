import { CliError, ExitCode } from '../errors.js';
import type { AuthServerMetadata } from './oauth-discovery.js';

/**
 * Token-endpoint grants for the `trove login` flow: the authorization-code +
 * PKCE exchange, and the silent refresh-token grant used once a stored access
 * token expires. Discovery/registration live in `oauth-discovery.ts`; the
 * interactive flow that drives both is `oauth.ts`.
 *
 * @module
 */

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
