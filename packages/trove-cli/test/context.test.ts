import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, persistToken } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { captureWriter, type TempHome, tempHome } from './helpers.js';

describe('buildContext', () => {
  it('defaults configEnv/isTTY when omitted and threads profile/endpoint flags', () => {
    const writer = captureWriter();
    const ctx = buildContext({
      globals: { profile: 'dev', endpoint: 'http://localhost:8787' },
      writer,
    });
    expect(ctx.configEnv.profileFlag).toBe('dev');
    expect(ctx.configEnv.endpointFlag).toBe('http://localhost:8787');
    // With no globals.json/jsonl and (likely) no TTY in CI, format resolves.
    expect(['human', 'json']).toContain(ctx.output.format);
  });

  it('passes through an explicit isTTY and env', () => {
    const writer = captureWriter();
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: true,
      configEnv: { env: { NO_COLOR: '1' } },
    });
    expect(ctx.output.format).toBe('json');
  });

  it('client() throws an auth error when no token is resolvable', () => {
    const writer = captureWriter();
    const ctx = buildContext({
      globals: {},
      writer,
      configEnv: { home: '/nonexistent-home-xyz', env: {} },
    });
    expect(() => ctx.client()).toThrow();
  });
});

describe('client() silent token refresh', () => {
  let home: TempHome;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('renews an expired access token mid-request and persists the rotated tokens', async () => {
    // A file-backed profile whose access token has expired but which carries the
    // refresh material a silent renewal needs.
    persistToken(
      loadConfig({ home: home.home }),
      'prod',
      'stale-access',
      {
        apiUrl: 'https://api.test',
        issuer: 'i',
        clientId: 'cli',
        refreshToken: 'rt1',
        tokenEndpoint: 'https://as/token',
      },
      { home: home.home, keychain: { platform: 'win32' } },
    );

    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/token')) {
        // The refresh grant mints a new access token and rotates the refresh one.
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rt2' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? '';
      if (auth === 'Bearer stale-access') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ data: { stats: { totalDocuments: 7 } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = buildContext({
      globals: {},
      writer: captureWriter(),
      fetchImpl,
      isTTY: false,
      configEnv: { home: home.home, env: {}, keychain: { platform: 'win32' } },
    });

    const data = await ctx.client().request<{ stats: { totalDocuments: number } }>({
      query: 'query CliStats { stats { totalDocuments } }',
      operationName: 'CliStats',
    });
    expect(data.stats.totalDocuments).toBe(7);

    // The refreshed access token and rotated refresh token are persisted.
    const saved = loadConfig({ home: home.home }).profiles.prod;
    expect(saved?.token).toBe('fresh-access');
    expect(saved?.refreshToken).toBe('rt2');
  });

  it('surfaces the auth error when the refresh token itself is rejected', async () => {
    persistToken(
      loadConfig({ home: home.home }),
      'prod',
      'stale-access',
      {
        apiUrl: 'https://api.test',
        issuer: 'i',
        clientId: 'cli',
        refreshToken: 'rt-expired',
        tokenEndpoint: 'https://as/token',
      },
      { home: home.home, keychain: { platform: 'win32' } },
    );

    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      // Both the API and the refresh grant reject — the refresh token is dead.
      if (url.includes('/token')) return new Response('{}', { status: 400 });
      return new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;

    const ctx = buildContext({
      globals: {},
      writer: captureWriter(),
      fetchImpl,
      isTTY: false,
      configEnv: { home: home.home, env: {}, keychain: { platform: 'win32' } },
    });

    await expect(
      ctx.client().request({ query: 'query CliStats { stats { totalDocuments } }' }),
    ).rejects.toMatchObject({ code: 4 });
  });
});
