import { describe, expect, it, vi } from 'vitest';
import { defineSource } from '../src/define.js';
import { runSource } from '../src/runtime.js';
import type { SourceContext, SourceDocument, Watermark } from '../src/types.js';

describe('runSource — success', () => {
  it('runs sync and returns validated documents with a cursor', async () => {
    const source = defineSource({
      async sync(ctx) {
        ctx.log('hello', 1);
        return {
          documents: [
            { id: 'a', title: 'A', text: 'alpha' },
            { id: 'b', text: 'beta', audioUrl: 'https://x/audio.mp3' },
          ],
          cursor: { type: 'date', value: '2026-06-14T00:00:00Z' } satisfies Watermark,
        };
      },
    });

    const result = await runSource(source);
    expect(result.documents).toHaveLength(2);
    expect(result.cursor).toEqual({ type: 'date', value: '2026-06-14T00:00:00Z' });
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.logs).toEqual([['hello', 1]]);
  });

  it('accepts a bare array and defaults the cursor to none', async () => {
    const source = defineSource({
      async sync() {
        return [{ id: 'a', text: 'alpha' }];
      },
    });
    const result = await runSource(source);
    expect(result.documents).toHaveLength(1);
    expect(result.cursor).toEqual({ type: 'none' });
  });

  it('accepts an audio-only document (no text)', async () => {
    const source = defineSource({
      async sync() {
        return [{ id: 'ep1', audioUrl: 'https://x/ep1.mp3', author: 'Show' }];
      },
    });
    const result = await runSource(source);
    expect(result.documents[0]?.audioUrl).toBe('https://x/ep1.mp3');
  });

  it('builds a ctx with injected config, fetch, now, and a custom log sink', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const fixedNow = new Date('2026-06-14T12:00:00Z');
    const sink: unknown[][] = [];
    let seen: SourceContext<{ q: string }> | undefined;

    const source = defineSource<{ q: string }>({
      async sync(ctx) {
        seen = ctx;
        await ctx.fetch('https://example.com');
        ctx.log('logged');
        expect(ctx.now()).toEqual(fixedNow);
        return [{ id: ctx.config.q, text: 'x' }];
      },
    });

    const result = await runSource(source, {
      config: { q: 'query-1' },
      cursor: { type: 'idSet', values: ['5'], max: '5' },
      fetchImpl,
      now: () => fixedNow,
      logSink: (args) => sink.push(args),
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://example.com');
    expect(seen?.cursor).toEqual({ type: 'idSet', values: ['5'], max: '5' });
    expect(result.documents[0]?.id).toBe('query-1');
    // Custom sink captures logs; the returned logs array stays empty.
    expect(sink).toEqual([['logged']]);
    expect(result.logs).toEqual([]);
  });

  it('uses the global fetch when none is injected', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => new Response('hi'));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const source = defineSource({
        async sync(ctx) {
          await ctx.fetch('https://example.com');
          return [{ id: 'a', text: 'x' }];
        },
      });
      await runSource(source);
      expect(spy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('uses a real Date from the default clock when none is injected', async () => {
    const source = defineSource({
      async sync(ctx) {
        return [{ id: 'a', text: String(ctx.now() instanceof Date) }];
      },
    });
    const result = await runSource(source);
    expect(result.documents[0]?.text).toBe('true');
  });
});

describe('runSource — dedup', () => {
  it('drops later documents with a duplicate id, keeping the first', async () => {
    const source = defineSource({
      async sync() {
        return [
          { id: 'a', text: 'first' },
          { id: 'b', text: 'beta' },
          { id: 'a', text: 'second-should-drop' },
        ];
      },
    });
    const result = await runSource(source);
    expect(result.documents.map((d) => d.id)).toEqual(['a', 'b']);
    expect(result.documents[0]?.text).toBe('first');
    expect(result.duplicatesSkipped).toBe(1);
  });
});

describe('runSource — validation errors', () => {
  it('throws on a missing id', async () => {
    const source = defineSource({
      async sync() {
        return [{ text: 'no id' } as unknown as SourceDocument];
      },
    });
    await expect(runSource(source)).rejects.toThrow(/missing a non-empty string `id`/);
  });

  it('throws when neither text nor audioUrl is present', async () => {
    const source = defineSource({
      async sync() {
        return [{ id: 'a' } as SourceDocument];
      },
    });
    await expect(runSource(source)).rejects.toThrow(/must provide `text` or `audioUrl`/);
  });

  it('throws on an invalid contentType', async () => {
    const source = defineSource({
      async sync() {
        return [{ id: 'a', text: 'x', contentType: 'nope' } as unknown as SourceDocument];
      },
    });
    await expect(runSource(source)).rejects.toThrow(/invalid contentType/);
  });

  it('throws on a non-object document', async () => {
    const source = defineSource({
      async sync() {
        return [null as unknown as SourceDocument];
      },
    });
    await expect(runSource(source)).rejects.toThrow(/must be an object/);
  });

  it('throws when sync returns a malformed (non-array, no documents) value', async () => {
    const source = defineSource({
      async sync() {
        return { nope: true } as unknown as SourceDocument[];
      },
    });
    await expect(runSource(source)).rejects.toThrow(/array of documents/);
  });

  it('propagates an error thrown by sync itself', async () => {
    const source = defineSource({
      async sync() {
        throw new Error('feed returned 503');
      },
    });
    await expect(runSource(source)).rejects.toThrow(/feed returned 503/);
  });
});

describe('runSource — cursor passthrough', () => {
  it('passes the input cursor through to ctx and returns the new cursor', async () => {
    const input: Watermark = { type: 'date', value: '2026-06-01T00:00:00Z' };
    const source = defineSource({
      async sync(ctx) {
        expect(ctx.cursor).toEqual(input);
        return {
          documents: [{ id: 'a', text: 'x' }],
          cursor: { type: 'date', value: '2026-06-14T00:00:00Z' } as Watermark,
        };
      },
    });
    const result = await runSource(source, { cursor: input });
    expect(result.cursor).toEqual({ type: 'date', value: '2026-06-14T00:00:00Z' });
  });

  it('defaults ctx.cursor to none on the first sync', async () => {
    const source = defineSource({
      async sync(ctx) {
        expect(ctx.cursor).toEqual({ type: 'none' });
        return [{ id: 'a', text: 'x' }];
      },
    });
    await runSource(source);
  });
});
