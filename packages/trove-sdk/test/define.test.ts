import { describe, expect, it } from 'vitest';
import { defineSource, defineSync } from '../src/define.js';
import type { Document } from '../src/types.js';

describe('defineSource — authoring validation', () => {
  it('returns the same source object unchanged (identity)', () => {
    const source = {
      async sync() {
        return [] as Document[];
      },
    };
    expect(defineSource(source)).toBe(source);
  });

  it('rejects a non-object', () => {
    // @ts-expect-error — deliberately wrong type for the runtime guard.
    expect(() => defineSource(null)).toThrow(/source object/);
    // @ts-expect-error — deliberately wrong type for the runtime guard.
    expect(() => defineSource(42)).toThrow(/source object/);
  });

  it('rejects a missing or non-function sync', () => {
    // @ts-expect-error — missing sync.
    expect(() => defineSource({})).toThrow(/`sync\(ctx\)` function/);
    // @ts-expect-error — sync is not a function.
    expect(() => defineSource({ sync: 'nope' })).toThrow(/`sync\(ctx\)` function/);
  });

  it('preserves typed config inference', async () => {
    const source = defineSource<{ feedUrl: string }>({
      async sync(ctx) {
        return [{ id: ctx.config.feedUrl, title: 'Typed', text: 'x' }];
      },
    });
    expect(typeof source.sync).toBe('function');
  });
});

describe('defineSync — single-function convenience', () => {
  it('wraps a bare sync function into a source', () => {
    const source = defineSync(async () => [{ id: 'a', title: 'Doc a', text: 'hello' }]);
    expect(typeof source.sync).toBe('function');
  });
});
