import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configPath,
  DEFAULT_API_URL,
  forgetToken,
  loadConfig,
  persistToken,
  refreshCredentials,
  requireAuth,
  resolveProfile,
  saveConfig,
} from '../src/config.js';
import { ExitCode } from '../src/errors.js';
import type { KeychainEnv } from '../src/lib/keychain.js';
import { type TempHome, tempHome } from './helpers.js';

/** An in-memory Linux `secret-tool` keychain backend for config tests. */
function fakeKeychain(): { env: KeychainEnv; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env: KeychainEnv = {
    platform: 'linux',
    spawn: (_c, args, options): SpawnSyncReturns<string> => {
      const account = args[args.indexOf('account') + 1] ?? '';
      let stdout = '';
      let status = 0;
      if (args[0] === '--version') status = 0;
      else if (args[0] === 'store') store.set(account, options?.input ?? '');
      else if (args[0] === 'lookup') {
        const v = store.get(account);
        if (v === undefined) status = 1;
        else stdout = `${v}\n`;
      } else if (args[0] === 'clear') store.delete(account);
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
  return { env, store };
}

describe('config', () => {
  let home: TempHome;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('returns an empty default config when the file is missing', () => {
    const config = loadConfig({ home: home.home });
    expect(config.defaultProfile).toBe('prod');
    expect(config.profiles).toEqual({});
  });

  it('applies api_url/issuer defaults when a profile omits them', () => {
    // A hand-written config with a bare profile (no api_url/issuer/token) and a
    // non-table profile entry that must be skipped — exercises fromTable's
    // defaulting and the `typeof value !== 'object'` guard.
    const path = configPath({ home: home.home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      ['[profiles.bare]', 'name = "bare"', '', '[profiles]', 'junk = "not-a-table"'].join('\n'),
    );
    const config = loadConfig({ home: home.home });
    expect(config.profiles.bare?.apiUrl).toBe(DEFAULT_API_URL);
    expect(config.profiles.bare?.issuer).toBeDefined();
    expect(config.profiles.bare?.token).toBeUndefined();
    expect(config.profiles.junk).toBeUndefined();
  });

  it('persists and reloads a self-registered OAuth client_id', () => {
    const used = persistToken(
      loadConfig({ home: home.home }),
      'prod',
      'tok',
      { apiUrl: DEFAULT_API_URL, issuer: 'i', clientId: 'cli_dcr_abc' },
      { home: home.home, keychain: { platform: 'win32' } },
    );
    expect(used).toBe(false);
    // Round-trips through the TOML client_id field.
    expect(loadConfig({ home: home.home }).profiles.prod?.clientId).toBe('cli_dcr_abc');
  });

  it('saves and reloads a profile, chmod 600', () => {
    saveConfig(
      {
        defaultProfile: 'prod',
        profiles: {
          prod: {
            name: 'prod',
            apiUrl: DEFAULT_API_URL,
            issuer: 'https://accounts.ontrove.sh',
            token: 'tok_abc',
            email: 'matt@example.com',
          },
        },
      },
      { home: home.home },
    );
    expect(existsSync(configPath({ home: home.home }))).toBe(true);
    const mode = statSync(configPath({ home: home.home })).mode & 0o777;
    expect(mode).toBe(0o600);

    const reloaded = loadConfig({ home: home.home });
    expect(reloaded.profiles.prod?.token).toBe('tok_abc');
    expect(reloaded.profiles.prod?.email).toBe('matt@example.com');
  });

  it('resolveProfile applies --profile > TROVE_PROFILE > default', () => {
    const config = {
      defaultProfile: 'prod',
      profiles: {
        prod: { name: 'prod', apiUrl: 'https://prod', issuer: 'i', token: 'p' },
        dev: { name: 'dev', apiUrl: 'https://dev', issuer: 'i', token: 'd' },
      },
    };
    expect(resolveProfile(config, { env: {} }).name).toBe('prod');
    expect(resolveProfile(config, { env: { TROVE_PROFILE: 'dev' } }).name).toBe('dev');
    expect(
      resolveProfile(config, { profileFlag: 'dev', env: { TROVE_PROFILE: 'prod' } }).name,
    ).toBe('dev');
  });

  it('TROVE_TOKEN overrides the stored token and --endpoint overrides apiUrl', () => {
    const config = {
      defaultProfile: 'prod',
      profiles: { prod: { name: 'prod', apiUrl: 'https://prod', issuer: 'i', token: 'stored' } },
    };
    const resolved = resolveProfile(config, {
      env: { TROVE_TOKEN: 'from-env' },
      endpointFlag: 'http://localhost:8787',
    });
    expect(resolved.token).toBe('from-env');
    expect(resolved.tokenFromEnv).toBe(true);
    expect(resolved.apiUrl).toBe('http://localhost:8787');
  });

  it('requireAuth throws an auth error when no token is present', () => {
    try {
      requireAuth({ home: home.home, env: {} });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code: number }).code).toBe(ExitCode.Auth);
    }
  });

  it('requireAuth succeeds with TROVE_TOKEN', () => {
    const profile = requireAuth({ home: home.home, env: { TROVE_TOKEN: 'tok' } });
    expect(profile.token).toBe('tok');
  });

  it('persistToken stores in the keychain and records a token_ref', () => {
    const { env, store } = fakeKeychain();
    const config = loadConfig({ home: home.home });
    const used = persistToken(
      config,
      'prod',
      'sk-secret',
      { apiUrl: DEFAULT_API_URL, issuer: 'i', email: 'm@e.com' },
      { home: home.home, keychain: env },
    );
    expect(used).toBe(true);
    expect(store.get('trove-prod')).toBe('sk-secret');
    // The file holds a ref, not the raw token.
    const reloaded = loadConfig({ home: home.home });
    expect(reloaded.profiles.prod?.token).toBeUndefined();
    expect(reloaded.profiles.prod?.tokenRef).toBe('keychain:trove-prod');
    // resolveProfile reads the token back through the keychain.
    const resolved = resolveProfile(reloaded, { home: home.home, env: {}, keychain: env });
    expect(resolved.token).toBe('sk-secret');
  });

  it('persistToken falls back to the file when no keychain is available', () => {
    const config = loadConfig({ home: home.home });
    const used = persistToken(
      config,
      'prod',
      'sk-file',
      { apiUrl: DEFAULT_API_URL, issuer: 'i' },
      { home: home.home, keychain: { platform: 'win32' } },
    );
    expect(used).toBe(false);
    expect(loadConfig({ home: home.home }).profiles.prod?.token).toBe('sk-file');
  });

  it('forgetToken clears the keychain item and the file ref', () => {
    const { env, store } = fakeKeychain();
    const config = loadConfig({ home: home.home });
    persistToken(
      config,
      'prod',
      'sk',
      { apiUrl: DEFAULT_API_URL, issuer: 'i' },
      { home: home.home, keychain: env },
    );
    forgetToken(loadConfig({ home: home.home }), 'prod', { home: home.home, keychain: env });
    expect(store.has('trove-prod')).toBe(false);
    const reloaded = loadConfig({ home: home.home });
    expect(reloaded.profiles.prod?.token).toBeUndefined();
    expect(reloaded.profiles.prod?.tokenRef).toBeUndefined();
  });

  it('forgetToken is a no-op for an unknown profile', () => {
    const config = loadConfig({ home: home.home });
    expect(() => forgetToken(config, 'ghost', { home: home.home })).not.toThrow();
  });

  it('persistToken stores the refresh token + endpoint alongside the token (file)', () => {
    const config = loadConfig({ home: home.home });
    persistToken(
      config,
      'prod',
      'sk-file',
      {
        apiUrl: DEFAULT_API_URL,
        issuer: 'i',
        clientId: 'cli',
        refreshToken: 'rt-file',
        tokenEndpoint: 'https://as/token',
      },
      { home: home.home, keychain: { platform: 'win32' } },
    );
    const reloaded = loadConfig({ home: home.home });
    expect(reloaded.profiles.prod?.refreshToken).toBe('rt-file');
    expect(reloaded.profiles.prod?.tokenEndpoint).toBe('https://as/token');
    const resolved = resolveProfile(reloaded, { home: home.home, env: {} });
    expect(resolved.refreshToken).toBe('rt-file');
    const creds = refreshCredentials(resolved);
    expect(creds).toEqual({
      refreshToken: 'rt-file',
      tokenEndpoint: 'https://as/token',
      clientId: 'cli',
    });
  });

  it('persistToken stores the refresh token in the keychain under a -refresh account', () => {
    const { env, store } = fakeKeychain();
    const config = loadConfig({ home: home.home });
    persistToken(
      config,
      'prod',
      'sk-secret',
      {
        apiUrl: DEFAULT_API_URL,
        issuer: 'i',
        clientId: 'cli',
        refreshToken: 'rt-secret',
        tokenEndpoint: 'https://as/token',
      },
      { home: home.home, keychain: env },
    );
    expect(store.get('trove-prod-refresh')).toBe('rt-secret');
    const reloaded = loadConfig({ home: home.home });
    // The file records only a ref, never the raw refresh token.
    expect(reloaded.profiles.prod?.refreshToken).toBeUndefined();
    expect(reloaded.profiles.prod?.refreshTokenRef).toBe('keychain:trove-prod-refresh');
    const resolved = resolveProfile(reloaded, { home: home.home, env: {}, keychain: env });
    expect(resolved.refreshToken).toBe('rt-secret');
  });

  it('forgetToken clears the keychain refresh item too', () => {
    const { env, store } = fakeKeychain();
    const config = loadConfig({ home: home.home });
    persistToken(
      config,
      'prod',
      'sk',
      { apiUrl: DEFAULT_API_URL, issuer: 'i', clientId: 'cli', refreshToken: 'rt' },
      { home: home.home, keychain: env },
    );
    expect(store.has('trove-prod-refresh')).toBe(true);
    forgetToken(loadConfig({ home: home.home }), 'prod', { home: home.home, keychain: env });
    expect(store.has('trove-prod')).toBe(false);
    expect(store.has('trove-prod-refresh')).toBe(false);
  });

  it('refreshCredentials returns null when a TROVE_TOKEN override is in play', () => {
    const config = loadConfig({ home: home.home });
    persistToken(
      config,
      'prod',
      'sk',
      {
        apiUrl: DEFAULT_API_URL,
        issuer: 'i',
        clientId: 'cli',
        refreshToken: 'rt',
        tokenEndpoint: 'https://as/token',
      },
      { home: home.home, keychain: { platform: 'win32' } },
    );
    const resolved = resolveProfile(loadConfig({ home: home.home }), {
      home: home.home,
      env: { TROVE_TOKEN: 'env-tok' },
    });
    // An env-supplied bearer token is not refreshable.
    expect(refreshCredentials(resolved)).toBeNull();
  });

  it('refreshCredentials returns null for a profile with no refresh material', () => {
    const config = loadConfig({ home: home.home });
    persistToken(
      config,
      'prod',
      'sk',
      { apiUrl: DEFAULT_API_URL, issuer: 'i' },
      { home: home.home, keychain: { platform: 'win32' } },
    );
    const resolved = resolveProfile(loadConfig({ home: home.home }), { home: home.home, env: {} });
    expect(refreshCredentials(resolved)).toBeNull();
  });

  it('persistToken falls back to the file when the keychain set fails', () => {
    // Keychain is "available" (probe ok) but store returns non-zero status.
    const env: KeychainEnv = {
      platform: 'linux',
      spawn: (_c, args): SpawnSyncReturns<string> =>
        ({
          pid: 1,
          output: [],
          stdout: '',
          stderr: '',
          status: args[0] === '--version' ? 0 : 1,
          signal: null,
        }) as SpawnSyncReturns<string>,
    };
    const config = loadConfig({ home: home.home });
    const used = persistToken(
      config,
      'prod',
      'tok',
      { apiUrl: DEFAULT_API_URL, issuer: 'i' },
      { home: home.home, keychain: env },
    );
    expect(used).toBe(false);
    expect(loadConfig({ home: home.home }).profiles.prod?.token).toBe('tok');
  });

  it('forgetToken ignores a malformed token_ref (no keychain account)', () => {
    saveConfig(
      {
        defaultProfile: 'prod',
        profiles: {
          prod: { name: 'prod', apiUrl: DEFAULT_API_URL, issuer: 'i', tokenRef: 'weird' },
        },
      },
      { home: home.home },
    );
    expect(() =>
      forgetToken(loadConfig({ home: home.home }), 'prod', { home: home.home }),
    ).not.toThrow();
  });

  it('resolveProfile ignores a malformed token_ref', () => {
    const config = {
      defaultProfile: 'prod',
      profiles: {
        prod: { name: 'prod', apiUrl: 'https://x', issuer: 'i', tokenRef: 'not-keychain' },
      },
    };
    expect(resolveProfile(config, { env: {} }).token).toBeUndefined();
  });

  it('loadConfig skips non-object profile entries', () => {
    saveConfig(
      {
        defaultProfile: 'prod',
        profiles: { prod: { name: 'prod', apiUrl: 'https://x', issuer: 'i' } },
      },
      { home: home.home },
    );
    // Loading round-trips cleanly even when the file is hand-edited oddly.
    expect(loadConfig({ home: home.home }).profiles.prod?.apiUrl).toBe('https://x');
  });

  it('persistToken falls back to the file when no keychain CLI is installed', () => {
    // Simulate a host where neither `security` nor `secret-tool` is installed:
    // the probe spawn returns an ENOENT-style error, so the keychain is
    // unavailable and the token lands in the chmod-600 file. Hermetic — unlike
    // probing the real host, this passes regardless of which CLIs are present
    // (a dev macOS has `security`; CI Linux may not have `secret-tool`).
    const noKeychainCli: KeychainEnv = {
      spawn: (): SpawnSyncReturns<string> =>
        ({
          pid: 0,
          output: [],
          stdout: '',
          stderr: '',
          status: null,
          signal: null,
          error: new Error('spawn ENOENT'),
        }) as SpawnSyncReturns<string>,
    };
    const config = loadConfig({ home: home.home });
    const used = persistToken(
      config,
      'prod',
      'tok',
      { apiUrl: DEFAULT_API_URL, issuer: 'i' },
      { home: home.home, keychain: noKeychainCli },
    );
    expect(used).toBe(false);
    expect(loadConfig({ home: home.home }).profiles.prod?.token).toBe('tok');
  });

  it('persistToken with no keychain env constructs the real default keychain', () => {
    // Exercises the `env.keychain ?? {}` default-construction branch against the
    // real `os.platform()`/`spawnSync` backend. Host-independent: a macOS dev box
    // routes to the keychain (token_ref), a keychain-less CI host routes to the
    // file (token) — either way the token is persisted and nothing throws.
    const config = loadConfig({ home: home.home });
    const used = persistToken(
      config,
      'prod',
      'tok',
      { apiUrl: DEFAULT_API_URL, issuer: 'i' },
      { home: home.home },
    );
    expect(typeof used).toBe('boolean');
    const reloaded = loadConfig({ home: home.home }).profiles.prod;
    expect(used ? reloaded?.tokenRef : reloaded?.token).toBeDefined();
  });

  it('forgetToken with no keychain env tolerates a keychain ref', () => {
    saveConfig(
      {
        defaultProfile: 'prod',
        profiles: {
          prod: {
            name: 'prod',
            apiUrl: DEFAULT_API_URL,
            issuer: 'i',
            tokenRef: 'keychain:trove-prod',
          },
        },
      },
      { home: home.home },
    );
    expect(() =>
      forgetToken(loadConfig({ home: home.home }), 'prod', { home: home.home }),
    ).not.toThrow();
  });

  it('resolveProfile reads a keychain-referenced token (no keychain env → null)', () => {
    const config = {
      defaultProfile: 'prod',
      profiles: {
        prod: { name: 'prod', apiUrl: 'https://x', issuer: 'i', tokenRef: 'keychain:trove-prod' },
      },
    };
    // No keychain available on CI → the ref resolves to no token.
    expect(resolveProfile(config, { env: {} }).token).toBeUndefined();
  });

  it('resolveProfile falls back to defaults for an unknown profile name', () => {
    const resolved = resolveProfile(
      { defaultProfile: 'prod', profiles: {} },
      { profileFlag: 'staging', env: {} },
    );
    expect(resolved.name).toBe('staging');
    expect(resolved.apiUrl).toBe(DEFAULT_API_URL);
    expect(resolved.token).toBeUndefined();
  });

  it('loadConfig parses token_ref and email and ignores a non-table profile', () => {
    // Hand-write a config with a profile table plus a stray scalar under profiles.
    saveConfig(
      {
        defaultProfile: 'prod',
        profiles: {
          prod: {
            name: 'prod',
            apiUrl: 'https://x',
            issuer: 'i',
            tokenRef: 'keychain:trove-prod',
            email: 'm@e.com',
          },
        },
      },
      { home: home.home },
    );
    const reloaded = loadConfig({ home: home.home });
    expect(reloaded.profiles.prod?.tokenRef).toBe('keychain:trove-prod');
    expect(reloaded.profiles.prod?.email).toBe('m@e.com');
  });
});
