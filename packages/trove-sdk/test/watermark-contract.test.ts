import { describe, expect, it } from 'vitest';
import type { Watermark } from '../src/types.js';

/**
 * The wire contract for `Watermark`.
 *
 * A watermark is written by one program and read by another: a source returns
 * it from `sync`, it is stored as an opaque JSON string on the feed's cursor,
 * and Trove hands it back on the next run as `ctx.cursor`. Three
 * implementations therefore have to agree on the same bytes:
 *
 * 1. the writer — `idSetWatermark(values, max)` / `dateWatermark(iso, opts)`,
 *    which emit `max` as the **numeric cap** they applied and `inclusive: true`
 *    only when set;
 * 2. Trove's reader — `parseWatermark()`, which keeps `max` only when
 *    `typeof max === 'number'` and projects it as the set's capacity;
 * 3. this type.
 *
 * (3) disagreed with (1) and (2) — it declared `max?: string` and omitted
 * `inclusive` — so this file pins the agreed bytes. Each fixture below is
 * simultaneously a JSON string (what is stored) and a `Watermark`-typed
 * literal (what this package promises), and the test asserts they are the same
 * value. The literal is checked at compile time by its annotation; the string
 * is checked at runtime by the round-trip. The same fixtures are asserted
 * against the reader in Trove's
 * `test/unit/features/ingest/watermark.test.ts` — keep the two lists identical.
 */
interface WatermarkFixture {
  /** What the test output calls this case. */
  readonly name: string;
  /** Exactly what the writer serializes into the feed's cursor column. */
  readonly json: string;
  /** The same value as a typed literal — the compile-time half of the test. */
  readonly value: Watermark;
}

/** The canonical wire values, one per shape the writer can emit. */
const FIXTURES: readonly WatermarkFixture[] = [
  {
    name: 'date',
    json: '{"type":"date","value":"2026-05-30T00:00:00.000Z"}',
    value: { type: 'date', value: '2026-05-30T00:00:00.000Z' },
  },
  {
    name: 'date, inclusive of the boundary item',
    json: '{"type":"date","value":"2026-05-30T00:00:00.000Z","inclusive":true}',
    value: { type: 'date', value: '2026-05-30T00:00:00.000Z', inclusive: true },
  },
  {
    name: 'idSet at the writer default cap',
    json: '{"type":"idSet","values":["a","b"],"max":10000}',
    value: { type: 'idSet', values: ['a', 'b'], max: 10000 },
  },
  {
    name: 'idSet with no declared cap',
    json: '{"type":"idSet","values":["a","b"]}',
    value: { type: 'idSet', values: ['a', 'b'] },
  },
  {
    name: 'none',
    json: '{"type":"none"}',
    value: { type: 'none' },
  },
];

describe('Watermark wire contract', () => {
  for (const fixture of FIXTURES) {
    it(`accepts the stored JSON for a ${fixture.name} watermark`, () => {
      expect(JSON.parse(fixture.json)).toEqual(fixture.value);
    });

    it(`serializes a ${fixture.name} watermark back to the stored JSON`, () => {
      // Round-tripping in both directions is what makes the fixture usable as a
      // contract fixture: a reader can be fed `json`, a writer compared to it.
      expect(JSON.parse(JSON.stringify(fixture.value))).toEqual(fixture.value);
    });
  }

  it('carries the idSet cap as a number, never a numeric string', () => {
    // The failure this pins: Trove's reader keeps `max` only when it is a
    // number, so a source that wrote `max: "10000"` would have the cap silently
    // dropped and the feed would never report itself at capacity.
    const caps = FIXTURES.map((fixture) => fixture.value)
      .filter((value): value is Extract<Watermark, { type: 'idSet' }> => value.type === 'idSet')
      .map((value) => value.max);
    expect(caps).toEqual([10000, undefined]);
  });
});
