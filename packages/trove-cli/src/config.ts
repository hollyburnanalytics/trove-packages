import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { authError } from './errors.js';
import { Keychain, type KeychainEnv, parseKeychainRef } from './lib/keychain.js';
import { parseToml, stringifyToml, type TomlTable } from './lib/toml.js';

/** The default GraphQL API base URL. */
export const DEFAULT_API_URL = 'https://api.ontrove.sh';
/** The default Clerk issuer used for the device/loopback login flow. */
export const DEFAULT_ISSUER = 'https://accounts.ontrove.sh';
/** The default profile name when none is configured. */
export const DEFAULT_PROFILE = 'prod';

/** A single named environment + identity in `~/.trove/config.toml`. */
export interface Profile {
  /** Profile name (the table key under `[profiles.<name>]`). */
  name: string;
  /** GraphQL API base URL; `/graphql` is appended for requests. */
  apiUrl: string;
  /** Clerk issuer URL for login. */
  issuer: string;
  /**
   * The bearer token stored inline in the TOML file (chmod 600). Used only when
   * no OS keychain is available; otherwise the token lives in the keychain and
   * this is absent in favor of {@link Profile.tokenRef}.
   */
  token?: string;
  /**
   * A keychain reference (`keychain:<account>`) recorded when the token is held
   * in the OS keychain instead of the file.
   */
  tokenRef?: string;
  /**
   * The OAuth refresh token, stored inline (chmod 600) only when no OS keychain
   * is available; otherwise it lives in the keychain and this is absent in favor
   * of {@link Profile.refreshTokenRef}. Used to mint a new access token when the
   * short-lived one expires, without reopening the browser.
   */
  refreshToken?: string;
  /**
   * A keychain reference (`keychain:<account>`) recorded when the refresh token
   * is held in the OS keychain instead of the file.
   */
  refreshTokenRef?: string;
  /**
   * The authorization server's token endpoint, cached at login so a silent
   * refresh needs no re-discovery. Non-secret, so always stored in the file.
   */
  tokenEndpoint?: string;
  /** The signed-in email, recorded for `whoami`/`logout` UX. */
  email?: string;
  /**
   * The OAuth `client_id` the CLI self-registered (RFC 7591 DCR) for this
   * profile's issuer, cached so re-login reuses the same client instead of
   * registering a new one each time.
   */
  clientId?: string;
}

/** The whole config: a default-profile pointer plus the named profiles. */
export interface TroveConfig {
  /** The profile used when no `--profile`/`TROVE_PROFILE` is given. */
  defaultProfile: string;
  /** All named profiles, keyed by name. */
  profiles: Record<string, Profile>;
}

/** How the active profile (and its overrides) were resolved, for diagnostics. */
export interface ResolvedProfile extends Profile {
  /** True when `TROVE_TOKEN` supplied the token (the CI override). */
  tokenFromEnv: boolean;
}

/** The credentials needed to silently refresh an expired access token. */
export interface RefreshCredentials {
  /** The stored refresh token. */
  refreshToken: string;
  /** The token endpoint to redeem it at. */
  tokenEndpoint: string;
  /** The public OAuth client id the refresh token was issued to. */
  clientId: string;
}

/** Options that influence config resolution from the CLI/env. */
export interface ConfigEnv {
  /** Override for `$HOME` (tests). */
  home?: string;
  /** Process environment (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** `--profile` flag value, highest-priority profile selector. */
  profileFlag?: string;
  /** `--endpoint` flag value, overrides the profile's `apiUrl`. */
  endpointFlag?: string;
  /**
   * Keychain backend overrides (tests inject a fake `spawn`/`platform`). When
   * omitted, the real OS keychain is probed.
   */
  keychain?: KeychainEnv;
}

/**
 * Resolve the path to `~/.trove/config.toml`, honoring a `home` override.
 *
 * @param env - Resolution options (only `home` is read).
 * @returns The absolute config file path.
 */
export function configPath(env: ConfigEnv = {}): string {
  const home = env.home ?? homedir();
  return join(home, '.trove', 'config.toml');
}

/**
 * Read and parse `~/.trove/config.toml`. A missing file yields an empty config
 * with the default profile name (not an error — the user simply hasn't logged
 * in yet).
 *
 * @param env - Resolution options.
 * @returns The parsed {@link TroveConfig}.
 */
export function loadConfig(env: ConfigEnv = {}): TroveConfig {
  const path = configPath(env);
  if (!existsSync(path)) {
    return { defaultProfile: DEFAULT_PROFILE, profiles: {} };
  }
  const table = parseToml(readFileSync(path, 'utf8'));
  return fromTable(table);
}

/**
 * Write a config back to `~/.trove/config.toml`, creating `~/.trove` if needed
 * and chmod-ing the file to 600 (never world-readable tokens).
 *
 * @param config - The config to persist.
 * @param env - Resolution options (only `home` is read).
 */
export function saveConfig(config: TroveConfig, env: ConfigEnv = {}): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  // Create the file already-restricted so the token is never world-readable, even
  // momentarily (no write-then-chmod TOCTOU window). chmodSync still narrows any
  // pre-existing file to 600.
  writeFileSync(path, stringifyToml(toTable(config)), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Resolve the active profile, applying the documented precedence:
 * `--profile` > `TROVE_PROFILE` > `default_profile`; `--endpoint` overrides the
 * profile's `apiUrl`; `TROVE_TOKEN` overrides any stored token.
 *
 * @param config - The loaded config.
 * @param env - Resolution options.
 * @returns The resolved profile, including transport overrides.
 */
export function resolveProfile(config: TroveConfig, env: ConfigEnv = {}): ResolvedProfile {
  const processEnv = env.env ?? process.env;
  const name =
    env.profileFlag ?? processEnv.TROVE_PROFILE ?? config.defaultProfile ?? DEFAULT_PROFILE;

  const stored = config.profiles[name];
  const base: Profile = stored ?? {
    name,
    apiUrl: DEFAULT_API_URL,
    issuer: DEFAULT_ISSUER,
  };

  const envToken = processEnv.TROVE_TOKEN;
  // Precedence: TROVE_TOKEN > inline file token > keychain-referenced token.
  const refToken = base.tokenRef !== undefined ? resolveTokenRef(base.tokenRef, env) : undefined;
  const token = envToken ?? base.token ?? refToken;

  // The refresh token mirrors the access token's storage: inline file value or
  // keychain reference. `TROVE_TOKEN` intentionally does not participate — a
  // CI-supplied bearer token is not refreshable.
  const refreshRefToken =
    base.refreshTokenRef !== undefined ? resolveTokenRef(base.refreshTokenRef, env) : undefined;
  const refreshToken = base.refreshToken ?? refreshRefToken;

  return {
    name,
    apiUrl: env.endpointFlag ?? base.apiUrl,
    issuer: base.issuer,
    tokenFromEnv: envToken !== undefined,
    ...(token !== undefined ? { token } : {}),
    ...(base.tokenRef !== undefined ? { tokenRef: base.tokenRef } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(base.refreshTokenRef !== undefined ? { refreshTokenRef: base.refreshTokenRef } : {}),
    ...(base.tokenEndpoint !== undefined ? { tokenEndpoint: base.tokenEndpoint } : {}),
    ...(base.clientId !== undefined ? { clientId: base.clientId } : {}),
    ...(base.email !== undefined ? { email: base.email } : {}),
  };
}

/**
 * Extract the refresh credentials from a resolved profile, or `null` when the
 * profile lacks any of the three parts a silent refresh needs (refresh token,
 * token endpoint, client id) — e.g. a `TROVE_TOKEN`/`--token` login, or a login
 * from before refresh support existed.
 *
 * @param profile - The resolved profile.
 * @returns The {@link RefreshCredentials}, or null when refresh is unavailable.
 */
export function refreshCredentials(profile: ResolvedProfile): RefreshCredentials | null {
  if (
    profile.tokenFromEnv ||
    profile.refreshToken === undefined ||
    profile.tokenEndpoint === undefined ||
    profile.clientId === undefined
  ) {
    return null;
  }
  return {
    refreshToken: profile.refreshToken,
    tokenEndpoint: profile.tokenEndpoint,
    clientId: profile.clientId,
  };
}

/**
 * Resolve a `keychain:<account>` reference to the stored token, or undefined
 * when the reference is malformed or the keychain has no such item.
 *
 * @param ref - The `token_ref` value.
 * @param env - Resolution options (keychain injection).
 * @returns The token, or undefined.
 */
function resolveTokenRef(ref: string, env: ConfigEnv): string | undefined {
  const account = parseKeychainRef(ref);
  if (account === null) return undefined;
  return new Keychain(env.keychain ?? {}).get(account) ?? undefined;
}

/**
 * Persist a token for a profile, preferring the OS keychain when available and
 * falling back to the inline chmod-600 TOML file otherwise. The
 * returned profile is updated in place in `config` and the config is written.
 *
 * @param config - The loaded config to mutate and save.
 * @param profileName - The profile to attach the token to.
 * @param token - The bearer token.
 * @param extra - Optional profile fields to set (`apiUrl`/`issuer`/`email`/
 *   `clientId`, plus the `refreshToken`/`tokenEndpoint` that enable silent
 *   refresh). The refresh token is stored beside the access token — in the
 *   keychain when one is available, else inline in the chmod-600 file.
 * @param env - Resolution options (home + keychain injection).
 * @returns Whether the token was stored in the keychain (`true`) or the file (`false`).
 */
export function persistToken(
  config: TroveConfig,
  profileName: string,
  token: string,
  extra: {
    apiUrl: string;
    issuer: string;
    email?: string;
    clientId?: string;
    refreshToken?: string;
    tokenEndpoint?: string;
  },
  env: ConfigEnv = {},
): boolean {
  const keychain = new Keychain(env.keychain ?? {});
  const account = `trove-${profileName}`;
  const refreshAccount = `${account}-refresh`;
  const profile: Profile = {
    name: profileName,
    apiUrl: extra.apiUrl,
    issuer: extra.issuer,
    ...(extra.email !== undefined ? { email: extra.email } : {}),
    ...(extra.clientId !== undefined ? { clientId: extra.clientId } : {}),
    ...(extra.tokenEndpoint !== undefined ? { tokenEndpoint: extra.tokenEndpoint } : {}),
  };

  let usedKeychain = false;
  if (keychain.available() && keychain.set(account, token)) {
    profile.tokenRef = keychain.ref(account);
    usedKeychain = true;
  } else {
    profile.token = token;
  }

  // Store the refresh token beside the access token, using the same backend so
  // the two never split across keychain and file.
  if (extra.refreshToken !== undefined) {
    if (usedKeychain && keychain.set(refreshAccount, extra.refreshToken)) {
      profile.refreshTokenRef = keychain.ref(refreshAccount);
    } else {
      profile.refreshToken = extra.refreshToken;
    }
  }

  config.profiles[profileName] = profile;
  saveConfig(config, env);
  return usedKeychain;
}

/**
 * Forget the token for a profile: clear it from the keychain (if referenced) and
 * rewrite the profile without `token`/`token_ref`. The config is saved.
 *
 * @param config - The loaded config to mutate and save.
 * @param profileName - The profile to forget.
 * @param env - Resolution options (home + keychain injection).
 */
export function forgetToken(config: TroveConfig, profileName: string, env: ConfigEnv = {}): void {
  const profile = config.profiles[profileName];
  if (!profile) return;
  const keychain = new Keychain(env.keychain ?? {});
  for (const ref of [profile.tokenRef, profile.refreshTokenRef]) {
    if (ref === undefined) continue;
    const account = parseKeychainRef(ref);
    if (account !== null) keychain.delete(account);
  }
  config.profiles[profileName] = {
    name: profile.name,
    apiUrl: profile.apiUrl,
    issuer: profile.issuer,
    ...(profile.clientId !== undefined ? { clientId: profile.clientId } : {}),
    ...(profile.email !== undefined ? { email: profile.email } : {}),
  };
  saveConfig(config, env);
}

/**
 * Resolve the active profile and assert it carries a token, throwing an auth
 * error (exit 4) otherwise. Used by every command that calls the API.
 *
 * @param env - Resolution options.
 * @returns The resolved profile, guaranteed to have a `token`.
 * @throws {@link CliError} with {@link ExitCode.Auth} when no token is present.
 */
export function requireAuth(env: ConfigEnv = {}): ResolvedProfile & { token: string } {
  const profile = resolveProfile(loadConfig(env), env);
  if (!profile.token) {
    throw authError(
      `Not logged in (profile: ${profile.name}). Run 'trove login' or set TROVE_TOKEN.`,
    );
  }
  return { ...profile, token: profile.token };
}

/** Build one {@link Profile} from its parsed `[profiles.<name>]` sub-table. */
function profileFromTable(name: string, value: TomlTable): Profile {
  return {
    name,
    apiUrl: str(value.api_url) ?? DEFAULT_API_URL,
    issuer: str(value.issuer) ?? DEFAULT_ISSUER,
    ...(str(value.token) !== undefined ? { token: str(value.token) } : {}),
    ...(str(value.token_ref) !== undefined ? { tokenRef: str(value.token_ref) } : {}),
    ...(str(value.refresh_token) !== undefined ? { refreshToken: str(value.refresh_token) } : {}),
    ...(str(value.refresh_token_ref) !== undefined
      ? { refreshTokenRef: str(value.refresh_token_ref) }
      : {}),
    ...(str(value.token_endpoint) !== undefined
      ? { tokenEndpoint: str(value.token_endpoint) }
      : {}),
    ...(str(value.email) !== undefined ? { email: str(value.email) } : {}),
    ...(str(value.client_id) !== undefined ? { clientId: str(value.client_id) } : {}),
  } as Profile;
}

/** Convert a parsed TOML table into a typed {@link TroveConfig}. */
function fromTable(table: TomlTable): TroveConfig {
  const defaultProfile =
    typeof table.default_profile === 'string' ? table.default_profile : DEFAULT_PROFILE;
  const profiles: Record<string, Profile> = {};

  const profilesTable = table.profiles;
  if (typeof profilesTable === 'object' && profilesTable !== null) {
    for (const [name, value] of Object.entries(profilesTable)) {
      if (typeof value !== 'object' || value === null) continue;
      profiles[name] = profileFromTable(name, value);
    }
  }

  return { defaultProfile, profiles };
}

/** Convert a typed {@link TroveConfig} back to a TOML table for serialization. */
function toTable(config: TroveConfig): TomlTable {
  const profiles: TomlTable = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    const entry: TomlTable = {
      api_url: profile.apiUrl,
      issuer: profile.issuer,
    };
    if (profile.token !== undefined) entry.token = profile.token;
    if (profile.tokenRef !== undefined) entry.token_ref = profile.tokenRef;
    if (profile.refreshToken !== undefined) entry.refresh_token = profile.refreshToken;
    if (profile.refreshTokenRef !== undefined) entry.refresh_token_ref = profile.refreshTokenRef;
    if (profile.tokenEndpoint !== undefined) entry.token_endpoint = profile.tokenEndpoint;
    if (profile.email !== undefined) entry.email = profile.email;
    if (profile.clientId !== undefined) entry.client_id = profile.clientId;
    profiles[name] = entry;
  }
  return { default_profile: config.defaultProfile, profiles };
}

/** Narrow a TOML leaf to a string, or undefined when absent/non-string. */
function str(value: string | TomlTable | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
