import { readFileSync } from 'node:fs';
import type { CommandContext } from '../context.js';
import { ExitCode, usageError } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import { renderJson } from '../output.js';

/**
 * `trove gql <file|->` — the advanced escape hatch: run a
 * raw, user-supplied GraphQL document over the same endpoint with the same
 * token. The full `{ data, errors }` envelope is emitted so power users can
 * reach un-wrapped operations. Variables come from `--variables <json|->`.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`<file|->`) + `--variables`.
 * @returns The process exit code.
 */
export async function gql(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const source = args.positionals[0];
  if (!source) throw usageError('Usage: trove gql <file|-> [--variables <json|->]');
  const query = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  if (query.trim() === '') throw usageError('Empty GraphQL document.');

  const varsArg = flag(args, 'variables');
  let variables: Record<string, unknown> = {};
  if (varsArg !== undefined) {
    const rawVars = varsArg === '-' ? readFileSync(0, 'utf8') : varsArg;
    try {
      variables = JSON.parse(rawVars) as Record<string, unknown>;
    } catch {
      throw usageError('--variables must be valid JSON.');
    }
  }

  // Emit the raw envelope without throwing on errors[] so scripts can branch.
  const envelope = await ctx.client().requestEnvelope<unknown>({ query, variables });
  ctx.writer.out(renderJson(envelope, ctx.output.format === 'jsonl' ? 'jsonl' : 'json'));
  return envelope.errors && envelope.errors.length > 0 ? ExitCode.Transport : ExitCode.Success;
}

/** Flag spec for `gql`. */
export const flagSpecs = { gql: { value: ['variables'] } };
