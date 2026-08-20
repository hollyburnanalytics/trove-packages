/**
 * Reading and writing the typed cursors a source resumes from.
 *
 * A feed's cursor is stored as an opaque JSON string and handed back to the
 * next run as `ctx.cursor`. {@link Cursor} says what that string may
 * contain; this module is the code that produces it, so the shape and the
 * bytes now live together.
 *
 * That pairing is the point. `test/cursor-contract.test.ts` names three
 * implementations that must agree on the same bytes — the writer, Trove's
 * reader, and the type — and pins the writer's output as hand-written fixtures
 * *because the writer was not in this package*. It is now, so those fixtures
 * can be asserted against the functions below rather than transcribed from
 * them.
 *
 * Three resume strategies exist: `date` (the feed is time-ordered and supports
 * "since &lt;date&gt;" filtering), `idSet` (no reliable date filter, so resuming
 * means remembering which ids were already seen), and `none` (re-fetch
 * everything and rely on `(feed, id)` dedup). The readers take `unknown`
 * because a stored cursor is whatever was persisted — possibly by an older
 * version of a source — and narrow rather than trust it.
 *
 * @module
 */

import type { Cursor } from '../types.js';

/**
 * Default cap on how many entries an `idSet` cursor retains.
 *
 * Keeps the cursor finite so a long-lived scrape cannot grow it without bound.
 * Evicting an old id at worst re-scrapes that page once, and the platform
 * dedupes the result by external id — which is why dropping entries is safe.
 */
export const DEFAULT_ID_SET_MAX = 10_000;

/**
 * Cap on the SERIALIZED size of an `idSet` cursor.
 *
 * This is the real bound, and the one the platform enforces: a cursor must fit
 * in 65,536 bytes. {@link DEFAULT_ID_SET_MAX} counts ENTRIES, and a blog URL
 * runs 60–120 bytes, so ten thousand of them is roughly 800 KB — twelve times
 * over a limit a count can never see. A scrape source in production reached it
 * after a few hundred posts, and every run afterwards was refused, so the
 * source could not advance past the point where it broke. A count cap alone
 * cannot prevent that; only measuring the bytes can.
 *
 * Held under the limit rather than at it, because the cursor is serialized
 * inside a larger envelope.
 */
export const MAX_ID_SET_BYTES = 56 * 1024;

/** Reused across entries: one encoder measures a whole id set. */
const ENCODER = new TextEncoder();

/**
 * Narrow an arbitrary stored value to something with readable properties.
 *
 * @param cursor - Whatever was persisted as the feed's cursor.
 * @returns The value as a property bag, or `undefined` when it is not an object.
 */
function asRecord(cursor: unknown): Record<string, unknown> | undefined {
  return typeof cursor === 'object' && cursor !== null
    ? (cursor as Record<string, unknown>)
    : undefined;
}

/**
 * Read a `date` cursor as a `Date`.
 *
 * Returns `undefined` rather than throwing for an absent, differently-typed, or
 * unparseable cursor: a source meeting one of those is on its first run or is
 * reading something an older version wrote, and should simply start from the
 * beginning.
 *
 * @param cursor - The source's previous cursor (`ctx.cursor`).
 * @returns The cursor date, or `undefined` when there is not a usable one.
 */
export function readDateCursor(cursor?: unknown): Date | undefined {
  const stored = asRecord(cursor);
  const iso =
    stored?.type === 'date' && typeof stored.value === 'string' ? stored.value : undefined;
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Build a typed `date` cursor from an ISO-8601 string.
 *
 * @param valueIso - The boundary date this run reached.
 * @param options - Set `inclusive` when the boundary item itself must be
 *   re-emitted next run (a `>=` comparison) rather than skipped (the default
 *   strict `>`). Feeds whose timestamps have second granularity need it, or
 *   items sharing the boundary second are lost.
 * @returns The cursor to return from `sync`. `inclusive` is omitted rather
 *   than written as `false`, because the stored bytes are a contract and a
 *   reader distinguishes absent from present.
 */
export function dateCursor(
  valueIso: string,
  { inclusive = false }: { inclusive?: boolean } = {},
): Extract<Cursor, { type: 'date' }> {
  return inclusive
    ? { type: 'date', value: valueIso, inclusive: true }
    : { type: 'date', value: valueIso };
}

/**
 * The date cursor to return from a run whose sub-sources (feeds, sections,
 * tickers, channels, meeting types) may have individually failed.
 *
 * Two safety rules, both protecting the invariant that a date cursor never
 * moves past unfetched work:
 *
 * 1. **Hold on failure.** When any sub-source failed, return the previous
 *    cursor unchanged. Advancing on the healthy sub-sources' max date would
 *    permanently skip the failed sub-source's items older than that date —
 *    per-sub-source try/catch "resilience" silently trading availability for
 *    data loss. Held back, the next run re-fetches the window and the
 *    platform's `(feed, id)` dedup absorbs the re-emitted documents.
 *
 * 2. **Clamp to now.** A future-dated item (a scheduled meeting, a post-dated
 *    article) must not drag the cursor past the present, which would make
 *    everything published between now and that future date invisible.
 *
 * @param args - The decision's inputs.
 * @param args.previous - The incoming `ctx.cursor`, returned unchanged when holding.
 * @param args.maxIso - The maximum ISO date across this run's items, if any.
 * @param args.anyFailed - Whether any sub-source failed this run.
 * @param args.inclusive - See {@link dateCursor}.
 * @returns The cursor to return from `sync` — a new cursor when it is safe
 *   to advance, otherwise exactly what was passed in.
 */
export function advanceDateCursor({
  previous,
  maxIso,
  anyFailed,
  inclusive = false,
}: {
  previous: Cursor | undefined;
  maxIso: string | undefined;
  anyFailed: boolean;
  inclusive?: boolean;
}): Cursor | undefined {
  if (anyFailed || !maxIso) return previous;
  const nowIso = new Date().toISOString();
  // Lexicographic min of two ISO-8601 strings — Math.min would coerce to NaN.
  const advanceTo = maxIso > nowIso ? nowIso : maxIso;
  return dateCursor(advanceTo, { inclusive });
}

/**
 * The newest entries that fit {@link MAX_ID_SET_BYTES}, still oldest-first.
 *
 * Measured from the newest end backwards because the newest ids are the ones
 * worth keeping: they are what a scrape meets on its next run, so evicting one
 * would re-fetch the whole front page every time, while evicting an old id at
 * worst re-ingests a document the platform already dedupes.
 *
 * @param values - The retained entries, oldest first.
 * @returns The suffix that fits within the budget.
 */
function withinByteBudget(values: readonly string[]): string[] {
  // 2 bytes for the array's own brackets, then 3 per entry for its quotes and
  // the separating comma.
  let bytes = 2;
  let kept = 0;
  for (const value of [...values].reverse()) {
    const size = ENCODER.encode(value).length + 3;
    if (bytes + size > MAX_ID_SET_BYTES) break;
    bytes += size;
    kept += 1;
  }
  return values.slice(values.length - kept);
}

/**
 * Read an `idSet` cursor as a string array.
 *
 * @param cursor - The source's previous cursor (`ctx.cursor`).
 * @returns The ids already seen (oldest first), or an empty array when the
 *   cursor is absent or is a different strategy — an empty set and a first run
 *   mean the same thing to a caller, so there is nothing to distinguish.
 *   Non-string entries are dropped rather than handed on as ids.
 */
export function readIdSet(cursor?: unknown): string[] {
  const stored = asRecord(cursor);
  if (stored?.type !== 'idSet' || !Array.isArray(stored.values)) return [];
  return stored.values.filter((value): value is string => typeof value === 'string');
}

/**
 * Build a typed `idSet` cursor: deduped, bounded to `max` entries, and then
 * bounded again to {@link MAX_ID_SET_BYTES} so the cursor the platform stores
 * cannot be refused.
 *
 * @param values - Ids or URLs seen so far, oldest first, newest last. Order is
 *   load-bearing: it is what decides which entries survive eviction.
 * @param max - Cap on retained entries (default {@link DEFAULT_ID_SET_MAX}).
 * @returns The cursor to return from `sync`, carrying the numeric cap that
 *   was applied — Trove's reader keeps `max` only when it is a number, and
 *   projects it as the set's capacity so a feed can report itself at capacity.
 */
export function idSetCursor(
  values: readonly string[],
  max: number = DEFAULT_ID_SET_MAX,
): Extract<Cursor, { type: 'idSet' }> {
  const unique = [...new Set(values)];
  const byCount = unique.length > max ? unique.slice(unique.length - max) : unique;
  return { type: 'idSet', values: withinByteBudget(byCount), max };
}
