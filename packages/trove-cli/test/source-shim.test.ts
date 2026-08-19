import type { Document } from '@ontrove/sdk';
import { defineSource } from '@ontrove/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createSourceWorker,
  type DeployableSource,
  handleInvoke,
  type SourceInvokeResult,
  toCursor,
  toWireDocument,
} from '../src/runtime/source-shim.js';

/**
 * The shim is what a deployed source *is* at runtime, so these tests speak the
 * invoke contract: a POST to `/sync` in, a JSON body out. They run under Node
 * because the shim is plain web-standard code — the Bun bundler that embeds it
 * is covered separately by the smoke suite.
 */

/** `createSourceWorker` installs a redirect policy over the global fetch. */
const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** POST one invoke body at a worker and read its parsed response. */
async function invoke(
  source: DeployableSource,
  body: unknown,
  path = 'https://invoke/sync',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const worker = createSourceWorker(source);
  const response = await worker.fetch(
    new Request(path, { method: 'POST', body: JSON.stringify(body) }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('toCursor', () => {
  it('reads back a watermark this shim returned', () => {
    expect(toCursor({ type: 'date', value: '2026-01-01' })).toEqual({
      type: 'date',
      value: '2026-01-01',
    });
    expect(toCursor({ type: 'idSet', values: ['a'] })).toEqual({
      type: 'idSet',
      values: ['a'],
    });
  });

  it('reads a bare string cursor as a date watermark', () => {
    expect(toCursor('2026-01-01')).toEqual({ type: 'date', value: '2026-01-01' });
  });

  it('hands back a shape this union does not name, unchanged', () => {
    // The case this function existed to break. Trove stores a cursor as opaque
    // JSON and returns exactly what the source wrote, so a source resuming from
    // a post id gets `{ sinceId }` back — and used to get `{ type: 'none' }`,
    // which reads as "first run" to every adapter. Its watermark never
    // advanced and its metered API was re-read from the top, forever, silently.
    expect(toCursor({ sinceId: '9' })).toEqual({ sinceId: '9' });
    expect(toCursor({ done: ['a'], partial: { key: 'b', next: 2 } })).toEqual({
      done: ['a'],
      partial: { key: 'b', next: 2 },
    });
  });

  it('leaves a first run absent rather than inventing a position', () => {
    // `{ type: 'none' }` is what a source RETURNS to mean "no new position". An
    // adapter on its first run tests `if (!ctx.cursor)`, so handing it an object
    // makes every first run look like a resume.
    expect(toCursor(null)).toBeUndefined();
    expect(toCursor(undefined)).toBeUndefined();
    expect(toCursor('')).toBeUndefined();
    expect(toCursor(42)).toBeUndefined();
  });
});

describe('toWireDocument', () => {
  it('snake-cases the fields the ingest door names differently', () => {
    expect(
      toWireDocument({
        id: 'e1',
        title: 'Ep 1',
        audioUrl: 'https://a.test/1.mp3',
        url: 'https://a.test/1',
        author: 'The Show',
        date: '2026-01-01T00:00:00Z',
        tags: ['pod'],
        metadata: { season: 2 },
      }),
    ).toEqual({
      id: 'e1',
      title: 'Ep 1',
      audio_url: 'https://a.test/1.mp3',
      url: 'https://a.test/1',
      author: 'The Show',
      date: '2026-01-01T00:00:00Z',
      tags: ['pod'],
      metadata: { season: 2 },
    });
  });

  it('omits absent fields rather than sending nulls', () => {
    expect(toWireDocument({ id: 'a', title: 'A', text: 'body' })).toEqual({
      id: 'a',
      title: 'A',
      text: 'body',
    });
  });

  it('refuses an untitled document, naming it', () => {
    // `title` is required by the type now, so the missing-title case has to be
    // constructed deliberately — which is the point: an author cannot reach
    // this at all without casting past the contract.
    expect(() => toWireDocument({ id: 'a', text: 'body' } as unknown as Document)).toThrow(
      /document "a" has no title/,
    );
    expect(() => toWireDocument({ id: 'b', title: '', text: 'body' })).toThrow(/has no title/);
  });
});

describe('createSourceWorker', () => {
  it('serves documents, cursor and logs for one invoke', async () => {
    const source = defineSource({
      async sync(ctx) {
        ctx.log('fetched', 1);
        expect(ctx.config).toEqual({ feedUrl: 'https://a.test' });
        expect(ctx.cursor).toEqual({ type: 'date', value: '2026-01-01' });
        return {
          documents: [{ id: 'a', title: 'A', text: 'body' }],
          cursor: { type: 'date', value: '2026-02-01' } as const,
        };
      },
    });
    const { status, json } = await invoke(source, {
      config: { feedUrl: 'https://a.test' },
      credentials: {},
      cursor: { type: 'date', value: '2026-01-01' },
      deadlineMs: 45_000,
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      documents: [{ id: 'a', title: 'A', text: 'body' }],
      cursor: { type: 'date', value: '2026-02-01' },
      logs: ['fetched 1'],
    });
  });

  it('omits the cursor when the source advanced none, so the stored one holds', async () => {
    const source = defineSource({
      async sync() {
        return [{ id: 'a', title: 'A', text: 'body' }];
      },
    });
    const { json } = await invoke(source, {});
    expect(json).not.toHaveProperty('cursor');
    expect(json.documents).toHaveLength(1);
  });

  it('dedups by id, exactly as the local dev loop does', async () => {
    const source = defineSource({
      async sync() {
        return [
          { id: 'a', title: 'A', text: 'one' },
          { id: 'a', title: 'A again', text: 'two' },
        ];
      },
    });
    const { json } = await invoke(source, {});
    expect(json.documents).toEqual([{ id: 'a', title: 'A', text: 'one' }]);
  });

  it('answers a thrown sync with a 500 carrying the logs so far', async () => {
    const source = defineSource({
      async sync(ctx) {
        ctx.log('starting');
        throw new Error('upstream is down');
      },
    });
    const { status, json } = await invoke(source, {});
    // Never `{documents: []}` — that reads to the runner as a successful empty
    // sync, and the cursor would advance past what was never fetched.
    expect(status).toBe(500);
    expect(json).toEqual({ error: 'upstream is down', logs: ['starting'] });
  });

  it('delivers a credential the runner resolved, by the name the manifest declares', async () => {
    // This used to be a refusal, and the refusal was right when it was written:
    // the spine had no credential channel. It grew `secret(name)` and this shim
    // did not follow, so a working source was being turned away with a message
    // telling its author to run it on a Mac.
    const source = defineSource({
      async sync(ctx) {
        const key = await ctx.secret('API_KEY');
        return [{ id: 'a', title: key, text: 'body' }];
      },
    });
    const { status, json } = await invoke(source, { credentials: { API_KEY: 'sk-1' } });
    expect(status).toBe(200);
    expect(json.documents).toEqual([{ id: 'a', title: 'sk-1', text: 'body' }]);
  });

  it('refuses by name a credential the source did not declare', async () => {
    // The map goes in; only `secret(name)` comes out. A source cannot enumerate
    // what it was handed, so asking for the wrong name fails loudly instead of
    // reading another source's key out of the same bag.
    const source = defineSource({
      async sync(ctx) {
        await ctx.secret('OTHER_TOKEN');
        return [];
      },
    });
    const { status, json } = await invoke(source, { credentials: { API_KEY: 'sk-1' } });
    expect(status).toBe(500);
    expect(String(json.error)).toMatch(/OTHER_TOKEN/);
  });

  it('surfaces the budget as an absolute instant, not the duration it arrived as', async () => {
    // The runner computes `deadlineMs` on its own machine. Sending an instant
    // would hand the isolate a deadline from a clock it cannot check; sending a
    // duration and adding it here keeps `ctx.deadline` the same epoch-ms shape a
    // source reads on the Mac.
    const before = Date.now();
    let seen = 0;
    const source = defineSource({
      async sync(ctx) {
        seen = ctx.deadline;
        return [];
      },
    });
    const { status } = await invoke(source, { deadlineMs: 45_000 });
    expect(status).toBe(200);
    expect(seen).toBeGreaterThanOrEqual(before + 45_000);
  });

  it('accepts a bare `sync` export, not only a defineSource result', async () => {
    // Every adapter Trove bundles today exports `sync` directly. Accepting only
    // `defineSource` would charge their authors a rewrite for the privilege of
    // being deployable, and make "can this run in the cloud" depend on the year
    // it was written.
    const { status, json } = await invoke(async () => [{ id: 'a', title: 'A', text: 'body' }], {});
    expect(status).toBe(200);
    expect(json.documents).toEqual([{ id: 'a', title: 'A', text: 'body' }]);
  });

  it('reports a non-Error throw rather than losing it', async () => {
    const source = defineSource({
      async sync() {
        throw 'plain string';
      },
    });
    const { status, json } = await invoke(source, {});
    expect(status).toBe(500);
    expect(json.error).toBe('plain string');
  });

  it('404s anything that is not POST /sync', async () => {
    const source = defineSource({
      async sync() {
        return [];
      },
    });
    const worker = createSourceWorker(source);
    const wrongPath = await worker.fetch(new Request('https://invoke/other', { method: 'POST' }));
    expect(wrongPath.status).toBe(404);
    const wrongMethod = await worker.fetch(new Request('https://invoke/sync'));
    expect(wrongMethod.status).toBe(404);
  });

  it('installs the redirect policy on the global fetch, once', () => {
    const empty = defineSource({
      async sync() {
        return [];
      },
    });
    createSourceWorker(empty);
    const installed = globalThis.fetch;
    expect(installed).not.toBe(originalFetch);
    // Once and only once: a second source in the same isolate must not wrap the
    // wrapper, which would double every hop budget.
    createSourceWorker(empty);
    expect(globalThis.fetch).toBe(installed);
  });

  it('routes ctx.fetch through the global fetch, where the policy lives', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: Request | string): Promise<Response> => {
      seen.push(typeof input === 'string' ? input : input.url);
      return new Response('body');
    }) as unknown as typeof globalThis.fetch;

    const source = defineSource({
      async sync(ctx) {
        const res = await ctx.fetch('https://a.test/feed');
        return [{ id: 'a', title: 'A', text: await res.text() }];
      },
    });
    const result: SourceInvokeResult = await handleInvoke(source, {}, []);
    expect(result.documents[0]?.text).toBe('body');
    expect(seen).toEqual(['https://a.test/feed']);
  });
});
