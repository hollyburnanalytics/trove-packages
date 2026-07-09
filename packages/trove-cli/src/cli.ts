// Imported (not read from disk) so the version is embedded in the compiled
// single-binary — a filesystem read of package.json does not resolve there.
import pkg from '../package.json' with { type: 'json' };
import * as auth from './commands/auth.js';
import * as capture from './commands/capture.js';
import * as gqlCmd from './commands/gql.js';
import * as mcp from './commands/mcp.js';
import * as mcpDev from './commands/mcp-dev.js';
import * as query from './commands/query.js';
import * as sourceDev from './commands/source-dev.js';
import type { ConfigEnv } from './config.js';
import type { CommandContext } from './context.js';
import { buildContext, type GlobalFlags } from './context.js';
import { CliError, ExitCode, type ExitCodeValue, usageError } from './errors.js';
import { type FlagSpec, type ParsedArgs, parseArgs, readFlagValue } from './lib/args.js';
import { defaultWriter, type Writer } from './output.js';

/** The CLI's own version, from the package.json embedded at build time. */
function cliVersion(): string {
  return (pkg as { version?: string }).version ?? '0.0.0';
}

/** A command handler: receives the context + parsed command args. */
type Handler = (ctx: CommandContext, args: ReturnType<typeof parseArgs>) => Promise<number>;

/** A registered command: its flag spec and handler. */
interface Command {
  spec: FlagSpec;
  run: Handler;
}

/**
 * The command registry — the executable form of the command mapping table.
 * Keys are space-joined command paths (`'mcp ls'`, `'secret set'`); the
 * dispatcher matches the longest path prefix.
 */
const COMMANDS: Record<string, Command> = {
  // auth
  login: { spec: auth.flagSpecs.login, run: auth.login },
  logout: {
    spec: auth.flagSpecs.logout,
    run: (ctx: CommandContext): Promise<number> => auth.logout(ctx),
  },
  whoami: {
    spec: auth.flagSpecs.whoami,
    run: (ctx: CommandContext): Promise<number> => auth.whoami(ctx),
  },
  // query
  search: { spec: query.flagSpecs.search, run: query.search },
  discover: { spec: query.flagSpecs.discover, run: query.discover },
  recent: { spec: query.flagSpecs.recent, run: query.recent },
  get: { spec: query.flagSpecs.get, run: query.get },
  list: { spec: query.flagSpecs.list, run: query.list },
  sources: { spec: query.flagSpecs.sources, run: query.sources },
  source: { spec: query.flagSpecs.source, run: query.source },
  stats: { spec: {}, run: (ctx: CommandContext): Promise<number> => query.stats(ctx) },
  // source dev (local SDK toolchain)
  'source init': { spec: sourceDev.flagSpecs.init, run: sourceDev.init },
  'source dev': {
    spec: sourceDev.flagSpecs.dev,
    run: (ctx: CommandContext, a: ParsedArgs): Promise<number> => sourceDev.dev(ctx, a),
  },
  'source test': {
    spec: sourceDev.flagSpecs.test,
    run: (ctx: CommandContext, a: ParsedArgs): Promise<number> => sourceDev.test(ctx, a),
  },
  'source validate': { spec: sourceDev.flagSpecs.validate, run: sourceDev.validate },
  'source sync': {
    spec: sourceDev.flagSpecs.sync,
    run: (ctx: CommandContext, a: ParsedArgs): Promise<number> => sourceDev.sync(ctx, a),
  },
  // capture
  save: { spec: capture.flagSpecs.save, run: capture.save },
  ingest: { spec: capture.flagSpecs.ingest, run: capture.ingest },
  // mcp remote management
  'mcp ls': { spec: {}, run: (ctx: CommandContext): Promise<number> => mcp.ls(ctx) },
  'mcp deploy': { spec: mcp.flagSpecs.deploy, run: mcp.deploy },
  'mcp pause': { spec: {}, run: mcp.pause },
  'mcp resume': { spec: {}, run: mcp.resume },
  'mcp rollback': { spec: {}, run: mcp.rollback },
  'mcp rm': { spec: {}, run: mcp.rm },
  deploy: { spec: mcp.flagSpecs.deploy, run: mcp.deploy }, // alias for `mcp deploy`
  // mcp dev (local SDK toolchain)
  'mcp init': { spec: mcpDev.flagSpecs.init, run: mcpDev.init },
  'mcp dev': {
    spec: mcpDev.flagSpecs.dev,
    run: (ctx: CommandContext, a: ParsedArgs): Promise<number> => mcpDev.dev(ctx, a),
  },
  'mcp logs': { spec: mcpDev.flagSpecs.logs, run: mcpDev.logs },
  // secrets
  'secret set': { spec: mcp.flagSpecs.secretSet, run: mcp.secretSet },
  'secret ls': { spec: {}, run: mcp.secretLs },
  // escape hatch
  gql: { spec: gqlCmd.flagSpecs.gql, run: gqlCmd.gql },
};

/** Global value flags (take an argument). */
const GLOBAL_VALUE_FLAGS = ['profile', 'endpoint'];
/** Global boolean flags. */
const GLOBAL_BOOL_FLAGS = ['json', 'jsonl', 'human', 'no-color', 'quiet', 'help', 'version'];

/** Inputs for {@link run} (injectable for tests). */
export interface RunOptions {
  /** The argv slice (without `node`/script). */
  argv: string[];
  /** Output sink (defaults to process stdout/stderr). */
  writer?: Writer;
  /** A fetch implementation (mocked in tests). */
  fetchImpl?: typeof fetch;
  /** Config/env overrides (tests inject `home`/`env`/`keychain`). */
  configEnv?: ConfigEnv;
  /** TTY override for format resolution (tests). */
  isTTY?: boolean;
}

/**
 * Parse argv, dispatch to the matching command, and return a process exit code.
 * This is the testable core of the CLI — it never calls `process.exit` itself;
 * the `bin` entry (`src/index.ts`) does.
 *
 * @param options - argv plus injectable writer/fetch/env.
 * @returns The resolved exit code.
 */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
  const writer = options.writer ?? defaultWriter;

  try {
    const { globals, rest } = splitGlobals(options.argv);

    if (globals.version) {
      writer.out(cliVersion());
      return ExitCode.Success;
    }
    if (rest.length === 0 || globals.help) {
      writer.out(usage());
      return ExitCode.Success;
    }

    const { command, commandArgv } = matchCommand(rest);
    if (!command) {
      throw usageError(`Unknown command: ${rest.join(' ')}\n\n${usage()}`);
    }

    const ctx = buildContext({
      globals,
      writer,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.configEnv !== undefined ? { configEnv: options.configEnv } : {}),
      ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
    });

    const args = parseArgs(commandArgv, command.spec);
    return (await command.run(ctx, args)) as ExitCodeValue;
  } catch (err) {
    return handleError(err, writer);
  }
}

/**
 * Extract the known global flags from argv wherever they appear (before or
 * after the command), leaving every other token — the command path and its own
 * flags/values — untouched and in order as `rest`. This is deliberately NOT a
 * full re-parse: command-specific value flags must keep their values, so we
 * only recognize the global flag set here and pass the rest through verbatim.
 *
 * @param argv - The raw argv slice.
 * @returns The resolved global flags plus the remaining command tokens.
 */
/** Collectors `splitGlobals` fills as it walks argv. */
interface GlobalCollectors {
  flags: Set<string>;
  values: Record<string, string>;
  rest: string[];
}

/** Apply one `--name[=value]` token to the collectors; returns extra tokens consumed. */
function applyGlobalFlag(
  token: string,
  argv: string[],
  index: number,
  collected: GlobalCollectors,
): number {
  const eq = token.indexOf('=');
  const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
  if (GLOBAL_BOOL_FLAGS.includes(name)) {
    collected.flags.add(name);
    return 0;
  }
  if (GLOBAL_VALUE_FLAGS.includes(name)) {
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const { value, consumed } = readFlagValue(argv, index, name, inline);
    collected.values[name] = value;
    return consumed;
  }
  collected.rest.push(token);
  return 0;
}

function splitGlobals(argv: string[]): { globals: GlobalFlags; rest: string[] } {
  const collected: GlobalCollectors = { flags: new Set(), values: {}, rest: [] };
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (passthrough || !token.startsWith('--')) {
      if (token === '-h') collected.flags.add('help');
      else if (token === '-v') collected.flags.add('version');
      else collected.rest.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      collected.rest.push(token);
      continue;
    }
    i += applyGlobalFlag(token, argv, i, collected);
  }

  return { globals: toGlobalFlags(collected.flags, collected.values), rest: collected.rest };
}

/** Assemble the {@link GlobalFlags} record from the collected flag sets. */
function toGlobalFlags(flags: Set<string>, values: Record<string, string>): GlobalFlags {
  return {
    json: flags.has('json'),
    jsonl: flags.has('jsonl'),
    human: flags.has('human'),
    noColor: flags.has('no-color'),
    quiet: flags.has('quiet'),
    help: flags.has('help'),
    version: flags.has('version'),
    ...(values.profile !== undefined ? { profile: values.profile } : {}),
    ...(values.endpoint !== undefined ? { endpoint: values.endpoint } : {}),
  };
}

/** Match the longest registered command path (2-token then 1-token). */
function matchCommand(tokens: string[]): { command: Command | null; commandArgv: string[] } {
  const two = tokens.slice(0, 2).join(' ');
  if (tokens.length >= 2 && COMMANDS[two]) {
    return { command: COMMANDS[two], commandArgv: tokens.slice(2) };
  }
  const one = tokens[0] ?? '';
  if (COMMANDS[one]) {
    return { command: COMMANDS[one], commandArgv: tokens.slice(1) };
  }
  return { command: null, commandArgv: [] };
}

/** Print the error to stderr and map it to an exit code. */
function handleError(err: unknown, writer: Writer): ExitCodeValue {
  if (err instanceof CliError) {
    writer.err(err.message);
    return err.code;
  }
  writer.err(err instanceof Error ? err.message : String(err));
  return ExitCode.Transport;
}

/** The top-level usage/help text. */
function usage(): string {
  return [
    'trove — the Trove command-line tool',
    '',
    'Usage: trove [--profile <name>] [--endpoint <url>] [--json|--jsonl|--human] <command> [args]',
    '',
    'Auth:    login, logout, whoami',
    'Query:   search, discover, recent, get, list, sources, source, stats',
    'Capture: save, ingest',
    'Source dev: source init|dev|test|validate|sync',
    'MCP:     mcp ls|deploy|pause|resume|rollback|rm|init|dev|logs, secret set|ls   (deploy aliased at top level)',
    'Raw:     gql <file|->',
    '',
    'Global flags: --json --jsonl --human --no-color --quiet --profile <p> --endpoint <url> --help --version',
  ].join('\n');
}

/** Exported for tests: the set of registered command paths. */
export const commandPaths = Object.keys(COMMANDS);
