import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, persistToken } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { present } from './helpers';
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

describe('a stored refresh token, with no access token', () => {
  let home: TempHome;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  /** Write a profile that has refresh credentials but no access token. */
  function refreshOnlyProfile(): void {
    writeFileSync(
      join(home.home, '.trove', 'config.toml'),
      [
        'default_profile = "prod"',
        '',
        '[profiles.prod]',
        'api_url = "https://api.example"',
        'refresh_token = "rt-1"',
        'token_endpoint = "https://issuer.example/oauth/token"',
        'client_id = "cid"',
      ].join('\n'),
    );
  }

  it('mints a token on the first 401 instead of reporting "not logged in"', async () => {
    // The state a few minutes after `trove login`: the access token is
    // short-lived and gone, the refresh token is right there. Reporting that as
    // logged out sends someone to repeat the thing they just did — which does
    // not fix it either, because the next login leaves them in the same state.
    mkdirSync(join(home.home, '.trove'), { recursive: true });
    refreshOnlyProfile();

    let calls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls += 1;
      if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'fresh-at' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const auth = (present(init).headers as Record<string, string> | undefined)?.authorization;
      // Unauthenticated on the first pass, satisfied once refreshed — which is
      // exactly the sequence `onAuthFailure` exists to drive.
      if (auth !== 'Bearer fresh-at') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = buildContext({
      globals: {},
      writer: captureWriter(),
      fetchImpl,
      configEnv: { home: home.home, env: {} },
    });

    // The assertion that matters: building the client does not throw.
    const data = await ctx.client().request<{ ok: boolean }>({ query: '{ok}' });
    expect(data).toEqual({ ok: true });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('still refuses when there are no credentials at all', () => {
    // The genuinely logged-out case has to keep failing, and keep saying the
    // one thing that fixes it.
    mkdirSync(join(home.home, '.trove'), { recursive: true });
    writeFileSync(
      join(home.home, '.trove', 'config.toml'),
      'default_profile = "prod"\n\n[profiles.prod]\napi_url = "https://api.example"\n',
    );
    const ctx = buildContext({
      globals: {},
      writer: captureWriter(),
      configEnv: { home: home.home, env: {} },
    });
    expect(() => ctx.client()).toThrow(/Not logged in/);
  });
});
