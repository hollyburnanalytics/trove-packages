/**
 * Egress ergonomics for {@link ToolContext}: a default browser User-Agent, the
 * `fetchJson` batteries-included helper, `requireSecret`, and declarative
 * OAuth2 client-credentials (mint → cache → attach `Bearer`).
 *
 * These are assembled into `ctx` by `buildCtx` in {@link module:ctx}. The auth
 * mint request is issued through the raw `fetchImpl` (never the wrapped
 * `ctx.fetch`), so it can never recurse into token attachment — the same bypass
 * the `/internal/*` callbacks use.
 *
 * @module
 */

import { assertEgressAllowed } from './egress.js';
import { ToolError } from './errors.js';
import type { OAuth2ClientCredentials, ToolContext } from './types.js';

/** A standard `fetch`-shaped function (the platform egress entry point). */
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Default User-Agent: an honest, identifying string (the bare runtime UA is
 * often rejected by CDNs). An explicit caller `user-agent` always wins (see
 * {@link withDefaultUserAgent}).
 */
export const DEFAULT_USER_AGENT = '@ontrove/mcp (+https://ontrove.sh)';

/**
 * Return `init` with a default `User-Agent` added only when absent. Normalizes
 * any `HeadersInit` shape (Headers, array, record) so the presence check is
 * case-insensitive and never double-sets the header.
 *
 * @param init - The original request init (optional).
 * @returns A new init whose `headers` is a {@link Headers} carrying a UA.
 */
export function withDefaultUserAgent(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', DEFAULT_USER_AGENT);
  }
  return { ...init, headers };
}

/**
 * Wrap a raw `secret` resolver into `requireSecret`, which raises a clear,
 * non-retryable {@link ToolError} when the secret is missing or empty.
 *
 * @param secret - The raw `ctx.secret` resolver.
 * @returns A `requireSecret(name)` function.
 */
export function makeRequireSecret(secret: ToolContext['secret']): ToolContext['requireSecret'] {
  return async (name: string): Promise<string> => {
    let value: string;
    try {
      value = await secret(name);
    } catch {
      throw new ToolError(
        `${name} is not set. Run \`trove secret set <server> ${name} --from-stdin\`.`,
        {
          retryable: false,
        },
      );
    }
    if (!value) {
      throw new ToolError(
        `${name} is not set. Run \`trove secret set <server> ${name} --from-stdin\`.`,
        {
          retryable: false,
        },
      );
    }
    return value;
  };
}

/**
 * Module-scoped OAuth token cache, shared across invocations within a single server instance.
 * Keyed by the *resolved client id value* — a tenant boundary, since one server
 * single instance may serve multiple users whose secrets resolve to different ids; a
 * coarser key (e.g. server slug) would let one user's token serve another.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Mint (or reuse a cached) client-credentials access token for `auth`. */
async function ensureToken(
  fetchImpl: FetchLike,
  auth: OAuth2ClientCredentials,
  requireSecret: ToolContext['requireSecret'],
  egress: readonly string[] | undefined,
): Promise<string> {
  const clientId = await requireSecret(auth.clientIdSecret);
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const clientSecret = await requireSecret(auth.clientSecretSecret);
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) body.set('scope', auth.scope);
  // The mint call bypasses the wrapped ctx.fetch (it must never recurse into
  // token attachment), so apply the egress guard to the token endpoint here too.
  assertEgressAllowed(auth.tokenUrl, egress);
  // Direct fetchImpl (NOT the wrapped ctx.fetch).
  const res = await fetchImpl(auth.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      throw new ToolError(
        'OAuth client credentials were rejected (check the configured secrets).',
        {
          retryable: false,
        },
      );
    }
    throw new ToolError('OAuth token endpoint is temporarily unavailable.', { retryable: true });
  }
  const json = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (!json || typeof json.access_token !== 'string') {
    throw new ToolError('OAuth token endpoint returned no access_token.', { retryable: true });
  }
  const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  tokenCache.set(clientId, { token: json.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 });
  return json.access_token;
}

/** Issue an egress request with an attached `Bearer` token (mint+cache, 401-retry). */
async function fetchWithAuth(
  fetchImpl: FetchLike,
  auth: OAuth2ClientCredentials,
  requireSecret: ToolContext['requireSecret'],
  url: string | URL,
  init: RequestInit,
  egress: readonly string[] | undefined,
): Promise<Response> {
  const headers = new Headers(init.headers);
  // Respect a handler-set Authorization. Otherwise attach the Bearer ONLY to the
  // configured apiHost (required, validated in defineMcpServer) — never to any
  // other host. The 401-retry below always re-issues the original apiHost URL, and
  // the Fetch spec strips Authorization across cross-origin redirects, so the
  // token cannot ride a redirect off-domain.
  if (headers.has('authorization')) return fetchImpl(url, init);
  if (new URL(url.toString()).host !== auth.apiHost) {
    return fetchImpl(url, init);
  }

  const token = await ensureToken(fetchImpl, auth, requireSecret, egress);
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetchImpl(url, { ...init, headers });
  if (res.status !== 401 && res.status !== 403) return res;

  // Token may be stale/revoked — evict, re-mint, retry exactly once.
  tokenCache.delete(await requireSecret(auth.clientIdSecret));
  const fresh = await ensureToken(fetchImpl, auth, requireSecret, egress);
  headers.set('authorization', `Bearer ${fresh}`);
  return fetchImpl(url, { ...init, headers });
}

/**
 * Build the `ctx.fetch` egress wrapper: always adds the default UA, and (when
 * `auth` is configured) attaches a `Bearer` token.
 *
 * @param fetchImpl - The platform egress fetch.
 * @param auth - Optional declarative auth config.
 * @param requireSecret - The `requireSecret` resolver (for token minting).
 * @returns The `ctx.fetch` implementation.
 */
export function makeEgressFetch(
  fetchImpl: FetchLike,
  auth: OAuth2ClientCredentials | undefined,
  requireSecret: ToolContext['requireSecret'],
  egress?: readonly string[],
): ToolContext['fetch'] {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    // Enforce the egress guard (SSRF + optional allowlist) on every request,
    // regardless of the backing fetch implementation.
    assertEgressAllowed(url, egress);
    const withUa = withDefaultUserAgent(init);
    if (!auth) return fetchImpl(url, withUa);
    return fetchWithAuth(fetchImpl, auth, requireSecret, url, withUa, egress);
  };
}

/**
 * Build `ctx.fetchJson` over the wrapped `ctx.fetch`. Maps non-2xx to a
 * {@link ToolError}, guards malformed JSON, and validates against an optional
 * Zod schema. ToolErrors raised by the fetch path (e.g. auth) propagate as-is.
 *
 * @param doFetch - The wrapped `ctx.fetch`.
 * @returns The `ctx.fetchJson` implementation.
 */
export function makeFetchJson(doFetch: ToolContext['fetch']): ToolContext['fetchJson'] {
  return (async (
    url: string | URL,
    opts?: {
      schema?: {
        safeParse: (v: unknown) => {
          success: boolean;
          data?: unknown;
          error?: { issues: { message: string }[] };
        };
      };
      init?: RequestInit;
      errorMap?: (res: Response, body: string) => ToolError | undefined;
    },
  ): Promise<unknown> => {
    // Default `Accept: application/json` (some APIs content-negotiate strictly,
    // e.g. return 415 without it); a caller-set Accept always wins.
    const headers = new Headers(opts?.init?.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    let res: Response;
    try {
      res = await doFetch(url, { ...opts?.init, headers });
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError('Upstream request failed; try again shortly.', { retryable: true });
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const mapped = opts?.errorMap?.(res, bodyText);
      if (mapped) throw mapped;
      throw new ToolError(`Upstream returned HTTP ${res.status}.`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    const text = await res.text().catch(() => '');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ToolError('Upstream returned malformed JSON; try again shortly.', {
        retryable: true,
      });
    }
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(data);
      if (!parsed.success) {
        const detail = (parsed.error?.issues ?? [])
          .map((i) => i.message)
          .join('; ')
          .slice(0, 200);
        throw new ToolError(
          `Upstream response did not match the expected shape${detail ? `: ${detail}` : ''}.`,
          {
            retryable: true,
          },
        );
      }
      return parsed.data;
    }
    return data;
  }) as ToolContext['fetchJson'];
}
