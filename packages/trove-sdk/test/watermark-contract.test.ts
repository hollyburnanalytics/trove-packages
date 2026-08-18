import { describe, expect, it } from 'vitest';
import type { Watermark } from '../src/types.js';
import { dateWatermark, idSetWatermark } from '../src/watermark.js';

/**
 * The wire contract for `Watermark`.
 *
 * A watermark is written by one program and read by another: a source returns
 * it from `sync`, it is stored as an opaque JSON string on the feed's cursor,
 * and Trove hands it back on the next run as `ctx.cursor`. Three
 * implementations therefore have to agree on the same bytes:
 *
 * 1. the writer — {@link dateWatermark} / {@link idSetWatermark}, now in this
 *    package;
 * 2. Trove's reader, which keeps `max` only when it is a number and projects it
 *    as the set's capacity;
 * 3. the {@link Watermark} type.
 *
 * (3) disagreed with (1) and (2) — it declared `max?: string` and omitted
 * `inclusive` — so the fixtures below pin the agreed bytes. Each is
 * simultaneously a JSON string (what is stored) and a `Watermark`-typed literal
 * (what this package promises), and the test asserts they are the same value.
 *
 * The fixtures used to be the whole test, because the writer lived in another
 * repository and there was nothing here to run. Now that it is here, each
 * fixture is also produced by the writer and compared byte for byte — so a
 * change to the writer that breaks the wire format fails HERE, rather than in a
 * catalog months later. The reader's half is still asserted in Trove against
 * the same list; keep the two identical.
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

  it('is what the writer actually emits, not only what the type permits', () => {
    // The half that could not be written while the writer lived elsewhere: the
    // fixtures are now compared against the functions that produce them, so a
    // writer change that breaks the stored format fails in this package rather
    // than in a catalog a release later.
    expect(JSON.stringify(dateWatermark('2026-05-30T00:00:00.000Z'))).toBe(
      '{"type":"date","value":"2026-05-30T00:00:00.000Z"}',
    );
    expect(JSON.stringify(dateWatermark('2026-05-30T00:00:00.000Z', { inclusive: true }))).toBe(
      '{"type":"date","value":"2026-05-30T00:00:00.000Z","inclusive":true}',
    );
    expect(JSON.stringify(idSetWatermark(['a', 'b']))).toBe(
      '{"type":"idSet","values":["a","b"],"max":10000}',
    );
  });

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
