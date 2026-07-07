import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Keychain, parseKeychainRef, type SpawnSync } from '../src/lib/keychain.js';

/** Build a fake `spawnSync` from a per-call responder. */
function fakeSpawn(
  responder: (command: string, args: string[], input?: string) => Partial<SpawnSyncReturns<string>>,
): { spawn: SpawnSync; calls: Array<{ command: string; args: string[]; input?: string }> } {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const spawn: SpawnSync = (command, args, options) => {
    calls.push({
      command,
      args,
      ...(options?.input !== undefined ? { input: options.input } : {}),
    });
    const r = responder(command, args, options?.input);
    return {
      pid: 1,
      output: [],
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status ?? 0,
      signal: null,
      ...(r.error !== undefined ? { error: r.error } : {}),
    } as SpawnSyncReturns<string>;
  };
  return { spawn, calls };
}

describe('parseKeychainRef', () => {
  it('parses keychain refs and rejects others', () => {
    expect(parseKeychainRef('keychain:trove-prod')).toBe('trove-prod');
    expect(parseKeychainRef('plain-token')).toBeNull();
  });
});

describe('Keychain — macOS (security)', () => {
  it('reports available when security probe succeeds', () => {
    const { spawn } = fakeSpawn(() => ({ status: 0 }));
    expect(new Keychain({ platform: 'darwin', spawn }).available()).toBe(true);
  });

  it('reports unavailable when security is missing (spawn error)', () => {
    const { spawn } = fakeSpawn(() => ({ error: new Error('ENOENT') }));
    expect(new Keychain({ platform: 'darwin', spawn }).available()).toBe(false);
  });

  it('sets, gets, and deletes a token via security', () => {
    const store = new Map<string, string>();
    const { spawn, calls } = fakeSpawn((_command, args) => {
      if (args[0] === '-h') return { status: 0 }; // existence probe
      const account = args[args.indexOf('-a') + 1] ?? '';
      if (args[0] === 'add-generic-password') {
        // macOS `security` reads `-w` from the tty (getpass), not stdin, so the
        // token is passed as the `-w` value rather than piped.
        store.set(account, args[args.indexOf('-w') + 1] ?? '');
        return { status: 0 };
      }
      if (args[0] === 'find-generic-password') {
        const v = store.get(account);
        return v === undefined ? { status: 1 } : { status: 0, stdout: `${v}\n` };
      }
      if (args[0] === 'delete-generic-password') {
        store.delete(account);
        return { status: 0 };
      }
      return { status: 1 };
    });
    const kc = new Keychain({ platform: 'darwin', spawn });
    expect(kc.set('trove-prod', 'tok')).toBe(true);
    expect(kc.get('trove-prod')).toBe('tok');
    expect(kc.ref('trove-prod')).toBe('keychain:trove-prod');
    expect(kc.delete('trove-prod')).toBe(true);
    expect(kc.get('trove-prod')).toBeNull();
    expect(command(calls, 'security')).toBe(true);

    // The token is passed as the `-w` value (macOS security ignores stdin for -w).
    const addCall = calls.find((c) => c.args[0] === 'add-generic-password');
    const addArgs = addCall?.args ?? [];
    expect(addArgs[addArgs.indexOf('-w') + 1]).toBe('tok');
    expect(addCall?.input).toBeUndefined();
  });

  it('get returns null when the value is empty', () => {
    const { spawn } = fakeSpawn((_c, args) =>
      args[0] === '-h' ? { status: 0 } : { status: 0, stdout: '\n' },
    );
    expect(new Keychain({ platform: 'darwin', spawn }).get('trove-prod')).toBeNull();
  });
});

describe('Keychain — Linux (secret-tool)', () => {
  it('stores and looks up via secret-tool, passing the token on stdin', () => {
    const store = new Map<string, string>();
    const { spawn, calls } = fakeSpawn((_c, args, input) => {
      if (args[0] === '--version') return { status: 0 };
      const account = args[args.indexOf('account') + 1] ?? '';
      if (args[0] === 'store') {
        store.set(account, input ?? '');
        return { status: 0 };
      }
      if (args[0] === 'lookup') {
        const v = store.get(account);
        return v === undefined ? { status: 1 } : { status: 0, stdout: `${v}\n` };
      }
      if (args[0] === 'clear') {
        store.delete(account);
        return { status: 0 };
      }
      return { status: 1 };
    });
    const kc = new Keychain({ platform: 'linux', spawn });
    expect(kc.available()).toBe(true);
    expect(kc.set('trove-dev', 'sk-1')).toBe(true);
    const storeCall = calls.find((c) => c.args[0] === 'store');
    expect(storeCall?.input).toBe('sk-1');
    expect(kc.get('trove-dev')).toBe('sk-1');
    expect(kc.delete('trove-dev')).toBe(true);
    expect(kc.get('trove-dev')).toBeNull();
  });

  it('lookup returns null on non-zero status', () => {
    const { spawn } = fakeSpawn((_c, args) =>
      args[0] === '--version' ? { status: 0 } : { status: 1 },
    );
    expect(new Keychain({ platform: 'linux', spawn }).get('x')).toBeNull();
  });

  it('lookup returns null for an empty stored value', () => {
    const { spawn } = fakeSpawn((_c, args) =>
      args[0] === '--version' ? { status: 0 } : { status: 0, stdout: '\n' },
    );
    expect(new Keychain({ platform: 'linux', spawn }).get('x')).toBeNull();
  });

  it('reports unavailable when secret-tool is missing', () => {
    const { spawn } = fakeSpawn(() => ({ error: new Error('ENOENT') }));
    expect(new Keychain({ platform: 'linux', spawn }).available()).toBe(false);
  });
});

describe('Keychain — unsupported platform', () => {
  it('is unavailable and returns falsy from every op', () => {
    const { spawn } = fakeSpawn(() => ({ status: 0 }));
    const kc = new Keychain({ platform: 'win32', spawn });
    expect(kc.available()).toBe(false);
    expect(kc.set('a', 'b')).toBe(false);
    expect(kc.get('a')).toBeNull();
    expect(kc.delete('a')).toBe(false);
  });
});

/** Whether every captured call used the given command. */
function command(
  calls: Array<{ command: string; args: string[]; input?: string }>,
  name: string,
): boolean {
  return calls.every((c) => c.command === name);
}
