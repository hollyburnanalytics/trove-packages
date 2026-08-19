import { describe, expect, it, vi } from 'vitest';
import { defineToolkit } from '../../src/toolkit/define.js';
import { z } from '../../src/toolkit/index.js';
import type { ToolCall, ToolContext, ToolkitConfig } from '../../src/toolkit/types.js';

const TOKEN_URL = 'https://api.acme.com/oauth/token';
const API_URL = 'https://api.acme.com/v1/thing';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseCall(tool: string): ToolCall {
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
 * A routed mock fetch: resolves `/internal/secret` from `secrets`, the token URL
 * via `token()`, everything else via `api()`. Records call counts and the
 * Authorization header seen on token/api requests.
 */
function routed(opts: {
  secrets: Record<string, string>;
  token?: (init: RequestInit) => Response;
  api?: (init: RequestInit) => Response;
}) {
  const seen = { token: 0, api: 0, tokenAuth: [] as string[], apiAuth: [] as (string | null)[] };
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const headers = new Headers(init?.headers);
    if (url.endsWith('/internal/secret')) {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const value = opts.secrets[body.name];
      return value === undefined ? new Response('no', { status: 404 }) : jsonResponse({ value });
    }
    if (url === TOKEN_URL) {
      seen.token++;
      seen.tokenAuth.push(headers.get('authorization') ?? '');
      return opts.token
        ? opts.token(init ?? {})
        : jsonResponse({ access_token: 'AT-1', expires_in: 3600 });
    }
    seen.api++;
    seen.apiAuth.push(headers.get('authorization'));
    return opts.api ? opts.api(init ?? {}) : jsonResponse({ ok: true });
  });
  return { fetchImpl, seen };
}

const AUTH: NonNullable<ToolkitConfig['auth']> = {
  type: 'oauth2_client_credentials',
  tokenUrl: TOKEN_URL,
  clientIdSecret: 'CLIENT_ID',
  clientSecretSecret: 'CLIENT_SECRET',
  apiHost: 'api.acme.com',
};

/** Build a one-tool server with the given auth + handler, on a mocked fetch. */
function server(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  handler: (ctx: ToolContext) => Promise<unknown>,
  auth = AUTH,
) {
  return defineToolkit(
    {
      auth,
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_a, ctx) => ({ text: 'ok', structured: await handler(ctx) }),
        },
      ],
    },
    { fetchImpl: vi.fn(fetchImpl) },
  );
}

describe('declarative oauth2 auth', () => {
  it('mints a token and attaches it as a Bearer to the API call', async () => {
    const { fetchImpl, seen } = routed({ secrets: { CLIENT_ID: 'id-1', CLIENT_SECRET: 'sec-1' } });
    const s = server(fetchImpl, (ctx) => ctx.fetchJson(API_URL));
    const r = await s.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: true });
    expect(seen.token).toBe(1);
    expect(seen.apiAuth).toEqual(['Bearer AT-1']);
    // The mint request used Basic client auth, never a Bearer.
    expect(seen.tokenAuth[0]).toMatch(/^Basic /);
  });

  it('reuses a cached token across calls (no second mint)', async () => {
    const { fetchImpl, seen } = routed({
      secrets: { CLIENT_ID: 'id-cache', CLIENT_SECRET: 'sec' },
    });
    const s = server(fetchImpl, (ctx) => ctx.fetch(API_URL));
    await s.handle(baseCall('t'));
    await s.handle(baseCall('t'));
    expect(seen.token).toBe(1);
    expect(seen.api).toBe(2);
  });

  it('re-mints when the cached token is near expiry', async () => {
    const { fetchImpl, seen } = routed({
      secrets: { CLIENT_ID: 'id-exp', CLIENT_SECRET: 'sec' },
      token: () => jsonResponse({ access_token: 'AT', expires_in: 10 }), // expires_in - 60 < 0 ⇒ always stale
    });
    const s = server(fetchImpl, (ctx) => ctx.fetch(API_URL));
    await s.handle(baseCall('t'));
    await s.handle(baseCall('t'));
    expect(seen.token).toBe(2);
  });

  it('evicts and re-mints once on a 401 from the API', async () => {
    let apiCalls = 0;
    const { fetchImpl, seen } = routed({
      secrets: { CLIENT_ID: 'id-401', CLIENT_SECRET: 'sec' },
      api: () => {
        apiCalls += 1;
        return apiCalls === 1
          ? jsonResponse({ error: 'expired' }, 401)
          : jsonResponse({ ok: true });
      },
    });
    const s = server(fetchImpl, (ctx) => ctx.fetchJson(API_URL));
    const r = await s.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: true });
    expect(seen.token).toBe(2); // initial mint + re-mint after 401
    expect(seen.api).toBe(2);
  });

  it('does not share a token across distinct client ids (tenant boundary)', async () => {
    // Tenant A populates the cache under client id "tenant-A".
    const a = routed({
      secrets: { CLIENT_ID: 'tenant-A', CLIENT_SECRET: 'sec' },
      token: () => jsonResponse({ access_token: 'AT-A', expires_in: 3600 }),
    });
    await server(a.fetchImpl, (ctx) => ctx.fetch(API_URL)).handle(baseCall('t'));

    // Tenant B (different resolved client id) must mint its own token, not A's.
    const b = routed({
      secrets: { CLIENT_ID: 'tenant-B', CLIENT_SECRET: 'sec' },
      token: () => jsonResponse({ access_token: 'AT-B', expires_in: 3600 }),
    });
    await server(b.fetchImpl, (ctx) => ctx.fetch(API_URL)).handle(baseCall('t'));
    expect(b.seen.token).toBe(1);
    expect(b.seen.apiAuth).toEqual(['Bearer AT-B']);
  });

  it('sends the configured scope and tolerates a token with no expires_in', async () => {
    const { fetchImpl, seen } = routed({
      secrets: { CLIENT_ID: 'id-scope', CLIENT_SECRET: 'sec' },
      token: (init) => {
        // The grant body carries the scope.
        expect(String(init.body)).toContain('scope=read+write');
        return jsonResponse({ access_token: 'AT' }); // no expires_in ⇒ default ttl
      },
    });
    const s = server(fetchImpl, (ctx) => ctx.fetch(API_URL), { ...AUTH, scope: 'read write' });
    await s.handle(baseCall('t'));
    // Default ttl (3600) means the token caches — a second call doesn't re-mint.
    await s.handle(baseCall('t'));
    expect(seen.token).toBe(1);
  });

  it('treats an unreadable token-endpoint body as a retryable error', async () => {
    const { fetchImpl } = routed({
      secrets: { CLIENT_ID: 'id-badjson', CLIENT_SECRET: 'sec' },
      token: () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('boom')),
        }) as unknown as Response,
    });
    const r = await server(fetchImpl, (ctx) => ctx.fetch(API_URL)).handle(baseCall('t'));
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('does not clobber a handler-set Authorization header', async () => {
    const { fetchImpl, seen } = routed({ secrets: { CLIENT_ID: 'id-x', CLIENT_SECRET: 'sec' } });
    const s = server(fetchImpl, (ctx) =>
      ctx.fetch(API_URL, { headers: { authorization: 'Bearer custom' } }),
    );
    await s.handle(baseCall('t'));
    expect(seen.token).toBe(0); // no mint needed
    expect(seen.apiAuth).toEqual(['Bearer custom']);
  });

  it('does not attach the Bearer to hosts other than apiHost', async () => {
    const { fetchImpl, seen } = routed({ secrets: { CLIENT_ID: 'id-h', CLIENT_SECRET: 'sec' } });
    const s = server(fetchImpl, (ctx) => ctx.fetch('https://other.example.com/x'));
    await s.handle(baseCall('t'));
    expect(seen.token).toBe(0);
    expect(seen.apiAuth).toEqual([null]);
  });

  it('surfaces a clear non-retryable error when a credential secret is unset', async () => {
    const { fetchImpl } = routed({ secrets: { CLIENT_SECRET: 'sec' } }); // CLIENT_ID missing → 404
    const s = server(fetchImpl, (ctx) => ctx.fetchJson(API_URL));
    const r = await s.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toContain('CLIENT_ID is not set');
  });

  it('maps a 401 from the token endpoint to a non-retryable error', async () => {
    const { fetchImpl } = routed({
      secrets: { CLIENT_ID: 'id-bad', CLIENT_SECRET: 'sec' },
      token: () => new Response('denied', { status: 401 }),
    });
    const s = server(fetchImpl, (ctx) => ctx.fetchJson(API_URL));
    const r = await s.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: false, retryable: false });
  });

  it('maps a token-endpoint 5xx to retryable, and a missing access_token to retryable', async () => {
    const five = routed({
      secrets: { CLIENT_ID: 'id-5', CLIENT_SECRET: 'sec' },
      token: () => new Response('x', { status: 502 }),
    });
    const r1 = await server(five.fetchImpl, (ctx) => ctx.fetch(API_URL)).handle(baseCall('t'));
    expect(r1).toMatchObject({ ok: false, retryable: true });

    const none = routed({
      secrets: { CLIENT_ID: 'id-n', CLIENT_SECRET: 'sec' },
      token: () => jsonResponse({ whoops: true }),
    });
    const r2 = await server(none.fetchImpl, (ctx) => ctx.fetch(API_URL)).handle(baseCall('t'));
    expect(r2).toMatchObject({ ok: false, retryable: true });
  });
});

describe('requireSecret', () => {
  it('returns the value when set, and a friendly non-retryable error when empty', async () => {
    const set = vi.fn(async (_input: string | URL, init?: RequestInit) =>
      jsonResponse({ value: JSON.parse(String(init?.body)).name === 'PRESENT' ? 'v' : '' }),
    );
    const ok = defineToolkit(
      {
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => ({ text: await ctx.requireSecret('PRESENT') }),
          },
        ],
      },
      { fetchImpl: set },
    );
    expect(await ok.handle(baseCall('t'))).toMatchObject({ ok: true, result: { text: 'v' } });

    const empty = defineToolkit(
      {
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => ({ text: await ctx.requireSecret('EMPTY') }),
          },
        ],
      },
      { fetchImpl: set },
    );
    const r = await empty.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toContain('EMPTY is not set');
  });
});

describe('defineToolkit auth validation', () => {
  it('throws on an unknown auth type', () => {
    expect(() =>
      defineToolkit({
        auth: { type: 'saml' } as unknown as NonNullable<ToolkitConfig['auth']>,
        tools: [{ name: 't', description: 'd', input: z.object({}), handler: async () => 'x' }],
      }),
    ).toThrow(/unsupported auth.type/);
  });

  it('throws when a required auth field is missing', () => {
    expect(() =>
      defineToolkit({
        auth: {
          type: 'oauth2_client_credentials',
          tokenUrl: '',
          clientIdSecret: 'A',
          clientSecretSecret: 'B',
          apiHost: 'api.acme.com',
        },
        tools: [{ name: 't', description: 'd', input: z.object({}), handler: async () => 'x' }],
      }),
    ).toThrow(/tokenUrl/);
  });

  it('throws when auth is set without apiHost', () => {
    expect(() =>
      defineToolkit({
        auth: {
          type: 'oauth2_client_credentials',
          tokenUrl: TOKEN_URL,
          clientIdSecret: 'A',
          clientSecretSecret: 'B',
        } as NonNullable<ToolkitConfig['auth']>,
        tools: [{ name: 't', description: 'd', input: z.object({}), handler: async () => 'x' }],
      }),
    ).toThrow(/apiHost/);
  });
});

describe('egress guard via ctx.fetch', () => {
  it('refuses ctx.fetch to a private/metadata address and never calls fetchImpl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const s = defineToolkit(
      {
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => {
              await ctx.fetch('http://169.254.169.254/latest/meta-data/');
              return 'unreachable';
            },
          },
        ],
      },
      { fetchImpl },
    );
    const r = await s.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: false, code: 'TOOL_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the config.egress allowlist (deny by default)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const s = defineToolkit(
      {
        egress: ['api.allowed.com'],
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_a, ctx) => {
              await ctx.fetch('https://evil.example.com/x');
              return 'unreachable';
            },
          },
        ],
      },
      { fetchImpl },
    );
    const r = await s.handle(baseCall('t'));
    expect(r).toMatchObject({ ok: false, code: 'TOOL_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
