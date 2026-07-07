import { describe, expect, it, vi } from 'vitest';
import { defineMcpServer } from '../src/define.js';
import { ToolError, z } from '../src/index.js';
import type { McpToolCall, ToolContext } from '../src/types.js';

/** A JSON Response like an upstream API would return. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseCall(tool: string): McpToolCall {
  return {
    tool,
    args: {},
    ctxToken: 't',
    callbackBase: 'https://cp.example',
    userId: 'u',
    scopes: [],
  };
}

/**
 * Run a single tool whose handler calls `ctx.fetchJson(url, opts)` and returns
 * `{ text, structured }`, against a mocked `fetchImpl`. Returns the envelope.
 */
async function runFetchJson(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  call: (ctx: ToolContext) => Promise<unknown>,
) {
  const server = defineMcpServer(
    {
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => {
            const data = await call(ctx);
            return { text: 'ok', structured: data };
          },
        },
      ],
    },
    { fetchImpl: vi.fn(fetchImpl) },
  );
  return server.handle(baseCall('t'));
}

const URL_OK = 'https://api.example.com/x';

describe('ctx.fetchJson', () => {
  it('returns parsed unknown when no schema is given', async () => {
    const r = await runFetchJson(
      async () => jsonResponse({ a: 1, b: 'two' }),
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: true, result: { structured: { a: 1, b: 'two' } } });
  });

  it('validates and returns typed data when a schema is given', async () => {
    const schema = z.object({ count: z.number(), name: z.string().default('?') });
    const r = await runFetchJson(
      async () => jsonResponse({ count: 5 }),
      (ctx) => ctx.fetchJson(URL_OK, { schema }),
    );
    // The default fills `name`, proving the schema ran.
    expect(r).toMatchObject({ ok: true, result: { structured: { count: 5, name: '?' } } });
  });

  it('maps a 404 to a non-retryable ToolError', async () => {
    const r = await runFetchJson(
      async () => jsonResponse({ error: 'nope' }, 404),
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: false, code: 'TOOL_ERROR' });
  });

  it('maps a 429 to a retryable ToolError', async () => {
    const r = await runFetchJson(
      async () => jsonResponse({}, 429),
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('maps a 500 to a retryable ToolError', async () => {
    const r = await runFetchJson(
      async () => jsonResponse({}, 503),
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('maps malformed JSON on a 200 to a retryable ToolError', async () => {
    const r = await runFetchJson(
      async () => new Response('<html>not json</html>', { status: 200 }),
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect((r as { error: string }).error).toContain('malformed JSON');
  });

  it('maps a schema mismatch to a retryable ToolError', async () => {
    const schema = z.object({ count: z.number() });
    const r = await runFetchJson(
      async () => jsonResponse({ count: 'not-a-number' }),
      (ctx) => ctx.fetchJson(URL_OK, { schema }),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect((r as { error: string }).error).toContain('did not match');
  });

  it('lets errorMap override the default mapping using the pre-read body text', async () => {
    const r = await runFetchJson(
      async () => jsonResponse({ error_message: 'bad series id' }, 400),
      (ctx) =>
        ctx.fetchJson(URL_OK, {
          errorMap: (res, body) => {
            const parsed = JSON.parse(body) as { error_message?: string };
            return new ToolError(`API: ${parsed.error_message ?? 'error'} (${res.status})`, {
              retryable: false,
            });
          },
        }),
    );
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toBe('API: bad series id (400)');
  });

  it('falls back to the default mapping when errorMap returns undefined', async () => {
    const r = await runFetchJson(
      async () => jsonResponse({}, 500),
      (ctx) => ctx.fetchJson(URL_OK, { errorMap: () => undefined }),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('treats a thrown network error as retryable', async () => {
    const r = await runFetchJson(
      async () => {
        throw new Error('ECONNRESET');
      },
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('preserves a caller-set User-Agent instead of injecting the default', async () => {
    const seen: string[] = [];
    await runFetchJson(
      async (_url, init) => {
        seen.push(new Headers(init?.headers).get('user-agent') ?? '');
        return jsonResponse({ ok: true });
      },
      (ctx) => ctx.fetchJson(URL_OK, { init: { headers: { 'User-Agent': 'MyBot/9' } } }),
    );
    expect(seen[0]).toBe('MyBot/9');
  });

  it('tolerates a response whose body read rejects (non-ok)', async () => {
    const bad = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('boom')),
    } as unknown as Response;
    const r = await runFetchJson(
      async () => bad,
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('treats an unreadable 200 body as malformed JSON', async () => {
    const bad = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error('boom')),
    } as unknown as Response;
    const r = await runFetchJson(
      async () => bad,
      (ctx) => ctx.fetchJson(URL_OK),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect((r as { error: string }).error).toContain('malformed JSON');
  });

  it('defaults Accept: application/json but lets the caller override it', async () => {
    const seen: (string | null)[] = [];
    const cap = async (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('accept'));
      return jsonResponse({ ok: true });
    };
    await runFetchJson(cap, (ctx) => ctx.fetchJson(URL_OK));
    await runFetchJson(cap, (ctx) =>
      ctx.fetchJson(URL_OK, { init: { headers: { accept: 'text/csv' } } }),
    );
    expect(seen).toEqual(['application/json', 'text/csv']);
  });

  it('handles a schema failure with no issue detail', async () => {
    const fakeSchema = { safeParse: () => ({ success: false }) } as never;
    const r = await runFetchJson(
      async () => jsonResponse({ anything: true }),
      (ctx) => ctx.fetchJson(URL_OK, { schema: fakeSchema }),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect((r as { error: string }).error).toContain('did not match the expected shape');
  });
});
