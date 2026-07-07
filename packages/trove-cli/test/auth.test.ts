import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { login } from '../src/commands/auth.js';
import { loadConfig } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { ExitCode } from '../src/errors.js';
import { parseArgs } from '../src/lib/args.js';
import {
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
  type TempHome,
  tempHome,
} from './helpers.js';

function runCli(
  argv: string[],
  mock: MockFetch,
  writer: CaptureWriter,
  home: TempHome,
  env: NodeJS.ProcessEnv = {},
): Promise<number> {
  return run({
    argv,
    writer,
    fetchImpl: mock.fetch,
    isTTY: false,
    // Force the file-backed token path (no keychain) for deterministic assertions.
    configEnv: { home: home.home, env, keychain: { platform: 'win32' } },
  });
}

describe('auth commands', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('login --token verifies via CliStats and persists the token (chmod 600)', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 1,
          totalSources: 1,
          activeSources: 1,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    const code = await runCli(
      ['login', '--token', 'tok_new', '--email', 'm@e.com'],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliStats');
    const config = loadConfig({ home: home.home });
    expect(config.profiles.prod?.token).toBe('tok_new');
    expect(config.profiles.prod?.email).toBe('m@e.com');
  });

  it('login without a token runs the loopback OAuth flow and persists the result', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 1,
          totalSources: 1,
          activeSources: 1,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: home.home, env: {}, keychain: { platform: 'win32' } },
      isTTY: false,
    });
    const deps = {
      runFlow: async () => ({
        token: 'tok_oauth',
        refreshToken: 'refresh_oauth',
        tokenEndpoint: 'https://accounts.example.com/token',
        issuer: 'https://accounts.example.com',
        clientId: 'client_self_registered',
      }),
    };
    const code = await login(ctx, parseArgs([], { value: ['token', 'email'] }), deps);
    expect(code).toBe(ExitCode.Success);
    const saved = loadConfig({ home: home.home }).profiles.prod;
    expect(saved?.token).toBe('tok_oauth');
    // The self-registered client id is cached for reuse on the next login.
    expect(saved?.clientId).toBe('client_self_registered');
    // The refresh token + token endpoint are persisted so an expired access
    // token can be renewed without reopening the browser.
    expect(saved?.refreshToken).toBe('refresh_oauth');
    expect(saved?.tokenEndpoint).toBe('https://accounts.example.com/token');
    expect(writer.stderrText()).toMatch(/logged in/i);
  });

  it('whoami probes CliStats and prints identity JSON', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 42,
          totalSources: 3,
          activeSources: 3,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    const code = await runCli(['whoami'], mock, writer, home, { TROVE_TOKEN: 'tok' });
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliStats');
    const parsed = JSON.parse(writer.stdoutText());
    expect(parsed.totalDocuments).toBe(42);
    expect(parsed.tokenSource).toContain('env');
  });

  it('whoami with no token exits 4', async () => {
    const mock = mockFetch({});
    const code = await runCli(['whoami'], mock, writer, home, {});
    expect(code).toBe(ExitCode.Auth);
  });

  it('whoami renders a human record with a config token source', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 9,
          totalSources: 2,
          activeSources: 2,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    // Seed a file-backed profile so the token comes from config (not env).
    await runCli(['login', '--token', 'tok'], mock, writer, home);
    const w2 = captureWriter();
    await run({
      argv: ['whoami'],
      writer: w2,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: {}, keychain: { platform: 'win32' } },
    });
    expect(w2.stdoutText()).toMatch(/token/);
    expect(w2.stdoutText()).toMatch(/config/);
  });

  it('login stores the token in the OS keychain when available', async () => {
    const store = new Map<string, string>();
    const keychain = {
      platform: 'linux' as NodeJS.Platform,
      spawn: (_c: string, args: string[], options?: { input?: string }) => {
        const account = args[args.indexOf('account') + 1] ?? '';
        let stdout = '';
        let status = 0;
        if (args[0] === '--version') status = 0;
        else if (args[0] === 'store') store.set(account, options?.input ?? '');
        else if (args[0] === 'lookup') {
          const v = store.get(account);
          if (v === undefined) status = 1;
          else stdout = `${v}\n`;
        }
        return {
          pid: 1,
          output: [],
          stdout,
          stderr: '',
          status,
          signal: null,
        } as SpawnSyncReturns<string>;
      },
    };
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 1,
          totalSources: 1,
          activeSources: 1,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    const code = await run({
      argv: ['login', '--token', 'sk-kc'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: false,
      configEnv: { home: home.home, env: {}, keychain },
    });
    expect(code).toBe(ExitCode.Success);
    expect(store.get('trove-prod')).toBe('sk-kc');
    expect(writer.stderrText()).toMatch(/keychain/);
  });

  it('logout forgets the token for the profile', async () => {
    // Seed a logged-in profile via login.
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 1,
          totalSources: 1,
          activeSources: 1,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    await runCli(['login', '--token', 'tok'], mock, writer, home);
    expect(loadConfig({ home: home.home }).profiles.prod?.token).toBe('tok');
    await runCli(['logout'], mock, writer, home);
    expect(loadConfig({ home: home.home }).profiles.prod?.token).toBeUndefined();
  });
});
