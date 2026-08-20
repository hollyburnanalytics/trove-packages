/**
 * Construction of the {@link ToolContext} capability object.
 *
 * Every member of `ctx` is a callback closed over the short-TTL `ctxToken` and
 * the Trove-provided `callbackBase`; each request runs in an isolated sandbox
 * that holds no ambient authority.
 *
 * - `ctx.secret(name)` → `POST {callbackBase}/internal/secret { ctxToken, name }`
 * - `ctx.trove.*`      → `POST {callbackBase}/internal/trove  { ctxToken, operation, variables }`
 * - `ctx.fetch(...)`   → egress through a proxy that blocks requests to
 *   private/loopback/link-local addresses (host allowlist enforced upstream)
 * - `ctx.log(...)`     → buffered structured log lines (redacted upstream)
 *
 * The wire shapes here match the Trove-provided callbacks these requests POST to.
 *
 * @module
 */

import { makeEgressFetch, makeFetchJson, makeRequireSecret } from './auth.js';
import { redactSecrets } from './redact.js';
import type {
  OAuth2ClientCredentials,
  ToolContext,
  TroveClient,
  TroveDocument,
  TroveIngestDoc,
  TroveIngestResult,
  TroveSearchOpts,
  TroveSearchResult,
} from './types.js';

/**
 * The fetch implementation the SDK uses for callbacks and egress. Injectable so
 * tests can supply a mock; defaults to the global `fetch`.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Inputs needed to build a {@link ToolContext} for one invocation.
 */
export interface CtxParams {
  /** The Clerk user id of the caller. */
  userId: string;
  /** The caller's settings for this toolkit; `{}` when it declares none. */
  config?: Readonly<Record<string, unknown>>;
  /** The short-TTL signed capability token. */
  ctxToken: string;
  /** The Trove-provided origin the callbacks POST to (no trailing slash required). */
  callbackBase: string;
  /** Whether `ctx.trove` should be present (manifest granted a `trove:*` scope). */
  troveEnabled: boolean;
  /** The fetch implementation (injectable for tests). */
  fetchImpl: FetchLike;
  /** Sink for `ctx.log(...)` lines. */
  logSink: (args: unknown[]) => void;
  /**
   * The clock handed to `ctx.now()`. Injected so a tool is deterministic under
   * test; defaults to the real one.
   */
  now?: () => Date;
  /** Optional declarative auth; when set, egress carries an auto-minted Bearer. */
  auth?: OAuth2ClientCredentials;
  /** Optional egress host allowlist (deny-by-default when non-empty). */
  egress?: readonly string[];
  /**
   * Set of resolved secret values, populated as `ctx.secret` resolves them, so
   * `ctx.log` (and uncaught handler errors) can be redacted against them.
   */
  knownSecrets: Set<string>;
}

/** A Trove GraphQL-ish operation name the `/internal/trove` callback accepts. */
type TroveOperation = 'search' | 'getDocument' | 'ingest';

/**
 * Join a base origin and a path without doubling or dropping the slash.
 *
 * @param base - The base origin, with or without a trailing slash.
 * @param path - The path, beginning with `/`.
 * @returns The joined URL string.
 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Parse a callback JSON response, raising a uniform error on non-2xx.
 *
 * @param res - The fetch response.
 * @param label - A short label for the callback, used in error messages.
 * @returns The parsed JSON body.
 * @throws {Error} If the response is not OK or the body is not JSON.
 */
async function readCallback(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    throw new Error(
      `${label} callback failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
    );
  }
  return (await res.json()) as unknown;
}

/**
 * Build the secret-resolution callback.
 *
 * @param p - The context parameters.
 * @returns An async `secret(name)` function.
 */
function makeSecret(p: CtxParams): ToolContext['secret'] {
  return async (name: string): Promise<string> => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('ctx.secret(name): name must be a non-empty string');
    }
    const res = await p.fetchImpl(joinUrl(p.callbackBase, '/internal/secret'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ctxToken: p.ctxToken, name }),
    });
    const body = (await readCallback(res, 'ctx.secret')) as { value?: unknown };
    if (typeof body.value !== 'string') {
      throw new Error(`ctx.secret("${name}"): no value returned`);
    }
    // Remember the resolved value so log output can be redacted against it.
    if (body.value.length > 0) p.knownSecrets.add(body.value);
    return body.value;
  };
}

/**
 * POST one Trove operation to the `/internal/trove` callback and return `data`.
 *
 * @param p - The context parameters.
 * @param operation - The operation name.
 * @param variables - The operation variables.
 * @returns The `data` field of the callback response.
 */
async function callTrove(
  p: CtxParams,
  operation: TroveOperation,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await p.fetchImpl(joinUrl(p.callbackBase, '/internal/trove'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ctxToken: p.ctxToken, operation, variables }),
  });
  const body = (await readCallback(res, 'ctx.trove')) as { data?: unknown };
  return body.data;
}

/**
 * Build the scoped {@link TroveClient} backed by the `/internal/trove` callback.
 *
 * @param p - The context parameters.
 * @returns A `TroveClient` instance.
 */
function makeTroveClient(p: CtxParams): TroveClient {
  return {
    async search(query: string, opts?: TroveSearchOpts): Promise<TroveSearchResult[]> {
      const data = await callTrove(p, 'search', { query, ...(opts ?? {}) });
      return (Array.isArray(data) ? data : []) as TroveSearchResult[];
    },
    async getDocument(id: string): Promise<TroveDocument> {
      const data = await callTrove(p, 'getDocument', { id });
      return data as TroveDocument;
    },
    async ingest(docs: TroveIngestDoc[]): Promise<TroveIngestResult> {
      const data = await callTrove(p, 'ingest', { documents: docs });
      return data as TroveIngestResult;
    },
  };
}

/**
 * Build the callable-and-levelled log channel.
 *
 * Every level goes through the same redaction and the same sink; the level is
 * for the reader, not a routing decision. Sharing one path is what guarantees a
 * secret cannot escape through `warn` because only `log` was redacted.
 *
 * @param p - The context params carrying the sink and the known secrets.
 * @returns The channel placed on `ctx.log`.
 */
function makeLog(p: Pick<CtxParams, 'logSink' | 'knownSecrets'>): ToolContext['log'] {
  const emit = (args: unknown[]): void => {
    p.logSink(redactSecrets(args, p.knownSecrets) as unknown[]);
  };
  const log = ((...args: unknown[]): void => {
    emit(args);
  }) as ToolContext['log'];
  log.info = (...args: unknown[]): void => {
    emit(args);
  };
  log.warn = (...args: unknown[]): void => {
    emit(args);
  };
  log.error = (...args: unknown[]): void => {
    emit(args);
  };
  return log;
}

/**
 * Build a {@link ToolContext} for a single tool invocation.
 *
 * @param p - The per-invocation context parameters.
 * @returns The assembled capability object.
 */
export function buildCtx(p: CtxParams): ToolContext {
  const secret = makeSecret(p);
  const requireSecret = makeRequireSecret(secret);
  const fetch = makeEgressFetch(p.fetchImpl, p.auth, requireSecret, p.egress);
  const base: {
    userId: string;
    secret: ToolContext['secret'];
    requireSecret: ToolContext['requireSecret'];
    fetch: ToolContext['fetch'];
    fetchJson: ToolContext['fetchJson'];
    log: ToolContext['log'];
    now: ToolContext['now'];
    config: ToolContext['config'];
    trove?: TroveClient;
  } = {
    userId: p.userId,
    // Frozen so a tool cannot mutate its own settings and confuse itself
    // mid-call: these are the user's stored values, not scratch space.
    config: Object.freeze({ ...(p.config ?? {}) }),
    secret,
    requireSecret,
    fetch,
    fetchJson: makeFetchJson(fetch),
    log: makeLog(p),
    now: p.now ?? ((): Date => new Date()),
  };

  if (p.troveEnabled) {
    base.trove = makeTroveClient(p);
  }

  return base;
}
