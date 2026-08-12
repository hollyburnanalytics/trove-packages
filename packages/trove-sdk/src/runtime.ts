/**
 * The local-run harness — what makes `trove source dev` / `trove source test`
 * work (sources/sdk-reference; the cursors guide).
 *
 * {@link runSource} builds a {@link SourceContext} from a `{ config, cursor }`
 * spec, invokes `sync(ctx)`, then normalizes and validates the result: it accepts
 * either a `SourceSyncResult` or a bare `SourceDocument[]`, deduplicates by
 * `id` (first occurrence wins, matching server-side `(feed, id)` dedup), and
 * validates every document's required fields, surfacing problems clearly instead
 * of pushing a malformed payload to the cloud.
 *
 * It is the symmetric sibling of `@ontrove/mcp`'s `dispatch`/`toFetchHandler`: that
 * runs a tool call end-to-end without the hosted runtime; this runs a source
 * sync end-to-end without the Mac app sync engine.
 *
 * @module
 */

import type {
  FetchLike,
  LogChannel,
  SourceContext,
  SourceDocument,
  SourceSyncResult,
  TroveSource,
  Watermark,
} from './types.js';

/** Allowed `contentType` values (matches the GraphQL `ContentType` enum). */
const CONTENT_TYPES: readonly string[] = ['text', 'transcript', 'highlight', 'bookmark'];

/**
 * The options {@link runSource} builds a `ctx` from. The CLI passes the
 * source's stored config and the feed's current cursor; tests inject `fetch`,
 * `log`, and `now` for determinism.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 */
export interface RunOptions<C = Record<string, unknown>> {
  /** The source's preference values (no credentials). Defaults to `{}`. */
  config?: C;
  /** The feed's current watermark. Defaults to `{ type: 'none' }`. */
  cursor?: Watermark;
  /** The fetch implementation to expose as `ctx.fetch`. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** A sink for `ctx.log(...)` calls. Defaults to collecting into the returned `logs`. */
  logSink?: (args: unknown[]) => void;
  /** The clock backing `ctx.now()`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Credentials to hand the source, keyed by the names its manifest declares.
   *
   * Absent in an ordinary local run, which is why `ctx.secret` rejects by name
   * rather than returning undefined: a source that needs a key cannot proceed
   * without one, and the name is what tells the developer which to supply.
   */
  secrets?: Readonly<Record<string, string>>;
  /** When this run must finish, epoch ms. Omitted means no budget. */
  deadline?: number;
  /** Receives `ctx.progress(...)`. Omitted means the calls are dropped. */
  onProgress?: (done: number, message?: string) => void;
}

/**
 * The outcome of {@link runSource}: the validated, deduped documents, the
 * resolved cursor, and the captured log lines. Mirrors enough of what the cloud
 * ingest reports for `trove source test` to print a useful summary.
 */
export interface RunResult {
  /** The validated, deduped documents `sync` returned. */
  documents: SourceDocument[];
  /** The cursor `sync` returned, or `{ type: 'none' }` if it returned none. */
  cursor: Watermark;
  /** Captured `ctx.log(...)` lines (when no custom `logSink` was supplied). */
  logs: unknown[][];
  /** Count of documents dropped as duplicates of an earlier `id`. */
  duplicatesSkipped: number;
}

/**
 * Validate one document's required fields, throwing a clear, indexed error on the
 * first problem. Mirrors the wire contract: `id` is required (→ `externalId`),
 * and at least one of `text`/`audioUrl` must be present.
 *
 * @param doc - The document to validate.
 * @param index - Its position in the returned array, for the message.
 * @throws {Error} If a required field is missing or malformed.
 */
function validateDocument(doc: SourceDocument, index: number): void {
  const where = `document[${String(index)}]`;
  if (doc === null || typeof doc !== 'object') {
    throw new Error(`${where} must be an object`);
  }
  if (typeof doc.id !== 'string' || doc.id.length === 0) {
    throw new Error(`${where} is missing a non-empty string \`id\` (maps to externalId)`);
  }
  const hasText = typeof doc.text === 'string' && doc.text.length > 0;
  const hasAudio = typeof doc.audioUrl === 'string' && doc.audioUrl.length > 0;
  if (!hasText && !hasAudio) {
    throw new Error(
      `${where} (id "${doc.id}") must provide \`text\` or \`audioUrl\` — at least one is required`,
    );
  }
  if (doc.contentType !== undefined && !CONTENT_TYPES.includes(doc.contentType)) {
    throw new Error(
      `${where} (id "${doc.id}") has invalid contentType "${String(doc.contentType)}"; ` +
        `expected one of ${CONTENT_TYPES.join(', ')}`,
    );
  }
}

/**
 * Normalize a `sync` return value to a {@link SourceSyncResult}, accepting a
 * bare document array for convenience.
 *
 * @param value - The raw `sync` return value.
 * @returns A normalized `{ documents, cursor? }` result.
 * @throws {Error} If the value is neither an array nor a `{ documents }` object.
 */
function normalizeResult(value: SourceSyncResult | SourceDocument[]): SourceSyncResult {
  if (Array.isArray(value)) {
    return { documents: value };
  }
  if (value !== null && typeof value === 'object' && Array.isArray(value.documents)) {
    return value.cursor === undefined
      ? { documents: value.documents }
      : { documents: value.documents, cursor: value.cursor };
  }
  throw new Error('sync must return an array of documents or an object with a `documents` array');
}

/**
 * Deduplicate documents by `id`, keeping the first occurrence (matching the
 * server's `(feed, id)` dedup, which skips re-returned ids).
 *
 * @param documents - The validated documents.
 * @returns The deduped documents and the count dropped.
 */
function dedup(documents: SourceDocument[]): {
  unique: SourceDocument[];
  duplicatesSkipped: number;
} {
  const seen = new Set<string>();
  const unique: SourceDocument[] = [];
  let duplicatesSkipped = 0;
  for (const doc of documents) {
    if (seen.has(doc.id)) {
      duplicatesSkipped += 1;
      continue;
    }
    seen.add(doc.id);
    unique.push(doc);
  }
  return { unique, duplicatesSkipped };
}

/**
 * Run a source's `sync` against a built `ctx` and collect/validate the result.
 *
 * This is the harness the CLI drives for `trove source dev` / `trove source
 * test`: it builds the {@link SourceContext} from `{ config, cursor }`, runs
 * `sync(ctx)`, normalizes a bare-array return, validates every document's
 * required fields (clear, indexed errors), and dedups by `id`. Errors thrown by
 * `sync` itself propagate unchanged so the CLI can report a failed run exactly as
 * the Mac app would.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 * @param source - The source whose `sync` to run.
 * @param options - The `{ config, cursor }` spec plus test injection points.
 * @returns The validated, deduped {@link RunResult}.
 * @throws {Error} If `sync` throws, returns a malformed value, or a document fails validation.
 */
export async function runSource<C = Record<string, unknown>>(
  source: TroveSource<C>,
  options: RunOptions<C> = {},
): Promise<RunResult> {
  const logs: unknown[][] = [];
  const cursor: Watermark = options.cursor ?? { type: 'none' };
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((url: string | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init));
  const now = options.now ?? ((): Date => new Date());

  // Callable AND levelled. Sources written against this SDK call `ctx.log(...)`;
  // every adapter running in Trove's cloud calls `ctx.log.info(...)`. Building
  // both here is what lets one module run under either runtime unchanged, which
  // is the whole point of the shared context.
  const emit = (args: unknown[]): void => {
    if (options.logSink !== undefined) options.logSink(args);
    else logs.push(args);
  };
  const log = ((...args: unknown[]) => {
    emit(args);
  }) as LogChannel;
  log.info = (...args: unknown[]): void => {
    emit(args);
  };
  log.warn = (...args: unknown[]): void => {
    emit(args);
  };
  log.error = (...args: unknown[]): void => {
    emit(args);
  };

  const ctx: SourceContext<C> = {
    config: options.config ?? ({} as C),
    cursor,
    fetch: fetchImpl,
    log,
    now,
    // A local run has no vault. Rejecting by NAME beats returning undefined:
    // a source that asks for a credential it needs cannot continue, and
    // "SEATS_AERO_API_KEY is not available here" is the only message that says
    // what to do about it.
    secret: (name: string): Promise<string> =>
      options.secrets && name in options.secrets
        ? Promise.resolve(options.secrets[name] as string)
        : Promise.reject(
            new Error(
              `Secret "${name}" is not available in this run. Pass it via \`secrets\` to runSource, or set it on the source in Trove.`,
            ),
          ),
    requireSecret: (name: string): Promise<string> => ctx.secret(name),
    // No deadline locally: a developer watching their own sync is the budget.
    deadline: options.deadline ?? Number.POSITIVE_INFINITY,
    progress: options.onProgress ?? ((): void => {}),
  };

  const raw = await source.sync(ctx);
  const result = normalizeResult(raw);

  result.documents.forEach(validateDocument);
  const { unique, duplicatesSkipped } = dedup(result.documents);

  return {
    documents: unique,
    cursor: result.cursor ?? { type: 'none' },
    logs,
    duplicatesSkipped,
  };
}
