import { describe, expect, it } from 'vitest';
import { defineSource, defineSync, toSourceManifest } from '../../src/source/define.js';
import type { Document, SourceManifest } from '../../src/types.js';

/** A minimal valid manifest — every field a built source must declare. */
const MANIFEST: SourceManifest = {
  id: 'example-blog',
  name: 'Example Blog',
  description: 'Posts from example.com',
  icon: '⬡',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'scrape',
  cursor: 'idSet',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'weekly',
  status: 'implemented',
  needsBrowser: false,
  egress: ['example.com'],
};

/** The manifest plus a trivial `sync` — a complete source. */
function source(overrides: Partial<SourceManifest> = {}): Parameters<typeof defineSource>[0] {
  return {
    ...MANIFEST,
    ...overrides,
    async sync() {
      return [] as Document[];
    },
  };
}

describe('defineSource — authoring validation', () => {
  it('returns the same source object unchanged (identity)', () => {
    const s = source();
    expect(defineSource(s)).toBe(s);
  });

  it('rejects a non-object', () => {
    // @ts-expect-error — deliberately wrong type for the runtime guard.
    expect(() => defineSource(null)).toThrow(/source object/);
    // @ts-expect-error — deliberately wrong type for the runtime guard.
    expect(() => defineSource(42)).toThrow(/source object/);
  });

  it('rejects a missing or non-function sync', () => {
    // @ts-expect-error — missing sync.
    expect(() => defineSource({ ...MANIFEST })).toThrow(/`sync\(ctx\)` function/);
    // @ts-expect-error — sync is not a function.
    expect(() => defineSource({ ...MANIFEST, sync: 'nope' })).toThrow(/`sync\(ctx\)` function/);
  });

  it('preserves typed config inference', async () => {
    const s = defineSource<{ feedUrl: string }>({
      ...MANIFEST,
      config: { feedUrl: { label: 'Feed URL', type: 'url' } },
      async sync(ctx) {
        return [{ id: ctx.config.feedUrl, title: 'Typed', text: 'x' }];
      },
    });
    expect(typeof s.sync).toBe('function');
  });

  // The whole point of moving the manifest into code: these used to be caught
  // by a build script in one catalog, or by nothing at all, and only after the
  // source was written. Now the module does not import.
  it('rejects a runsIn the platform does not have', () => {
    expect(() => defineSource(source({ runsIn: 'laptop' as never }))).toThrow(/runsIn/);
  });

  it('rejects a cloud source that needs a browser', () => {
    // There is no browser in a hosted runtime, so this combination cannot run
    // anywhere — it used to deploy happily and fail on the first sync.
    expect(() => defineSource(source({ needsBrowser: true }))).toThrow(/needsBrowser/);
  });

  it('rejects an unrecognised cadence rather than guessing daily', () => {
    expect(() => defineSource(source({ schedule: 'fortnightly' as never }))).toThrow(/schedule/);
  });

  it('rejects a credential smuggled into config', () => {
    expect(() =>
      defineSource(source({ config: { apiKey: { label: 'API key', type: 'text' } } })),
    ).toThrow(/config/);
  });

  it('names the source in the error, so a catalog build says which one', () => {
    expect(() => defineSource(source({ id: 'the-broken-one', runsIn: 'laptop' as never }))).toThrow(
      /the-broken-one/,
    );
  });
});

describe('toSourceManifest', () => {
  it('drops sync and marks the result generated', () => {
    const manifest = toSourceManifest(defineSource(source()));
    expect(manifest.sync).toBeUndefined();
    expect(manifest.generated).toBe(true);
    expect(manifest.id).toBe('example-blog');
    expect(manifest.egress).toEqual(['example.com']);
  });

  it('round-trips every declared manifest field', () => {
    const manifest = toSourceManifest(defineSource(source()));
    for (const [key, value] of Object.entries(MANIFEST)) {
      expect(manifest[key]).toEqual(value);
    }
  });
});

describe('defineSync — single-function convenience', () => {
  it('wraps a bare sync function into a source', () => {
    const s = defineSync(async () => [{ id: 'a', title: 'Doc a', text: 'hello' }]);
    expect(typeof s.sync).toBe('function');
  });

  it('rejects a non-function', () => {
    // @ts-expect-error — deliberately wrong type for the runtime guard.
    expect(() => defineSync('nope')).toThrow(/`sync\(ctx\)` function/);
  });
});
