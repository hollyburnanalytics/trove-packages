import { GraphQLClient } from '../client.js';
import {
  DEFAULT_API_URL,
  DEFAULT_ISSUER,
  forgetToken,
  loadConfig,
  persistToken,
  resolveProfile,
} from '../config.js';
import type { CommandContext } from '../context.js';
import { refreshActiveToken } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import type { LoginFlowInput } from '../lib/oauth.js';
import * as ops from '../operations.js';
import { renderJson, renderRecord } from '../output.js';
import type { UserStats } from '../types.js';
import { runLiveLoginFlow } from './login-live.js';

/**
 * The interactive-login seam: how the CLI runs the OAuth flow. The default wires
 * the real `open` (system browser) and the real loopback server (in
 * `login-live.ts`, `requires live`); tests inject a fake `runFlow` so no browser,
 * socket, or network is touched.
 */
export interface LoginDeps {
  /** Run the loopback authorization-code + PKCE flow and return the token. */
  runFlow(
    input: LoginFlowInput,
    ctx: CommandContext,
  ): Promise<{
    token: string;
    refreshToken?: string;
    tokenEndpoint: string;
    issuer: string;
    clientId: string;
  }>;
}

/** The production login seam — the live `open`/loopback flow (excluded from coverage). */
const defaultLoginDeps: LoginDeps = { runFlow: runLiveLoginFlow };

/**
 * `trove login` — acquire a Clerk bearer token and store it in the active
 * profile.
 *
 * Two paths: `--token <jwt>` (or `TROVE_TOKEN`) persists a token directly — the
 * CI/non-interactive override; otherwise the CLI runs the **loopback
 * authorization-code + PKCE** flow: discover the OAuth endpoints
 * from the API, open the browser, capture the redirect on `127.0.0.1`, and
 * exchange the code for a token. The token is stored in the OS keychain when
 * available, else the chmod-600 TOML file.
 *
 * @param ctx - The command context.
 * @param args - Parsed flags (`--token`, `--email`).
 * @param deps - Injectable login seam (tests mock the OAuth flow).
 * @returns The process exit code.
 */
export async function login(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: LoginDeps = defaultLoginDeps,
): Promise<number> {
  const config = loadConfig(ctx.configEnv);
  const profileName = ctx.globals.profile ?? config.defaultProfile ?? 'prod';
  const stored = config.profiles[profileName];
  const endpoint = ctx.globals.endpoint ?? stored?.apiUrl ?? DEFAULT_API_URL;
  let issuer = stored?.issuer ?? DEFAULT_ISSUER;

  const overrideToken = flag(args, 'token') ?? ctx.configEnv.env?.TROVE_TOKEN;
  let token: string;
  // Reuse a previously self-registered OAuth client id when one is cached.
  let clientId = stored?.clientId;
  // Refresh material acquired by the browser flow (absent for `--token`).
  let refreshToken: string | undefined;
  let tokenEndpoint: string | undefined;
  if (overrideToken) {
    token = overrideToken;
  } else {
    ctx.writer.err(ctx.style.bold('Authorizing the Trove CLI via your browser…'));
    const result = await deps.runFlow({ apiUrl: endpoint, ...(clientId ? { clientId } : {}) }, ctx);
    token = result.token;
    issuer = result.issuer;
    clientId = result.clientId;
    refreshToken = result.refreshToken;
    tokenEndpoint = result.tokenEndpoint;
  }

  // Verify the token by probing `stats` (the same call `whoami` uses).
  const client = new GraphQLClient({ apiUrl: endpoint, token, fetchImpl: ctx.fetchImpl });
  await client.request<{ stats: UserStats }>({ query: ops.STATS, operationName: 'CliStats' });

  const email = flag(args, 'email');
  const usedKeychain = persistToken(
    config,
    profileName,
    token,
    {
      apiUrl: endpoint,
      issuer,
      ...(email !== undefined ? { email } : {}),
      ...(clientId ? { clientId } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(tokenEndpoint !== undefined ? { tokenEndpoint } : {}),
    },
    ctx.configEnv,
  );

  const where = usedKeychain ? 'OS keychain' : 'config.toml (chmod 600)';
  ctx.writer.err(
    ctx.style.green(
      `✓ logged in${email ? ` as ${email}` : ''}  (profile: ${profileName}, token in ${where})`,
    ),
  );
  return ExitCode.Success;
}

/**
 * `trove logout` — forget the token for the active profile, clearing it from
 * the OS keychain when it was stored there.
 *
 * @param ctx - The command context.
 * @returns The process exit code.
 */
export async function logout(ctx: CommandContext): Promise<number> {
  const config = loadConfig(ctx.configEnv);
  const profileName = ctx.globals.profile ?? config.defaultProfile ?? 'prod';
  forgetToken(config, profileName, ctx.configEnv);
  ctx.writer.err(ctx.style.dim(`Forgot token for profile: ${profileName}`));
  return Promise.resolve(ExitCode.Success);
}

/**
 * `trove whoami` — verify the token and print identity + corpus size.
 *
 * Verifies the token against `query stats` for the active identity and reports
 * the configured profile email alongside the corpus size.
 *
 * @param ctx - The command context.
 * @returns The process exit code.
 */
export async function whoami(ctx: CommandContext): Promise<number> {
  const profile = resolveProfile(loadConfig(ctx.configEnv), ctx.configEnv);
  if (!profile.token) {
    throw new CliError(
      `Not logged in (profile: ${profile.name}). Run 'trove login'.`,
      ExitCode.Auth,
    );
  }
  const client = new GraphQLClient({
    apiUrl: profile.apiUrl,
    token: profile.token,
    fetchImpl: ctx.fetchImpl,
    onAuthFailure: (): Promise<string | null> => refreshActiveToken(ctx.fetchImpl, ctx.configEnv),
  });
  const data = await client.request<{ stats: UserStats }>(
    { query: ops.STATS, operationName: 'CliStats' },
    true,
  );

  const identity = {
    profile: profile.name,
    email: profile.email ?? null,
    apiUrl: profile.apiUrl,
    tokenSource: profile.tokenFromEnv
      ? 'env (TROVE_TOKEN)'
      : profile.tokenRef !== undefined
        ? 'keychain'
        : 'config',
    totalDocuments: data.stats.totalDocuments,
    totalSources: data.stats.totalSources,
  };

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(identity, ctx.output.format));
  } else {
    ctx.writer.out(
      renderRecord(
        [
          ['profile', identity.profile],
          ['email', identity.email ?? '(unknown — set it with `trove login --email`)'],
          ['endpoint', identity.apiUrl],
          ['token', identity.tokenSource],
          ['documents', String(identity.totalDocuments)],
          ['sources', String(identity.totalSources)],
        ],
        ctx.style,
      ),
    );
  }
  return ExitCode.Success;
}

/** Flag specs for the auth commands. */
export const flagSpecs = {
  login: { value: ['token', 'email'] },
  logout: {},
  whoami: {},
};
