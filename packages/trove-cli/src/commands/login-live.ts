import type { CommandContext } from '../context.js';
import {
  type LoginFlowDeps,
  type LoginFlowInput,
  loopbackStart,
  runLoginFlow,
} from '../lib/oauth.js';

/**
 * The production interactive-login seam, isolated here because it
 * is the one genuinely-unrunnable part of `trove login`: it opens the system
 * browser via `open` and binds a real loopback socket, then waits for the user
 * to authorize in Clerk. The pure flow logic it delegates to
 * ({@link runLoginFlow}, discovery, PKCE, the token exchange, the loopback
 * server) is fully unit-tested in `oauth.ts`/`oauth.test.ts`; only this thin
 * `open`+socket wiring is `requires live` and excluded from coverage.
 *
 * @module
 */

/**
 * Run the real loopback authorization-code + PKCE flow: open the browser via
 * `open`, bind a `127.0.0.1` callback server, and exchange the captured code.
 *
 * @param input - What to authorize against (API URL).
 * @param ctx - The command context (fetch, writer, output options).
 * @returns The acquired token and resolved issuer.
 */
export async function runLiveLoginFlow(
  input: LoginFlowInput,
  ctx: CommandContext,
): Promise<{
  token: string;
  refreshToken?: string;
  tokenEndpoint: string;
  issuer: string;
  clientId: string;
}> {
  // requires live browser/loopback: `open` and the socket bind run for real.
  const { default: open } = await import('open');
  const flowDeps: LoginFlowDeps = {
    fetchImpl: ctx.fetchImpl,
    openBrowser: async (url: string): Promise<void> => {
      await open(url);
    },
    startLoopback: (redirectPath: string) => loopbackStart(redirectPath),
    onProgress: (line: string): void => {
      if (!ctx.output.quiet) ctx.writer.err(ctx.style.dim(line));
    },
  };
  return runLoginFlow(input, flowDeps);
}
