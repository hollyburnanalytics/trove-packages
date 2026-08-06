import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineMcpServer } from '../src/define.js';
import { ToolError } from '../src/errors.js';
import { z } from '../src/index.js';
import type { McpToolCall } from '../src/types.js';

/** A minimal call template with no real callbacks exercised. */
function call(partial: Partial<McpToolCall> & { tool: string }): McpToolCall {
  return {
    args: {},
    ctxToken: 'tok',
    callbackBase: 'https://cp.example',
    userId: 'user_1',
    scopes: [],
    ...partial,
  };
}

describe('defineMcpServer — authoring validation', () => {
  it('rejects an empty tools array', () => {
    expect(() => defineMcpServer({ tools: [] })).toThrow(/non-empty array/);
  });

  it('rejects an invalid tool name', () => {
    expect(() =>
      defineMcpServer({
        tools: [
          {
            name: 'bad name!',
            description: 'd',
            input: z.object({}),
            handler: async () => ({ text: 'x' }),
          },
        ],
      }),
    ).toThrow(/invalid tool name/);
  });

  it('rejects duplicate tool names', () => {
    const t = {
      name: 'dup',
      description: 'd',
      input: z.object({}),
      handler: async () => ({ text: 'x' }),
    };
    expect(() => defineMcpServer({ tools: [t, { ...t }] })).toThrow(/duplicate tool name/);
  });

  it('rejects an empty description', () => {
    expect(() =>
      defineMcpServer({
        tools: [{ name: 'a', description: '', input: z.object({}), handler: async () => 'x' }],
      }),
    ).toThrow(/non-empty description/);
  });

  it('rejects a missing handler', () => {
    expect(() =>
      defineMcpServer({
        tools: [{ name: 'a', description: 'd', input: z.object({}), handler: undefined as any }],
      }),
    ).toThrow(/needs a handler/);
  });

  it('rejects a non-Zod input', () => {
    expect(() =>
      defineMcpServer({
        tools: [{ name: 'a', description: 'd', input: {} as any, handler: async () => 'x' }],
      }),
    ).toThrow(/needs a Zod schema/);
  });
});

describe('defineMcpServer — tools/list compilation', () => {
  it('compiles Zod input to a JSON Schema with descriptions', () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 'lookup_order',
          description: 'Look up an order.',
          alwaysOn: true,
          mutating: false,
          input: z.object({
            orderId: z.string().describe("e.g. 'ORD-10423'."),
            includeLineItems: z.boolean().optional().default(false),
          }),
          handler: async () => 'ok',
        },
      ],
    });

    expect(server.tools).toHaveLength(1);
    const entry = server.tools[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(entry.name).toBe('lookup_order');
    expect(entry.alwaysOn).toBe(true);
    expect(entry.mutating).toBe(false);
    expect(entry.inputSchema.type).toBe('object');
    const props = entry.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.orderId?.description).toBe("e.g. 'ORD-10423'.");
    expect(entry.inputSchema.required).toEqual(['orderId']);
  });

  it('surfaces a `title` when set, and omits it otherwise', () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 'with_title',
          title: 'Look Up Order',
          description: 'd',
          input: z.object({}),
          handler: async () => 'ok',
        },
        { name: 'no_title', description: 'd', input: z.object({}), handler: async () => 'ok' },
      ],
    });
    expect(server.tools[0]?.title).toBe('Look Up Order');
    expect(server.tools[1]?.title).toBeUndefined();
  });
});

describe('defineMcpServer — annotation defaulting', () => {
  function annotationsFor(
    tool: Parameters<typeof defineMcpServer>[0]['tools'][number],
    scopes?: string[],
  ) {
    const server = defineMcpServer(scopes ? { tools: [tool], scopes } : { tools: [tool] });
    const entry = server.tools[0];
    if (entry === undefined) throw new Error('missing entry');
    return entry.annotations;
  }

  it('defaults a plain reader to read-only, non-destructive, closed-world', () => {
    expect(
      annotationsFor({
        name: 'r',
        description: 'd',
        input: z.object({}),
        handler: async () => 'x',
      }),
    ).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it('defaults a `mutating` tool to NOT read-only and invents no other hints', () => {
    expect(
      annotationsFor({
        name: 'w',
        description: 'd',
        mutating: true,
        input: z.object({}),
        handler: async () => 'x',
      }),
    ).toEqual({ readOnlyHint: false });
  });

  it('treats a `trove:ingest` server scope as write intent (default not read-only)', () => {
    expect(
      annotationsFor(
        { name: 't', description: 'd', input: z.object({}), handler: async () => 'x' },
        ['trove:search', 'trove:ingest'],
      ),
    ).toEqual({ readOnlyHint: false });
  });

  it('keeps read-only default when the server only declares a read scope', () => {
    expect(
      annotationsFor(
        { name: 't', description: 'd', input: z.object({}), handler: async () => 'x' },
        ['trove:search'],
      ),
    ).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it('lets an explicit author annotation win over the derived default', () => {
    expect(
      annotationsFor({
        name: 'r',
        description: 'd',
        input: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        handler: async () => 'x',
      }),
    ).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it('honors an explicit openWorldHint on an otherwise read-only tool', () => {
    expect(
      annotationsFor({
        name: 'r',
        description: 'd',
        input: z.object({}),
        annotations: { openWorldHint: true },
        handler: async () => 'x',
      }),
    ).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  });

  it('passes through an explicit idempotentHint without other invention', () => {
    expect(
      annotationsFor({
        name: 'w',
        description: 'd',
        mutating: true,
        input: z.object({}),
        annotations: { idempotentHint: true },
        handler: async () => 'x',
      }),
    ).toEqual({ readOnlyHint: false, idempotentHint: true });
  });
});

describe('defineMcpServer — output schema compilation', () => {
  it('compiles a Zod `output` schema to an outputSchema in tools/list', () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 'search',
          description: 'd',
          input: z.object({ q: z.string() }),
          output: z.object({
            results: z.array(z.object({ id: z.string(), score: z.number() })),
          }),
          handler: async () => ({ text: 'ok', structured: { results: [] } }),
        },
      ],
    });
    const entry = server.tools[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(entry.outputSchema?.type).toBe('object');
    const props = entry.outputSchema?.properties as Record<string, { type?: string }>;
    expect(props.results?.type).toBe('array');
    expect(entry.outputSchema?.required).toEqual(['results']);
  });

  it('omits outputSchema when no `output` is declared', () => {
    const server = defineMcpServer({
      tools: [{ name: 'x', description: 'd', input: z.object({}), handler: async () => 'ok' }],
    });
    expect(server.tools[0]?.outputSchema).toBeUndefined();
  });

  it('rejects a non-Zod `output`', () => {
    expect(() =>
      defineMcpServer({
        tools: [
          {
            name: 'x',
            description: 'd',
            input: z.object({}),
            output: {} as never,
            handler: async () => 'ok',
          },
        ],
      }),
    ).toThrow(/`output` must be a Zod schema/);
  });
});

describe('defineMcpServer — dispatch & validation', () => {
  it('returns UNKNOWN_TOOL for an unregistered tool', async () => {
    const server = defineMcpServer({
      tools: [{ name: 'a', description: 'd', input: z.object({}), handler: async () => 'x' }],
    });
    const r = await server.handle(call({ tool: 'nope' }));
    expect(r).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
  });

  it('returns BAD_REQUEST for a malformed call', async () => {
    const server = defineMcpServer({
      tools: [{ name: 'a', description: 'd', input: z.object({}), handler: async () => 'x' }],
    });
    const r = await server.handle({} as any);
    expect(r).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('rejects bad arguments BEFORE the handler runs', async () => {
    const handler = vi.fn(async () => ({ text: 'ok' }));
    const server = defineMcpServer({
      tools: [
        {
          name: 'echo',
          description: 'd',
          input: z.object({ n: z.number() }),
          handler,
        },
      ],
    });
    const r = await server.handle(call({ tool: 'echo', args: { n: 'not-a-number' } }));
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toMatch(/n:/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes validated/defaulted args to the handler and wraps a string result', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 'echo',
          description: 'd',
          input: z.object({ n: z.number(), flag: z.boolean().default(true) }),
          handler: async ({ n, flag }) => `n=${n} flag=${flag}`,
        },
      ],
    });
    const r = await server.handle(call({ tool: 'echo', args: { n: 7 } }));
    expect(r).toEqual({ ok: true, result: { text: 'n=7 flag=true' } });
  });

  it('wraps a structured object result', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async () => ({ text: 'hi', structured: { a: 1 } }),
        },
      ],
    });
    const r = await server.handle(call({ tool: 't' }));
    expect(r).toEqual({ ok: true, result: { text: 'hi', structured: { a: 1 } } });
  });

  it('errors when the handler returns an invalid result shape', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async () => 42 as any,
        },
      ],
    });
    const r = await server.handle(call({ tool: 't' }));
    expect(r).toMatchObject({ ok: false, code: 'TOOL_ERROR' });
  });
});

describe('defineMcpServer — error envelopes', () => {
  it('turns a ToolError into a clean error result with its retryable hint', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async () => {
            throw new ToolError('upstream down', { retryable: true });
          },
        },
      ],
    });
    const r = await server.handle(call({ tool: 't' }));
    expect(r).toEqual({
      ok: false,
      error: 'upstream down',
      retryable: true,
      code: 'TOOL_ERROR',
    });
  });

  it('turns an uncaught throw into a generic error (no stack to model)', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async () => {
            throw new Error('internal detail with secret stack');
          },
        },
      ],
    });
    const r = await server.handle(call({ tool: 't' }));
    expect(r).toEqual({ ok: false, error: 'tool failed', retryable: false, code: 'TOOL_ERROR' });
  });

  it('ToolError defaults retryable to false', () => {
    const e = new ToolError('nope');
    expect(e.retryable).toBe(false);
    expect(e.name).toBe('ToolError');
    expect(e).toBeInstanceOf(ToolError);
    expect(e).toBeInstanceOf(Error);
  });

  it('ToolError carries optional data', () => {
    const e = new ToolError('x', { data: { k: 1 } });
    expect(e.data).toEqual({ k: 1 });
  });
});

describe('defineMcpServer — default fetch wiring', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('uses globalThis.fetch when no fetchImpl is injected (ctx.fetch egress)', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;

    const server = defineMcpServer({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            await ctx.fetch('https://orders.acme.internal/ping');
            return 'ok';
          },
        },
      ],
    });
    const r = await server.handle(call({ tool: 't' }));
    expect(r).toEqual({ ok: true, result: { text: 'ok' } });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://orders.acme.internal/ping');
    expect(new Headers(init.headers).get('user-agent')).toContain('@ontrove/mcp');
  });
});

/**
 * A declared `output` schema used to be inert: validated as a schema at compile
 * time, then never applied. `structuredContent` reached the host unchecked, so a
 * tool could contradict its own advertised output and nothing noticed. Input had
 * always been parsed; the asymmetry was never deliberate.
 */
describe('defineMcpServer — declared output schemas are enforced', () => {
  /** A server whose one tool returns whatever `structured` it is handed. */
  const serverReturning = (structured: unknown) =>
    defineMcpServer({
      tools: [
        {
          name: 'report',
          description: 'Returns a report.',
          input: z.object({}),
          output: z.object({ count: z.number(), label: z.string() }),
          handler: async () => ({ text: 'ok', structured }),
        },
      ],
    });

  it('passes structured output that matches the schema', async () => {
    const result = await serverReturning({ count: 2, label: 'ok' }).handle(
      call({ tool: 'report' }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.structuredContent).toEqual({ count: 2, label: 'ok' });
  });

  it('refuses structured output that contradicts the schema', async () => {
    const result = await serverReturning({ count: 'two', label: 'ok' }).handle(
      call({ tool: 'report' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/"report" returned structured output/);
      expect(result.error).toMatch(/count/);
      // The handler and its schema disagree; calling again produces the same
      // disagreement, so there is nothing for a retry to fix.
      expect(result.retryable).toBe(false);
    }
  });

  it('names a missing field rather than failing anonymously', async () => {
    const result = await serverReturning({ count: 2 }).handle(call({ tool: 'report' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/label/);
  });

  it('surfaces the PARSED value, so declared coercions actually apply', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 'counted',
          description: 'Counts.',
          input: z.object({}),
          output: z.object({ count: z.coerce.number() }),
          handler: async () => ({ text: 'ok', structured: { count: '7' } }),
        },
      ],
    });
    const result = await server.handle(call({ tool: 'counted' }));
    expect(result.ok && result.structuredContent).toEqual({ count: 7 });
  });

  it('leaves a tool that declares no output schema alone', async () => {
    const server = defineMcpServer({
      tools: [
        {
          name: 'free',
          description: 'No declared output.',
          input: z.object({}),
          handler: async () => ({ text: 'ok', structured: { anything: true } }),
        },
      ],
    });
    const result = await server.handle(call({ tool: 'free' }));
    expect(result.ok).toBe(true);
    // Nothing was declared, so there is nothing to check it against — and it is
    // not promoted to `structuredContent` either.
    expect(result.ok && result.structuredContent).toBeUndefined();
  });
});
