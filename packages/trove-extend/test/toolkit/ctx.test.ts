import { describe, expect, it, vi } from 'vitest';
import { defineToolkit } from '../../src/toolkit/define.js';
import { z } from '../../src/toolkit/index.js';
import type { ToolCall } from '../../src/toolkit/types.js';
import { TOOLKIT_META } from './meta.js';

/** Build a JSON Response like a callback server would. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseCall(partial: Partial<ToolCall> & { tool: string }): ToolCall {
  return {
    args: {},
    ctxToken: 'tok-123',
    callbackBase: 'https://cp.example',
    userId: 'user_abc',
    scopes: [],
    ...partial,
  };
}

describe('ctx.secret', () => {
  it('POSTs to /internal/secret with the ctxToken and name, returns the value', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 'sk-live-xyz' }));
    let captured = '';
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_args, ctx) => {
              captured = await ctx.requireSecret('ORDERS_API_TOKEN');
              return captured;
            },
          },
        ],
      },
      { fetchImpl },
    );

    const r = await server.handle(baseCall({ tool: 't' }));
    expect(r).toEqual({ ok: true, result: { text: 'sk-live-xyz' } });
    expect(captured).toBe('sk-live-xyz');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cp.example/internal/secret');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      ctxToken: 'tok-123',
      name: 'ORDERS_API_TOKEN',
    });
  });

  it('joins callbackBase without doubling a trailing slash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 'v' }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => await ctx.requireSecret('S'),
          },
        ],
      },
      { fetchImpl },
    );
    await server.handle(baseCall({ tool: 't', callbackBase: 'https://cp.example/' }));
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://cp.example/internal/secret');
  });

  it('surfaces a callback failure as an uncaught error (generic to model)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'denied' }, 403));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => await ctx.requireSecret('S'),
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't' }));
    expect(r).toMatchObject({ ok: false, code: 'TOOL_ERROR', error: 'tool failed' });
  });

  it('rejects a non-string secret value', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 123 }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => await ctx.requireSecret('S'),
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't' }));
    expect(r).toMatchObject({ ok: false, code: 'TOOL_ERROR' });
  });

  it('rejects an empty secret name without a network call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 'v' }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => await ctx.requireSecret(''),
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't' }));
    expect(r).toMatchObject({ ok: false, code: 'TOOL_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ctx.trove', () => {
  it('is undefined when no trove scope is granted', async () => {
    let troveDefined = true;
    const server = defineToolkit({
      ...TOOLKIT_META,
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            troveDefined = ctx.trove !== undefined;
            return 'ok';
          },
        },
      ],
    });
    await server.handle(baseCall({ tool: 't', scopes: [] }));
    expect(troveDefined).toBe(false);
  });

  it('search POSTs to /internal/trove and returns data', async () => {
    const results = [{ id: 'd1', title: 'T', snippet: 's', score: 0.9 }];
    const fetchImpl = vi.fn(async () => jsonResponse({ data: results }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => {
              const r = await ctx.trove?.search('orders', { limit: 5 });
              return { text: `n=${r?.length}`, structured: r };
            },
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't', scopes: ['trove:search'] }));
    expect(r).toEqual({ ok: true, result: { text: 'n=1', structured: results } });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cp.example/internal/trove');
    expect(JSON.parse(init.body as string)).toEqual({
      ctxToken: 'tok-123',
      operation: 'search',
      variables: { query: 'orders', limit: 5 },
    });
  });

  it('getDocument and ingest hit /internal/trove with the right operation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', text: 'body' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ingested: 2 } }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => {
              const doc = await ctx.trove?.getDocument('d1');
              const ing = await ctx.trove?.ingest([{ title: 'a', text: 'x' }]);
              return `${doc?.title}:${ing?.ingested}`;
            },
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't', scopes: ['trove:ingest'] }));
    expect(r).toEqual({ ok: true, result: { text: 'T:2' } });

    const get = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(get).toEqual({ ctxToken: 'tok-123', operation: 'getDocument', variables: { id: 'd1' } });
    const ingest = JSON.parse(
      (fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(ingest).toEqual({
      ctxToken: 'tok-123',
      operation: 'ingest',
      variables: { documents: [{ title: 'a', text: 'x' }] },
    });
  });

  it('search returns [] when the callback data is not an array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => {
              const r = await ctx.trove?.search('q');
              return `n=${r?.length}`;
            },
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't', scopes: ['trove:search'] }));
    expect(r).toEqual({ ok: true, result: { text: 'n=0' } });
  });
});

describe('ctx.fetch & ctx.log', () => {
  it('ctx.fetch delegates to the injected fetch (egress path)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'shipped' }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => {
              const res = await ctx.fetch('https://orders.acme.internal/v1/x', {
                headers: { authorization: 'Bearer t' },
              });
              const body = (await res.json()) as { status: string };
              return body.status;
            },
          },
        ],
      },
      { fetchImpl },
    );
    const r = await server.handle(baseCall({ tool: 't' }));
    expect(r).toEqual({ ok: true, result: { text: 'shipped' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://orders.acme.internal/v1/x');
    const headers = new Headers(init.headers);
    // The caller's header is preserved and a default User-Agent is added.
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(headers.get('user-agent')).toContain('@ontrove/extend/toolkit');
  });

  it('ctx.log does not throw and does not leak to the model result', async () => {
    const server = defineToolkit({
      ...TOOLKIT_META,
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            ctx.log('hello', { userId: ctx.userId });
            return 'ok';
          },
        },
      ],
    });
    const r = await server.handle(baseCall({ tool: 't' }));
    expect(r).toEqual({ ok: true, result: { text: 'ok' } });
  });

  it('exposes the authenticated userId to the handler', async () => {
    let seen = '';
    const server = defineToolkit({
      ...TOOLKIT_META,
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            seen = ctx.userId;
            return 'ok';
          },
        },
      ],
    });
    await server.handle(baseCall({ tool: 't', userId: 'user_zzz' }));
    expect(seen).toBe('user_zzz');
  });
});

describe('the context spine a toolkit shares with a source', () => {
  /** Build a one-tool server whose handler probes `ctx`, and run it. */
  async function probe(
    handler: (
      ctx: Parameters<Parameters<typeof defineToolkit>[0]['tools'][number]['handler']>[1],
    ) => unknown,
    call: Partial<ToolCall> = {},
  ): Promise<unknown> {
    let seen: unknown;
    const server = defineToolkit({
      ...TOOLKIT_META,
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            seen = handler(ctx);
            return 'ok';
          },
        },
      ],
    });
    await server.handle(baseCall({ tool: 't', ...call }));
    return seen;
  }

  it('offers log as callable AND levelled, so one module runs under either host', async () => {
    // `@ontrove/extend/toolkit` has always had `log(...)`; Trove's cloud adapters call
    // `log.info(...)`. Both work, which is what lets a module be written once.
    const kinds = await probe((ctx) => {
      ctx.log('bare');
      return ['info', 'warn', 'error'].map((k) => typeof (ctx.log as never)[k]);
    });
    expect(kinds).toEqual(['function', 'function', 'function']);
  });

  it('every log level is callable without throwing', async () => {
    await expect(
      probe((ctx) => {
        ctx.log.info('i');
        ctx.log.warn('w');
        ctx.log.error('e');
        return true;
      }),
    ).resolves.toBe(true);
  });

  it('supplies a clock, so a tool never reaches for a global one', async () => {
    const now = await probe((ctx) => ctx.now());
    expect(now).toBeInstanceOf(Date);
  });

  it("hands over the caller's settings, frozen", async () => {
    // Frozen because these are the user's stored values, not scratch space: a
    // tool that mutated its own settings mid-call would confuse only itself.
    const config = (await probe((ctx) => ctx.config, {
      config: { home_airports: ['YVR'] },
    })) as Record<string, unknown>;
    expect(config).toEqual({ home_airports: ['YVR'] });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('sees {} when the toolkit declares no settings', async () => {
    expect(await probe((ctx) => ctx.config)).toEqual({});
  });
});
