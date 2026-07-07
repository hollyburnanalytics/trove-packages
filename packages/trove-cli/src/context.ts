import { GraphQLClient } from './client.js';
import {
  type ConfigEnv,
  loadConfig,
  persistToken,
  refreshCredentials,
  requireAuth,
  resolveProfile,
} from './config.js';
import { refreshAccessToken } from './lib/oauth.js';
import {
  type FormatFlags,
  type OutputOptions,
  resolveOutput,
  Style,
  type Writer,
} from './output.js';

/** Parsed global flags shared by every command. */
export interface GlobalFlags extends FormatFlags {
  /** `--profile <name>`. */
  profile?: string;
  /** `--endpoint <url>`. */
  endpoint?: string;
  /** `--help`/`-h`. */
  help?: boolean;
  /** `--version`/`-v`. */
  version?: boolean;
}

/**
 * The execution context handed to every command handler. It bundles the
 * resolved output options, a writer, and factories for an authenticated
 * GraphQL client — all injectable so commands are unit-testable against a
 * mocked `fetch` and filesystem with no real network or credentials.
 */
export interface CommandContext {
  /** Resolved output format/color/quiet. */
  output: OutputOptions;
  /** Styling helper bound to `output.color`. */
  style: Style;
  /** stdout/stderr sink. */
  writer: Writer;
  /** Parsed global flags. */
  globals: GlobalFlags;
  /** A `fetch` implementation (mocked in tests). */
  fetchImpl: typeof fetch;
  /** Config resolution inputs (home/env overrides for tests). */
  configEnv: ConfigEnv;
  /**
   * Build an authenticated GraphQL client for the active profile, throwing an
   * auth error (exit 4) if no token is available.
   */
  client(): GraphQLClient;
}

/** Inputs for {@link buildContext}. */
export interface BuildContextOptions {
  globals: GlobalFlags;
  writer: Writer;
  fetchImpl?: typeof fetch;
  /** Config/env overrides (tests inject `home`/`env`). */
  configEnv?: ConfigEnv;
  /** TTY override for format resolution (tests). */
  isTTY?: boolean;
}

/**
 * Assemble a {@link CommandContext} from parsed global flags. Resolves output
 * options and wires the client factory to the active profile.
 *
 * @param options - The build inputs.
 * @returns A ready-to-use command context.
 */
export function buildContext(options: BuildContextOptions): CommandContext {
  const configEnv: ConfigEnv = {
    ...(options.configEnv ?? {}),
    ...(options.globals.profile !== undefined ? { profileFlag: options.globals.profile } : {}),
    ...(options.globals.endpoint !== undefined ? { endpointFlag: options.globals.endpoint } : {}),
  };

  const output = resolveOutput(options.globals, {
    ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
    ...(configEnv.env !== undefined ? { env: configEnv.env } : {}),
  });
  const style = new Style(output.color);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    output,
    style,
    writer: options.writer,
    globals: options.globals,
    fetchImpl,
    configEnv,
    client(): GraphQLClient {
      const profile = requireAuth(configEnv);
      return new GraphQLClient({
        apiUrl: profile.apiUrl,
        token: profile.token,
        fetchImpl,
        onAuthFailure: () => refreshActiveToken(fetchImpl, configEnv),
      });
    },
  };
}

/**
 * Redeem the active profile's refresh token for a new access token and persist
 * it, returning the fresh token (or `null` when refresh is unavailable or the
 * refresh token was itself rejected — the caller then surfaces the auth error).
 *
 * Wired as the client's {@link ClientOptions.onAuthFailure} so an expired
 * access token is renewed transparently mid-command, no re-login required.
 */
export async function refreshActiveToken(
  fetchImpl: typeof fetch,
  configEnv: ConfigEnv,
): Promise<string | null> {
  const config = loadConfig(configEnv);
  const profile = resolveProfile(config, configEnv);
  const creds = refreshCredentials(profile);
  if (creds === null) return null;

  let refreshed: { accessToken: string; refreshToken?: string };
  try {
    refreshed = await refreshAccessToken(fetchImpl, creds.tokenEndpoint, {
      refreshToken: creds.refreshToken,
      clientId: creds.clientId,
    });
  } catch {
    // Refresh token expired/revoked or the endpoint failed — fall back to the
    // auth error so the user is told to run `trove login`.
    return null;
  }

  // Persist against the profile's stored apiUrl (not any `--endpoint` override),
  // preserving issuer/email and keeping the previous refresh token when the
  // server did not rotate it.
  const stored = config.profiles[profile.name];
  persistToken(
    config,
    profile.name,
    refreshed.accessToken,
    {
      apiUrl: stored?.apiUrl ?? profile.apiUrl,
      issuer: stored?.issuer ?? profile.issuer,
      ...(profile.email !== undefined ? { email: profile.email } : {}),
      clientId: creds.clientId,
      tokenEndpoint: creds.tokenEndpoint,
      refreshToken: refreshed.refreshToken ?? creds.refreshToken,
    },
    configEnv,
  );
  return refreshed.accessToken;
}
