/**
 * A minimal TOML reader/writer scoped to the Trove CLI config shape:
 * top-level string keys plus `[profiles.<name>]` tables of
 * string values. This is intentionally NOT a general TOML implementation — it
 * supports exactly the subset the config file uses (string values, bare/quoted
 * keys, `[a.b]` table headers, `#` comments) so the CLI carries no runtime
 * dependency for config I/O.
 */

/** A parsed TOML document: nested plain objects with string leaf values. */
export type TomlTable = { [key: string]: string | TomlTable };

/**
 * Parse the supported TOML subset into a nested object.
 *
 * @param text - The raw file contents.
 * @returns The parsed table.
 * @throws If a line cannot be parsed as a comment, table header, or key/value.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = stripComment(raw).trim();
    if (line === '') continue;

    const header = matchTableHeader(line);
    if (header) {
      current = ensurePath(root, header);
      continue;
    }

    const kv = matchKeyValue(line);
    if (!kv) {
      throw new Error(`Invalid TOML at line ${i + 1}: ${raw}`);
    }
    current[kv.key] = kv.value;
  }

  return root;
}

/**
 * Serialize a config table back to the supported TOML subset. Top-level string
 * keys are emitted first, then each nested table under a `[path]` header.
 *
 * @param table - The table to serialize.
 * @returns A TOML string with a trailing newline.
 */
export function stringifyToml(table: TomlTable): string {
  const out: string[] = [];
  emitTable(table, [], out);
  return `${out.join('\n').trim()}\n`;
}

/**
 * Strip an unquoted trailing `#` comment from a line, leaving `#` inside quoted
 * strings intact.
 */
function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
}

/** Match a `[a.b.c]` table header, returning the dotted path segments. */
function matchTableHeader(line: string): string[] | null {
  if (!line.startsWith('[') || !line.endsWith(']')) return null;
  const inner = line.slice(1, -1).trim();
  if (inner === '') return null;
  return inner.split('.').map((s) => unquoteKey(s.trim()));
}

/** Match a `key = "value"` (or bare value) assignment. */
function matchKeyValue(line: string): { key: string; value: string } | null {
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  const key = unquoteKey(line.slice(0, eq).trim());
  const rawValue = line.slice(eq + 1).trim();
  return { key, value: unquoteValue(rawValue) };
}

/** Remove surrounding quotes from a key, if present. */
function unquoteKey(key: string): string {
  if (key.startsWith('"') && key.endsWith('"') && key.length >= 2) {
    return key.slice(1, -1);
  }
  return key;
}

/** Decode a string value (only string values are supported). */
function unquoteValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  }
  return value;
}

/** Walk/create a nested table at the given path and return the leaf table. */
function ensurePath(root: TomlTable, path: string[]): TomlTable {
  let node = root;
  for (const segment of path) {
    const next = node[segment];
    if (typeof next === 'object' && next !== null) {
      node = next;
    } else {
      const created: TomlTable = {};
      node[segment] = created;
      node = created;
    }
  }
  return node;
}

/** Recursively emit a table and its sub-tables into `out`. */
function emitTable(table: TomlTable, path: string[], out: string[]): void {
  const scalars: string[] = [];
  const tables: Array<[string, TomlTable]> = [];

  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'string') {
      scalars.push(`${key} = ${quoteValue(value)}`);
    } else {
      tables.push([key, value]);
    }
  }

  if (path.length > 0 && scalars.length > 0) {
    out.push(`[${path.join('.')}]`);
  }
  for (const s of scalars) out.push(s);
  if (scalars.length > 0) out.push('');

  for (const [key, sub] of tables) {
    emitTable(sub, [...path, key], out);
  }
}

/** Quote/escape a string value for emission. */
function quoteValue(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}
