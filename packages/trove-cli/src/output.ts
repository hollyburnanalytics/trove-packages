/**
 * The presentation layer. A single module turns a GraphQL
 * `data` object into either a human view (tables/records, `[doc:ID]` handles,
 * color) or machine output (`--json`/`--jsonl`). The format rules (TTY
 * detection, color, auto-JSON-when-piped) are global and live here.
 *
 * Data goes to **stdout**; diagnostics/chrome go to **stderr**.
 */

/** The output format selected for a command. */
export type OutputFormat = 'human' | 'json' | 'jsonl';

/** Global presentation options resolved from flags + environment. */
export interface OutputOptions {
  /** The resolved format. */
  format: OutputFormat;
  /** Whether ANSI color is enabled. */
  color: boolean;
  /** Whether to suppress non-error stderr chrome (`--quiet`). */
  quiet: boolean;
}

/** Raw flags that influence format selection. */
export interface FormatFlags {
  json?: boolean;
  jsonl?: boolean;
  human?: boolean;
  noColor?: boolean;
  quiet?: boolean;
}

/** Environment inputs for format/color resolution (injected for tests). */
export interface FormatEnv {
  /** Whether stdout is a TTY (defaults to `process.stdout.isTTY`). */
  isTTY?: boolean;
  /** Process env (defaults to `process.env`); reads `NO_COLOR`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the effective output options from flags and environment, applying the
 * documented precedence:
 * - explicit `--jsonl` > `--json` > `--human`;
 * - otherwise auto-`json` when stdout is **not** a TTY (the "right thing in a
 *   pipe" default), else `human`;
 * - color on only for a TTY with `NO_COLOR` unset and `--no-color` absent.
 *
 * @param flags - The format flags.
 * @param env - TTY/env inputs.
 * @returns The resolved {@link OutputOptions}.
 */
export function resolveOutput(flags: FormatFlags, env: FormatEnv = {}): OutputOptions {
  const isTTY = env.isTTY ?? Boolean(process.stdout.isTTY);
  const processEnv = env.env ?? process.env;

  let format: OutputFormat;
  if (flags.jsonl) format = 'jsonl';
  else if (flags.json) format = 'json';
  else if (flags.human) format = 'human';
  else format = isTTY ? 'human' : 'json';

  const color = isTTY && !flags.noColor && !processEnv.NO_COLOR && format === 'human';

  return { format, color, quiet: Boolean(flags.quiet) };
}

/** ANSI styling helpers, gated by {@link OutputOptions.color}. */
export class Style {
  /** @param enabled - Whether color is on. */
  constructor(private readonly enabled: boolean) {}

  /** Bold. */
  bold(s: string): string {
    return this.wrap(s, 1, 22);
  }
  /** Dim/grey. */
  dim(s: string): string {
    return this.wrap(s, 2, 22);
  }
  /** Cyan (used for handles/ids). */
  cyan(s: string): string {
    return this.wrap(s, 36, 39);
  }
  /** Green (success). */
  green(s: string): string {
    return this.wrap(s, 32, 39);
  }
  /** Yellow (warnings). */
  yellow(s: string): string {
    return this.wrap(s, 33, 39);
  }

  private wrap(s: string, open: number, close: number): string {
    return this.enabled ? `[${open}m${s}[${close}m` : s;
  }
}

/** A writable sink (stdout/stderr), injectable for tests. */
export interface Writer {
  /** Write data to stdout. */
  out(line: string): void;
  /** Write a diagnostic line to stderr. */
  err(line: string): void;
}

/** The default writer backed by `process.stdout`/`process.stderr`. */
export const defaultWriter: Writer = {
  out(line: string): void {
    process.stdout.write(`${line}\n`);
  },
  err(line: string): void {
    process.stderr.write(`${line}\n`);
  },
};

/**
 * Render a `data` value as machine JSON. For `--jsonl`, an array is emitted as
 * one object per line; otherwise the whole value is pretty-printed.
 *
 * @param value - The value to render.
 * @param format - The machine format (`json` or `jsonl`).
 * @returns The string to write to stdout.
 */
export function renderJson(value: unknown, format: 'json' | 'jsonl'): string {
  if (format === 'jsonl' && Array.isArray(value)) {
    return value.map((item) => JSON.stringify(item)).join('\n');
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Render a list of rows as an aligned text table with a header.
 *
 * @param headers - Column headers.
 * @param rows - Row cells (already stringified).
 * @param style - Styling helper for the header.
 * @returns The rendered table.
 */
export function renderTable(headers: string[], rows: string[][], style: Style): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const pad = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const head = style.bold(pad(headers));
  const body = rows.map(pad);
  return [head, ...body].join('\n');
}

/**
 * Render an aligned key/value record for a single object.
 *
 * @param entries - `[key, value]` pairs in display order.
 * @param style - Styling helper for the keys.
 * @returns The rendered record.
 */
export function renderRecord(entries: Array<[string, string]>, style: Style): string {
  const keyWidth = Math.max(0, ...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${style.dim(`${k}:`.padEnd(keyWidth + 1))} ${v}`).join('\n');
}

/** Build the `[doc:ID]` handle echoing the MCP output convention. */
export function docHandle(id: string, style: Style): string {
  return style.cyan(`[doc:${id}]`);
}

/** Truncate a string to `n` characters with an ellipsis. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}
