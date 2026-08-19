import { describe, expect, it } from 'vitest';
import {
  advanceDateCursor,
  DEFAULT_ID_SET_MAX,
  dateCursor,
  idSetCursor,
  MAX_ID_SET_BYTES,
  readDateCursor,
  readIdSet,
} from '../../src/source/cursor.js';
import type { Cursor } from '../../src/types.js';

/**
 * The ISO value carried by a date cursor, or `''` when the cursor is not one.
 *
 * @param cursor - A cursor a writer returned.
 * @returns The `value` field, so a test can compare dates without re-narrowing.
 */
function dateCursorValue(cursor: Cursor | undefined): string {
  return cursor?.type === 'date' ? cursor.value : '';
}

describe('date cursor', () => {
  it('reads the typed shape', () => {
    expect(readDateCursor({ type: 'date', value: '2024-01-10T00:00:00.000Z' })).toEqual(
      new Date('2024-01-10T00:00:00.000Z'),
    );
  });

  it('round-trips what the writer produced', () => {
    const written = dateCursor('2024-01-10T00:00:00.000Z');
    const stored: unknown = JSON.parse(JSON.stringify(written));
    expect(readDateCursor(stored)).toEqual(new Date('2024-01-10T00:00:00.000Z'));
  });

  it('returns undefined for an absent, empty, or unparseable cursor', () => {
    expect(readDateCursor()).toBeUndefined();
    expect(readDateCursor({})).toBeUndefined();
    expect(readDateCursor({ type: 'date', value: 'not-a-date' })).toBeUndefined();
  });

  it('returns undefined for a stored value that is not a date cursor at all', () => {
    // A cursor is whatever was persisted, possibly by an older version of a
    // source: a bare string or a numeric `value` must start the feed over
    // rather than crash it.
    expect(readDateCursor('2024-01-10')).toBeUndefined();
    expect(readDateCursor({ type: 'date', value: 1_704_844_800_000 })).toBeUndefined();
    expect(readDateCursor({ type: 'idSet', values: ['a'] })).toBeUndefined();
  });

  it('builds the typed shape', () => {
    expect(dateCursor('2024-01-10T00:00:00.000Z')).toEqual({
      type: 'date',
      value: '2024-01-10T00:00:00.000Z',
    });
  });

  it('writes `inclusive` only when it was asked for', () => {
    // Absent and `false` are different bytes, and a reader distinguishes them.
    expect(dateCursor('2024-01-10T00:00:00.000Z', { inclusive: false })).not.toHaveProperty(
      'inclusive',
    );
    expect(dateCursor('2024-01-10T00:00:00.000Z', { inclusive: true })).toEqual({
      type: 'date',
      value: '2024-01-10T00:00:00.000Z',
      inclusive: true,
    });
  });
});

describe('idSet cursor', () => {
  it('reads the typed shape', () => {
    expect(readIdSet({ type: 'idSet', values: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('returns an empty array for an absent cursor', () => {
    expect(readIdSet()).toEqual([]);
    expect(readIdSet({})).toEqual([]);
    expect(readIdSet('idSet')).toEqual([]);
  });

  it('drops entries that are not ids', () => {
    // Handing a number back as an id would put it into a dedup key comparison
    // that only ever sees strings, so it would silently never match.
    expect(readIdSet({ type: 'idSet', values: ['a', 7, null, 'b'] })).toEqual(['a', 'b']);
    expect(readIdSet({ type: 'idSet', values: 'a,b' })).toEqual([]);
  });

  it('builds a deduped, tagged shape with the default cap', () => {
    expect(idSetCursor(['a', 'b', 'a'])).toEqual({
      type: 'idSet',
      values: ['a', 'b'],
      max: DEFAULT_ID_SET_MAX,
    });
  });

  it('bounds the set to `max`, keeping the newest entries', () => {
    const values = Array.from({ length: 12 }, (_, index) => `id-${String(index)}`);
    const result = idSetCursor(values, 10);
    expect(result.values).toHaveLength(10);
    expect(result.max).toBe(10);
    expect(result.values.at(0)).toBe('id-2'); // oldest two evicted
    expect(result.values.at(-1)).toBe('id-11'); // newest kept
  });

  it('round-trips through storage back into the reader', () => {
    const written = idSetCursor(['a', 'b']);
    const stored: unknown = JSON.parse(JSON.stringify(written));
    expect(readIdSet(stored)).toEqual(['a', 'b']);
  });
});

describe('advanceDateCursor', () => {
  const previous: Cursor = dateCursor('2026-01-01T00:00:00.000Z');

  it('advances to the max date when every sub-source succeeded', () => {
    expect(
      advanceDateCursor({ previous, maxIso: '2026-02-01T00:00:00.000Z', anyFailed: false }),
    ).toEqual({ type: 'date', value: '2026-02-01T00:00:00.000Z' });
  });

  it('holds the previous cursor when any sub-source failed', () => {
    // Advancing on the healthy sub-sources' dates would permanently skip the
    // failed sub-source's older items; the next run re-fetches the window and
    // the platform dedupes what was already stored.
    expect(
      advanceDateCursor({ previous, maxIso: '2026-02-01T00:00:00.000Z', anyFailed: true }),
    ).toBe(previous);
  });

  it('holds the previous cursor when there is nothing to advance to', () => {
    expect(advanceDateCursor({ previous, maxIso: undefined, anyFailed: false })).toBe(previous);
  });

  it('holds an absent cursor rather than inventing one', () => {
    expect(
      advanceDateCursor({ previous: undefined, maxIso: undefined, anyFailed: false }),
    ).toBeUndefined();
  });

  it('clamps a future max date to now (scheduled items)', () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const before = Date.now();
    const result = advanceDateCursor({ previous, maxIso: future, anyFailed: false });
    const advanced = new Date(dateCursorValue(result)).getTime();
    expect(advanced).toBeGreaterThanOrEqual(before - 1000);
    expect(advanced).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('passes the inclusive flag through', () => {
    const result = advanceDateCursor({
      previous,
      maxIso: '2026-02-01T00:00:00.000Z',
      anyFailed: false,
      inclusive: true,
    });
    expect(result?.type === 'date' && result.inclusive).toBe(true);
  });
});

describe('the cursor byte budget', () => {
  it('keeps the cursor under the platform limit, however many URLs it has seen', () => {
    // The entry cap counts ENTRIES (10,000) while the platform limits BYTES
    // (65,536). A blog URL runs 60–120 bytes, so the count cap alone allows a
    // cursor roughly twelve times over the limit — which a scrape source in
    // production hit, after which every run of it was refused.
    const urls = Array.from(
      { length: 5000 },
      (_, index) => `https://example.com/a-fairly-long-article-slug-${String(index)}`,
    );
    const cursor = idSetCursor(urls);
    const bytes = new TextEncoder().encode(JSON.stringify(cursor)).length;
    expect(bytes).toBeLessThan(65_536);
    expect(cursor.values.length).toBeLessThan(urls.length);
  });

  it('evicts the OLDEST, since the newest are what a scrape meets next', () => {
    // Evicting is safe — the page is re-scraped once and deduped by external
    // id — but evicting the wrong end would re-scrape the front page every run.
    const urls = Array.from(
      { length: 3000 },
      (_, index) => `https://example.com/a-fairly-long-article-slug-number-${String(index)}`,
    );
    const cursor = idSetCursor(urls);
    expect(cursor.values.at(-1)).toBe(urls.at(-1));
    expect(cursor.values).not.toContain(urls[0]);
  });

  it('leaves an ordinary blog untouched', () => {
    const urls = Array.from(
      { length: 50 },
      (_, index) => `https://example.com/post-${String(index)}`,
    );
    expect(idSetCursor(urls).values).toEqual(urls);
  });

  it('measures bytes, not characters', () => {
    // A count cap cannot see this at all: each id below is one character per
    // three bytes, so a set that looks small by length is three times its size
    // on the wire.
    const ids = Array.from({ length: 5000 }, (_, index) => `記事${String(index)}`);
    const cursor = idSetCursor(ids);
    expect(new TextEncoder().encode(JSON.stringify(cursor)).length).toBeLessThan(65_536);
  });

  it('drops a single id that cannot fit, rather than emitting a refused cursor', () => {
    const monster = 'x'.repeat(MAX_ID_SET_BYTES + 1);
    expect(idSetCursor([monster]).values).toEqual([]);
  });
});
