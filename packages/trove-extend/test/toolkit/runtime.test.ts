import { describe, expect, it } from 'vitest';
import { defineToolkit } from '../../src/toolkit/define.js';
import { ToolError } from '../../src/toolkit/errors.js';
import { z } from '../../src/toolkit/index.js';
import { dispatch, listTools, toFetchHandler } from '../../src/toolkit/runtime.js';
import type { ToolCallResult } from '../../src/toolkit/types.js';

/**
 * A fake callback server: answers /internal/secret and /internal/trove the way
 * the control plane would, so the runtime entry can be driven end-to-end.
 */
function fakeCallbackFetch(secrets: Record<string, string>) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (url.endsWith('/internal/secret')) {
      const value = secrets[body.name as string];
      if (value === undefined) return new Response('no such secret', { status: 404 });
      return new Response(JSON.stringify({ value }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/internal/trove')) {
      return new Response(
        JSON.stringify({ data: [{ id: 'd1', title: 'X', snippet: '', score: 1 }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    // Egress path: echo a canned upstream response.
    return new Response(JSON.stringify({ ok: true, from: url }), {
      headers: { 'content-type': 'application/json' },
    });
  };
}

function buildServer(fetchImpl: ReturnType<typeof fakeCallbackFetch>) {
  return defineToolkit(
    {
      tools: [
        {
          name: 'lookup',
          description: 'Look up an order by id.',
          input: z.object({ id: z.string().describe('the order id') }),
          async handler({ id }, ctx) {
            const token = await ctx.secret('ORDERS_API_TOKEN');
            const res = await ctx.fetch(`https://orders.acme.internal/v1/${id}`, {
              headers: { authorization: `Bearer ${token}` },
            });
            const body = (await res.json()) as { from: string };
            if (id === 'missing') throw new ToolError('not found', { retryable: false });
            return { text: `order ${id} via ${body.from}`, structured: { id } };
          },
        },
      ],
    },
    { fetchImpl },
  );
}

describe('runtime — toFetchHandler', () => {
  it('GET returns the tools/list corpus', async () => {
    const server = buildServer(fakeCallbackFetch({ ORDERS_API_TOKEN: 't' }));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(new Request('https://invoke/tools', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name)).toEqual(['lookup']);
  });

  it('POST dispatches a tool call end-to-end against a fake callback server', async () => {
    const server = buildServer(fakeCallbackFetch({ ORDERS_API_TOKEN: 'secret-token' }));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke/tool', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'lookup',
          args: { id: 'ORD-1' },
          ctxToken: 'ctx-tok',
          callbackBase: 'https://cp.example',
          userId: 'user_1',
          scopes: [],
        }),
      }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body.ok).toBe(true);
    if (!body.ok) throw new Error('expected ok');
    expect(body.result.text).toContain('order ORD-1 via https://orders.acme.internal/v1/ORD-1');
    expect(body.result.structured).toEqual({ id: 'ORD-1' });
  });

  it('POST surfaces a ToolError thrown deep in the handler', async () => {
    const server = buildServer(fakeCallbackFetch({ ORDERS_API_TOKEN: 't' }));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke/tool', {
        method: 'POST',
        body: JSON.stringify({
          tool: 'lookup',
          args: { id: 'missing' },
          ctxToken: 'x',
          callbackBase: 'https://cp.example',
          userId: 'u',
        }),
      }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toMatchObject({ ok: false, error: 'not found', code: 'TOOL_ERROR' });
  });

  it('POST with invalid JSON returns BAD_REQUEST', async () => {
    const server = buildServer(fakeCallbackFetch({}));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke/tool', { method: 'POST', body: '{not json' }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('POST with a non-tool body returns BAD_REQUEST', async () => {
    const server = buildServer(fakeCallbackFetch({}));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke/tool', { method: 'POST', body: JSON.stringify({ no: 'tool' }) }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('defaults args to {} when omitted', async () => {
    const server = defineToolkit({
      tools: [
        {
          name: 'noargs',
          description: 'd',
          input: z.object({}),
          handler: async () => 'ran',
        },
      ],
    });
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke/tool', {
        method: 'POST',
        body: JSON.stringify({ tool: 'noargs', ctxToken: 'x', callbackBase: 'y', userId: 'u' }),
      }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toEqual({ ok: true, result: { text: 'ran' } });
  });

  it('rejects unsupported HTTP methods', async () => {
    const server = buildServer(fakeCallbackFetch({}));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(new Request('https://invoke', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });
});

describe('runtime — dispatch & listTools helpers', () => {
  it('dispatch runs handle() directly (the in-process test dispatcher seam)', async () => {
    const server = buildServer(fakeCallbackFetch({ ORDERS_API_TOKEN: 't' }));
    const r = await dispatch(server, {
      tool: 'lookup',
      args: { id: 'ORD-9' },
      ctxToken: 'x',
      callbackBase: 'https://cp.example',
      userId: 'u',
      scopes: [],
    });
    expect(r.ok).toBe(true);
  });

  it('listTools returns the compiled entries', () => {
    const server = buildServer(fakeCallbackFetch({}));
    expect(listTools(server)).toHaveLength(1);
  });
});

describe('runtime — structuredContent emission', () => {
  it('emits structuredContent alongside the text mirror when output is declared', async () => {
    const server = defineToolkit({
      tools: [
        {
          name: 'search',
          description: 'd',
          input: z.object({ q: z.string() }),
          output: z.object({ hits: z.number() }),
          handler: async ({ q }) => ({ text: `found for ${q}`, structured: { hits: 3 } }),
        },
      ],
    });
    const r = await dispatch(server, {
      tool: 'search',
      args: { q: 'cats' },
      ctxToken: 'x',
      callbackBase: 'https://cp.example',
      userId: 'u',
      scopes: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.result).toEqual({ text: 'found for cats', structured: { hits: 3 } });
    expect(r.structuredContent).toEqual({ hits: 3 });
  });

  it('omits structuredContent when no output schema is declared (back-compat)', async () => {
    const server = defineToolkit({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async () => ({ text: 'hi', structured: { a: 1 } }),
        },
      ],
    });
    const r = await dispatch(server, {
      tool: 't',
      args: {},
      ctxToken: 'x',
      callbackBase: 'https://cp.example',
      userId: 'u',
      scopes: [],
    });
    expect(r).toEqual({ ok: true, result: { text: 'hi', structured: { a: 1 } } });
    if (!r.ok) throw new Error('expected ok');
    expect(r.structuredContent).toBeUndefined();
  });

  it('omits structuredContent when output is declared but handler returns no structured', async () => {
    const server = defineToolkit({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          output: z.object({ a: z.number() }),
          handler: async () => 'plain text only',
        },
      ],
    });
    const r = await dispatch(server, {
      tool: 't',
      args: {},
      ctxToken: 'x',
      callbackBase: 'https://cp.example',
      userId: 'u',
      scopes: [],
    });
    expect(r).toEqual({ ok: true, result: { text: 'plain text only' } });
  });

  it('surfaces outputSchema + title + annotations over the GET tools/list wire', async () => {
    const server = defineToolkit({
      tools: [
        {
          name: 'search',
          title: 'Search',
          description: 'd',
          input: z.object({ q: z.string() }),
          output: z.object({ hits: z.number() }),
          handler: async () => ({ text: 'x', structured: { hits: 0 } }),
        },
      ],
    });
    const res = await toFetchHandler(server).fetch(
      new Request('https://invoke/tools', { method: 'GET' }),
    );
    const body = (await res.json()) as {
      tools: Array<{
        title?: string;
        outputSchema?: { type: string };
        annotations: { readOnlyHint?: boolean };
      }>;
    };
    const tool = body.tools[0];
    if (tool === undefined) throw new Error('missing tool');
    expect(tool.title).toBe('Search');
    expect(tool.outputSchema?.type).toBe('object');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});

describe('runtime — toCall defaults', () => {
  it('defaults missing ctxToken/user/callbackBase/scopes to safe empties', async () => {
    let seenUser = 'unset';
    const server = defineToolkit({
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            seenUser = ctx.userId;
            return 'ok';
          },
        },
      ],
    });
    const handler = toFetchHandler(server);
    // Only `tool` provided — everything else should default.
    const res = await handler.fetch(
      new Request('https://invoke', { method: 'POST', body: JSON.stringify({ tool: 't' }) }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toEqual({ ok: true, result: { text: 'ok' } });
    expect(seenUser).toBe('');
  });

  it('treats a JSON array body as a non-tool (BAD_REQUEST)', async () => {
    const server = buildServer(fakeCallbackFetch({}));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke', { method: 'POST', body: JSON.stringify([1, 2, 3]) }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('treats a null JSON body as a non-tool (BAD_REQUEST)', async () => {
    const server = buildServer(fakeCallbackFetch({}));
    const handler = toFetchHandler(server);
    const res = await handler.fetch(
      new Request('https://invoke', { method: 'POST', body: JSON.stringify(null) }),
    );
    const body = (await res.json()) as ToolCallResult;
    expect(body).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });
});
