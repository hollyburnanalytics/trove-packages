import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * OS-keychain token storage: prefer the platform secret store —
 * macOS Keychain via the `security` CLI, Linux libsecret via `secret-tool` — and
 * fall back to the chmod-600 TOML file when neither is present (CI, containers).
 *
 * No native dependency: the CLI shells out to the OS CLIs and detects their
 * availability, so a missing keychain degrades cleanly to the file path. When the
 * keychain is used, `config.toml` records a `token_ref` (`keychain:<account>`)
 * instead of the raw token.
 *
 * @module
 */

/** The Keychain/libsecret service name all Trove tokens are stored under. */
export const KEYCHAIN_SERVICE = 'trove-cli';

/**
 * A child-process runner with the same shape as `spawnSync`. Injected so tests
 * exercise the keychain logic without touching the real OS store.
 */
export type SpawnSync = (
  command: string,
  args: string[],
  options?: { input?: string },
) => SpawnSyncReturns<string>;

/** Inputs for {@link Keychain} (all injectable for tests). */
export interface KeychainEnv {
  /** The platform string (`'darwin'`/`'linux'`/…). Defaults to `os.platform()`. */
  platform?: NodeJS.Platform;
  /** The child-process runner. Defaults to a UTF-8 `spawnSync`. */
  spawn?: SpawnSync;
}

/** The default `spawnSync`, fixed to capture UTF-8 stdout. */
const defaultSpawn: SpawnSync = (command, args, options) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    ...(options?.input !== undefined ? { input: options.input } : {}),
  });

/**
 * A thin wrapper over the OS secret store. Detects whether a backing CLI is
 * available, and reads/writes/deletes a token by account name, returning
 * `false`/`null` (never throwing) so callers can fall back to the file.
 */
export class Keychain {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: SpawnSync;

  /** @param env - Platform/spawn overrides (tests). */
  constructor(env: KeychainEnv = {}) {
    this.platform = env.platform ?? platform();
    this.spawn = env.spawn ?? defaultSpawn;
  }

  /**
   * Whether a usable OS keychain CLI is present on this platform.
   *
   * @returns True when `security` (macOS) or `secret-tool` (Linux) is runnable.
   */
  available(): boolean {
    return this.backend() !== null;
  }

  /**
   * The `token_ref` value to record in `config.toml` for an account.
   *
   * @param account - The keychain account name (e.g. `trove-prod`).
   * @returns The `keychain:<account>` reference string.
   */
  ref(account: string): string {
    return `keychain:${account}`;
  }

  /**
   * Store (or replace) a token for an account.
   *
   * @param account - The keychain account name.
   * @param token - The bearer token to store.
   * @returns True on success; false if no keychain is available or the store failed.
   */
  set(account: string, token: string): boolean {
    const backend = this.backend();
    if (backend === 'security') {
      // -U updates if the item already exists. The password is passed as the `-w`
      // VALUE: macOS `security` reads `-w` (with no value) from the controlling
      // terminal (/dev/tty) via getpass — NOT from stdin — so a piped token is
      // ignored and the command hangs on a "password data for new item:" prompt.
      // Passing it inline is the only reliable non-interactive form; the token is
      // briefly visible via `ps` for the duration of this one short spawn.
      const res = this.run('security', [
        'add-generic-password',
        '-a',
        account,
        '-s',
        KEYCHAIN_SERVICE,
        '-U',
        '-w',
        token,
      ]);
      return res.status === 0;
    }
    if (backend === 'secret-tool') {
      const res = this.run(
        'secret-tool',
        [
          'store',
          '--label',
          `${KEYCHAIN_SERVICE}:${account}`,
          'service',
          KEYCHAIN_SERVICE,
          'account',
          account,
        ],
        token,
      );
      return res.status === 0;
    }
    return false;
  }

  /**
   * Read a token for an account.
   *
   * @param account - The keychain account name.
   * @returns The token, or null when absent/unavailable.
   */
  get(account: string): string | null {
    const backend = this.backend();
    if (backend === 'security') {
      const res = this.run('security', [
        'find-generic-password',
        '-a',
        account,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ]);
      if (res.status !== 0) return null;
      const value = res.stdout.replace(/\n$/, '');
      return value.length > 0 ? value : null;
    }
    if (backend === 'secret-tool') {
      const res = this.run('secret-tool', [
        'lookup',
        'service',
        KEYCHAIN_SERVICE,
        'account',
        account,
      ]);
      if (res.status !== 0) return null;
      const value = res.stdout.replace(/\n$/, '');
      return value.length > 0 ? value : null;
    }
    return null;
  }

  /**
   * Delete a token for an account (best-effort; missing items are not an error).
   *
   * @param account - The keychain account name.
   * @returns True if a keychain backend handled the request.
   */
  delete(account: string): boolean {
    const backend = this.backend();
    if (backend === 'security') {
      this.run('security', ['delete-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE]);
      return true;
    }
    if (backend === 'secret-tool') {
      this.run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
      return true;
    }
    return false;
  }

  /** Resolve which keychain backend (if any) is usable on this platform. */
  private backend(): 'security' | 'secret-tool' | null {
    if (this.platform === 'darwin') {
      return this.exists('security', ['-h']) ? 'security' : null;
    }
    if (this.platform === 'linux') {
      return this.exists('secret-tool', ['--version']) ? 'secret-tool' : null;
    }
    return null;
  }

  /** Whether a CLI runs at all (probe a harmless flag; spawn error → absent). */
  private exists(command: string, args: string[]): boolean {
    const res = this.run(command, args);
    return res.error === undefined;
  }

  /** Run a command, normalizing a spawn failure to a non-zero status. */
  private run(command: string, args: string[], input?: string): SpawnSyncReturns<string> {
    return this.spawn(command, args, input !== undefined ? { input } : undefined);
  }
}

/**
 * Parse a `token_ref` value into its keychain account name.
 *
 * @param ref - A `keychain:<account>` reference, or any other string.
 * @returns The account name, or null when `ref` is not a keychain reference.
 */
export function parseKeychainRef(ref: string): string | null {
  return ref.startsWith('keychain:') ? ref.slice('keychain:'.length) : null;
}
