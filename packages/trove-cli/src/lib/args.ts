import { usageError } from '../errors.js';

/**
 * A tiny, dependency-free argv parser for command-specific flags. The top-level
 * dispatcher (`src/cli.ts`) already split off the global flags and the
 * subcommand path; this parses the remaining tokens for a single command.
 *
 * Supports: `--flag value`, `--flag=value`, boolean `--flag`, repeatable flags
 * (collected into arrays), `-` and `--` passthrough, and positional arguments.
 */

/** A parsed set of flags + positionals for one command. */
export interface ParsedArgs {
  /** Positional (non-flag) arguments in order. */
  positionals: string[];
  /** All flag values, each collected as an array (last-wins for scalars). */
  flags: Record<string, string[]>;
  /** Boolean flags that appeared with no value. */
  bools: Set<string>;
}

/** Declares how a flag is treated (value vs boolean). */
export interface FlagSpec {
  /** Flags that take a value (`--limit 10`). */
  value?: string[];
  /** Boolean flags (`--create`). */
  boolean?: string[];
  /** Single-letter aliases mapped to long names (`{ l: 'limit' }`). */
  alias?: Record<string, string>;
}

/**
 * Read a value flag's value: the inline `--name=value` part when present,
 * else the following token. Returns how many extra tokens were consumed so
 * the caller can advance its loop index.
 *
 * @throws {@link CliError} (usage) when the value is missing.
 */
export function readFlagValue(
  argv: string[],
  index: number,
  name: string,
  inlineValue: string | null,
): { value: string; consumed: number } {
  if (inlineValue !== null) return { value: inlineValue, consumed: 0 };
  const next = argv[index + 1];
  if (next === undefined) throw usageError(`Flag --${name} requires a value.`);
  return { value: next, consumed: 1 };
}

/**
 * Parse a command's argv slice into {@link ParsedArgs}.
 *
 * @param argv - The tokens after the command path (no global flags).
 * @param spec - Which flags take values vs are booleans.
 * @returns The parsed arguments.
 * @throws {@link CliError} (usage) when a value flag is missing its value.
 */
/** A flag token split into its alias-resolved name and inline `=value` (if any). */
function splitFlagToken(
  token: string,
  alias: Record<string, string>,
): { name: string; inline: string | null } {
  const eq = token.indexOf('=');
  const prefixLen = token.startsWith('--') ? 2 : 1;
  const rawName = (eq === -1 ? token.slice(prefixLen) : token.slice(prefixLen, eq)) || '';
  return { name: alias[rawName] ?? rawName, inline: eq === -1 ? null : token.slice(eq + 1) };
}

/** Apply one flag token to the collectors; returns extra tokens consumed. */
function applyFlag(
  token: string,
  argv: string[],
  index: number,
  spec: { valueFlags: Set<string>; boolFlags: Set<string>; alias: Record<string, string> },
  out: { push: (name: string, value: string) => void; bools: Set<string> },
): number {
  const { name, inline } = splitFlagToken(token, spec.alias);
  if (spec.boolFlags.has(name)) {
    out.bools.add(name);
    return 0;
  }
  if (spec.valueFlags.has(name)) {
    const { value, consumed } = readFlagValue(argv, index, name, inline);
    out.push(name, value);
    return consumed;
  }
  if (inline !== null) {
    // Unknown `--x=y` flag: keep it leniently as a string flag.
    out.push(name, inline);
    return 0;
  }
  out.bools.add(name);
  return 0;
}

export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const flagSpec = {
    valueFlags: new Set(spec.value ?? []),
    boolFlags: new Set(spec.boolean ?? []),
    alias: spec.alias ?? {},
  };

  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  const push = (name: string, value: string): void => {
    const list = flags[name] ?? [];
    list.push(value);
    flags[name] = list;
  };
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (passthrough || !isFlagToken(token)) {
      positionals.push(token);
      continue;
    }
    i += applyFlag(token, argv, i, flagSpec, { push, bools });
  }

  return { positionals, flags, bools };
}

/** Whether a token is a long (`--x`) or short (`-x`, not `-`) flag. */
function isFlagToken(token: string): boolean {
  if (token.startsWith('--')) return true;
  return token.startsWith('-') && token.length > 1 && token !== '-';
}

/** Get the last value of a scalar flag, or undefined. */
export function flag(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.flags[name];
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

/** Get all values of a repeatable flag. */
export function flagList(parsed: ParsedArgs, name: string): string[] {
  return parsed.flags[name] ?? [];
}

/** Whether a boolean flag is set. */
export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.bools.has(name);
}

/** Parse a flag value as an integer, throwing a usage error if non-numeric. */
export function intFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = flag(parsed, name);
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw usageError(`Flag --${name} must be an integer (got '${value}').`);
  return n;
}
