import { describe, expect, it, vi } from 'vitest';
import { defineToolkit, toToolkitManifest } from '../../src/toolkit/define.js';
import { z } from '../../src/toolkit/index.js';
import type { ToolCall } from '../../src/toolkit/types.js';
import { TOOLKIT_META } from './meta.js';

/**
 * `auth: { type: 'oauth_connection' }` — the declaration that hands the
 * refresh problem to the platform.
 *
 * The toolkit's side of this is deliberately small: declare a provider, ask
 * for a token, never see a refresh token. What these tests pin is that
 * smallness — that the handler asks for "the token" rather than a reserved
 * string it had to know, and that a missing connection reads as something a
 * person can fix rather than as an empty credential.
 */

/** Build a JSON Response like the control plane would. */
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

/**
 * A toolkit that connects to Intuit and returns whatever token it is given.
 *
 * @param fetchImpl - The stubbed control-plane fetch.
 * @returns The built server.
 */
function connectedToolkit(fetchImpl: typeof fetch): ReturnType<typeof defineToolkit> {
  return defineToolkit(
    {
      ...TOOLKIT_META,
      auth: { type: 'oauth_connection', provider: 'intuit', connectLabel: 'Connect QuickBooks' },
      tools: [
        {
          name: 't',
          description: 'd',
          input: z.object({}),
          handler: async (_args, ctx) => (await ctx.requireAccessToken?.()) ?? 'no token',
        },
      ],
    },
    { fetchImpl },
  );
}

describe('oauth connection auth', () => {
  it('redeems the reserved name for the declared provider, so no author types it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 'access-token-1' }));

    const result = await connectedToolkit(fetchImpl).handle(baseCall({ tool: 't' }));

    expect(result).toEqual({ ok: true, result: { text: 'access-token-1' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cp.example/internal/secret');
    expect(JSON.parse(init.body as string)).toEqual({
      ctxToken: 'tok-123',
      name: 'oauth:intuit',
    });
  });

  it('tells the person to connect, rather than reporting an empty credential', async () => {
    // `{value: null}` is the platform's "declared, not set". For a pasted
    // secret that means type one in; here it means visit the dashboard and
    // authorize, which is a different instruction and not retryable.
    const fetchImpl = vi.fn(async () => jsonResponse({ value: null }));

    const result = await connectedToolkit(fetchImpl).handle(baseCall({ tool: 't' }));

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not connected to intuit/i);
    expect((result as { retryable?: boolean }).retryable).not.toBe(true);
  });

  it('gives a toolkit with no connection no requireAccessToken at all', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 'x' }));
    const server = defineToolkit(
      {
        ...TOOLKIT_META,
        tools: [
          {
            name: 't',
            description: 'd',
            input: z.object({}),
            handler: async (_args, ctx) => String(ctx.requireAccessToken === undefined),
          },
        ],
      },
      { fetchImpl },
    );

    const result = await server.handle(baseCall({ tool: 't' }));
    expect(result).toEqual({ ok: true, result: { text: 'true' } });
  });

  it('carries the connection into the manifest, because the platform renders it', async () => {
    const manifest = toToolkitManifest({
      ...TOOLKIT_META,
      auth: { type: 'oauth_connection', provider: 'intuit', connectLabel: 'Connect QuickBooks' },
      tools: [],
    });

    expect(manifest.auth).toEqual({
      type: 'oauth_connection',
      provider: 'intuit',
      connectLabel: 'Connect QuickBooks',
    });
  });

  it('keeps a client-credentials block OUT of the manifest', async () => {
    // Unchanged behaviour, asserted so the connection case above cannot
    // quietly widen into "emit whatever auth is declared": that block is
    // wiring between a toolkit and its own vaulted secrets.
    const manifest = toToolkitManifest({
      ...TOOLKIT_META,
      auth: {
        type: 'oauth2_client_credentials',
        tokenUrl: 'https://id.example/token',
        clientIdSecret: 'CLIENT_ID',
        clientSecretSecret: 'CLIENT_SECRET',
        apiHost: 'api.example',
      },
      tools: [],
    });

    expect(manifest.auth).toBeUndefined();
  });

  it('refuses a connection that names no provider', () => {
    expect(() =>
      defineToolkit({
        ...TOOLKIT_META,
        auth: { type: 'oauth_connection', provider: '' },
        tools: [],
      }),
    ).toThrow(/auth\.provider/);
  });

  it('still refuses an auth type nobody implements', () => {
    expect(() =>
      defineToolkit({
        ...TOOLKIT_META,
        // @ts-expect-error — the point of the test is the runtime guard.
        auth: { type: 'oauth2_device_code' },
        tools: [],
      }),
    ).toThrow(/unsupported auth\.type/);
  });
});
