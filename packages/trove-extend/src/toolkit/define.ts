/**
 * `defineToolkit` — the single entry point for authoring a hosted server.
 *
 * It validates the tool definitions, compiles each Zod `input` to JSON Schema
 * for `tools/list`, and produces a normalized request handler that, given a
 * `{ tool, args, ctxToken, callbackBase }` call, validates args against the
 * schema and invokes the handler with a built {@link ToolContext}. `ToolError`
 * and any uncaught throw become a normalized error envelope — never a stack
 * trace to the model.
 *
 * @module
 */

import type { z } from 'zod';
import { buildCtx, type FetchLike } from './ctx.js';
import { ToolError } from './errors.js';
import { redactSecrets } from './redact.js';
import { compileInputSchema } from './schema.js';
import type {
  OAuth2ClientCredentials,
  ToolAnnotations,
  ToolCall,
  ToolCallResult,
  ToolContext,
  ToolDefinition,
  ToolkitConfig,
  ToolkitDefinition,
  ToolListEntry,
  ToolResult,
} from './types.js';

/** Tool names must match this pattern: `[a-zA-Z0-9_-]+`. */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Eagerly validate the optional declarative `auth` block so `trove deploy`
 * fails fast on a malformed config rather than at first call.
 *
 * @param auth - The auth config, if any.
 * @throws {Error} If the auth block is present but malformed.
 */
function validateAuth(auth: OAuth2ClientCredentials | undefined): void {
  if (auth === undefined) return;
  if (auth.type !== 'oauth2_client_credentials') {
    throw new Error(`unsupported auth.type: ${String((auth as { type?: unknown }).type)}`);
  }
  for (const field of ['tokenUrl', 'clientIdSecret', 'clientSecretSecret'] as const) {
    if (typeof auth[field] !== 'string' || auth[field].length === 0) {
      throw new Error(`auth.${field} must be a non-empty string`);
    }
  }
  // apiHost is required: it scopes the auto-attached Bearer to exactly one host.
  // Without it the token could be attached to every egress target.
  if (typeof auth.apiHost !== 'string' || auth.apiHost.length === 0) {
    throw new Error('auth.apiHost must be a non-empty string (the host the Bearer is scoped to)');
  }
}

/** The Trove write scope that signals a server mutates state. */
const INGEST_SCOPE = 'trove:ingest';

/**
 * Derive the `tools/list` annotations for one tool, filling unspecified hints
 * with conservative defaults so a tool is annotated correctly by construction.
 *
 * Heuristic (an explicit author value ALWAYS wins, field by field):
 * - `readOnlyHint` defaults to `true` UNLESS the tool declares write intent —
 *   either `mutating: true`, or the server's manifest `scopes` include
 *   `trove:ingest`. A write-intent tool defaults to `readOnlyHint: false`.
 * - When the resolved tool is read-only, `destructiveHint` and `openWorldHint`
 *   default to `false` (a reader neither destroys nor reaches the open world);
 *   `idempotentHint` is left to the author (reads are idempotent but the spec
 *   only treats this hint as meaningful for writes).
 * - When the resolved tool is NOT read-only, the non-read-only hints are left to
 *   the author (the SDK never invents a destructive/open-world claim).
 *
 * @param tool - The authored tool definition.
 * @param serverWrites - Whether the server manifest declares a write scope.
 * @returns The fully-resolved annotations for the `tools/list` entry.
 */
function deriveAnnotations(tool: ToolDefinition, serverWrites: boolean): ToolAnnotations {
  const author = tool.annotations ?? {};
  const writeIntent = tool.mutating === true || serverWrites;
  const readOnly = author.readOnlyHint ?? !writeIntent;

  const annotations: ToolAnnotations = { readOnlyHint: readOnly };
  if (author.destructiveHint !== undefined) {
    annotations.destructiveHint = author.destructiveHint;
  } else if (readOnly) {
    annotations.destructiveHint = false;
  }
  if (author.openWorldHint !== undefined) {
    annotations.openWorldHint = author.openWorldHint;
  } else if (readOnly) {
    annotations.openWorldHint = false;
  }
  if (author.idempotentHint !== undefined) {
    annotations.idempotentHint = author.idempotentHint;
  }
  return annotations;
}

/**
 * Options for {@link defineToolkit} — primarily injection points for tests.
 */
export interface DefineOptions {
  /** Override the fetch implementation used by `ctx` callbacks/egress. */
  fetchImpl?: FetchLike;
}

/**
 * Normalize a handler return (`ToolResult | string`) to a {@link ToolResult}.
 *
 * @param value - The raw handler return value.
 * @returns A `ToolResult` with a string `text`.
 * @throws {Error} If the value is neither a string nor a `{ text }` object.
 */
function normalizeResult(value: ToolResult | string): ToolResult {
  if (typeof value === 'string') {
    return { text: value };
  }
  if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
    return value.structured === undefined
      ? { text: value.text }
      : { text: value.text, structured: value.structured };
  }
  throw new Error('handler must return a string or an object with a string `text` field');
}

/**
 * Validate the authored tool definitions and compile their schemas.
 *
 * @param tools - The authored tool definitions.
 * @param serverWrites - Whether the server manifest declares a write scope.
 * @returns A map of name → definition and the `tools/list` entries.
 * @throws {Error} On empty/duplicate/invalid tool definitions.
 */
/** Throw unless one authored tool definition is structurally valid. */
function assertValidTool(tool: ToolDefinition, registry: Map<string, ToolDefinition>): void {
  if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
    throw new Error(`defineToolkit: invalid tool name "${String(tool.name)}"`);
  }
  if (registry.has(tool.name)) {
    throw new Error(`defineToolkit: duplicate tool name "${tool.name}"`);
  }
  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    throw new Error(`defineToolkit: tool "${tool.name}" needs a non-empty description`);
  }
  if (typeof tool.handler !== 'function') {
    throw new Error(`defineToolkit: tool "${tool.name}" needs a handler function`);
  }
  if (tool.input === undefined || typeof tool.input.safeParse !== 'function') {
    throw new Error(`defineToolkit: tool "${tool.name}" needs a Zod schema for \`input\``);
  }
  if (tool.output !== undefined && typeof tool.output.safeParse !== 'function') {
    throw new Error(`defineToolkit: tool "${tool.name}" \`output\` must be a Zod schema`);
  }
}

/** Build the `tools/list` entry for one validated tool. */
function toListEntry(tool: ToolDefinition, serverWrites: boolean): ToolListEntry {
  const entry: ToolListEntry = {
    name: tool.name,
    description: tool.description,
    inputSchema: compileInputSchema(tool.input),
    annotations: deriveAnnotations(tool, serverWrites),
  };
  if (typeof tool.title === 'string' && tool.title.length > 0) entry.title = tool.title;
  if (tool.output !== undefined) entry.outputSchema = compileInputSchema(tool.output);
  if (tool.alwaysOn !== undefined) entry.alwaysOn = tool.alwaysOn;
  if (tool.mutating !== undefined) entry.mutating = tool.mutating;
  return entry;
}

function compileTools(
  tools: ReadonlyArray<ToolDefinition>,
  serverWrites: boolean,
): {
  registry: Map<string, ToolDefinition>;
  list: ToolListEntry[];
} {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('defineToolkit: `tools` must be a non-empty array');
  }

  const registry = new Map<string, ToolDefinition>();
  const list: ToolListEntry[] = [];
  for (const tool of tools) {
    assertValidTool(tool, registry);
    registry.set(tool.name, tool);
    list.push(toListEntry(tool, serverWrites));
  }
  return { registry, list };
}

/**
 * Run one tool handler inside a try/catch, normalizing the outcome.
 *
 * When the tool declares an `output` schema and the handler returned a
 * `structured` value, that value is also surfaced as the spec
 * `structuredContent` on the success envelope (alongside the `text` mirror in
 * `result`), so a host can lift it straight into the `tools/call` result.
 *
 * @param tool - The resolved tool definition.
 * @param args - The validated arguments.
 * @param ctx - The built capability object.
 * @param logBuffer - The per-invocation log buffer (for error detail).
 * @returns A normalized success or error result.
 */
async function runHandler(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
  logBuffer: unknown[][],
  knownSecrets: ReadonlySet<string>,
): Promise<ToolCallResult> {
  try {
    const raw = await tool.handler(args, ctx);
    const result = normalizeResult(raw);
    if (tool.output !== undefined && result.structured !== undefined) {
      // The declared schema was validated as a SCHEMA at compile time and then
      // never used. `structuredContent` went to the host unchecked, so a tool
      // could contradict its own advertised output and nothing — types or
      // runtime — would notice. Input has always been parsed here; output now
      // is too, and the asymmetry was never intentional.
      const checked = tool.output.safeParse(result.structured);
      if (!checked.success) {
        return {
          ok: false,
          error: `"${tool.name}" returned structured output that does not match its declared schema: ${checked.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
          // Not retryable: the handler and its schema disagree, and calling it
          // again produces the same disagreement.
          retryable: false,
          code: 'TOOL_ERROR',
        };
      }
      return { ok: true, result, structuredContent: checked.data };
    }
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: err.message, retryable: err.retryable, code: 'TOOL_ERROR' };
    }
    // Uncaught: keep full detail in the logs (redacted against resolved secrets),
    // return a generic message.
    logBuffer.push(redactSecrets(['handler error', err], knownSecrets) as unknown[]);
    return { ok: false, error: 'tool failed', retryable: false, code: 'TOOL_ERROR' };
  }
}

/**
 * Define a hosted MCP server from a set of tool definitions.
 *
 * The returned {@link ToolkitDefinition} exposes the compiled `tools/list`
 * descriptors and a `handle(call)` that the runtime entry wires to the
 * hosted runtime's `fetch`. Authoring errors (empty/duplicate/invalid tools,
 * non-object schemas) throw eagerly so `trove deploy` can statically validate.
 *
 * @param config - The `{ tools }` configuration.
 * @param options - Optional injection points (test fetch).
 * @returns The compiled server definition.
 */

/** A bare lowercase hostname, optionally with a port. Mirrors the source rule. */
const TOOLKIT_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/;

/**
 * Check who the toolkit says it is.
 *
 * Eager, and at definition time, for the same reason the source side is: the
 * manifest is generated from this, so a mistake here is a mistake in a
 * published artifact. Every toolkit manifest in the catalogs carried an `sdk`
 * field naming a version of a package nobody read, precisely because nothing
 * ever checked it.
 *
 * @param config - The toolkit configuration.
 * @param errors - Accumulator for human-readable errors.
 */
function checkIdentity(config: ToolkitConfig, errors: string[]): void {
  if (!/^[a-z0-9-]+$/.test(config.id ?? '')) {
    errors.push(`id ${JSON.stringify(config.id)} must match /^[a-z0-9-]+$/`);
  }
  for (const field of ['name', 'description', 'icon', 'version'] as const) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      errors.push(`${field} is required and must be a non-empty string`);
    }
  }
  if (typeof config.version === 'string' && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(config.version)) {
    errors.push(`version ${JSON.stringify(config.version)} is not a semver string`);
  }
  // `shared`, not `public`: the value is stored as the GraphQL
  // `McpServerVisibility` enum, whose members are PRIVATE and SHARED. This
  // accepted `public` while the schema accepted `SHARED` and nothing
  // translated, so the field could never be checked end to end.
  if (config.visibility !== undefined && !['shared', 'private'].includes(config.visibility)) {
    errors.push(`visibility ${JSON.stringify(config.visibility)} must be "shared" or "private"`);
  }
}

/**
 * Check the lists a toolkit declares: credential NAMES, and reachable hosts.
 *
 * @param config - The toolkit configuration.
 * @param errors - Accumulator for human-readable errors.
 */
function checkDeclaredLists(config: ToolkitConfig, errors: string[]): void {
  for (const name of config.secrets ?? []) {
    // A NAME, never a value. A secret in a manifest is a secret in a repo, and
    // the shape of the field is the only thing standing between the two.
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      errors.push(`secrets entry ${JSON.stringify(name)} must be a NAME (UPPER_SNAKE_CASE)`);
    }
  }
  for (const host of config.egress ?? []) {
    if (!TOOLKIT_HOST.test(host)) {
      errors.push(`egress entry ${JSON.stringify(host)} is not a bare hostname (optional :port)`);
    }
  }
}

/**
 * Validate the toolkit's own declaration — the half that becomes its manifest.
 *
 * @param config - The toolkit configuration.
 * @throws {Error} With every problem found, not just the first.
 */
function validateToolkitManifest(config: ToolkitConfig): void {
  const errors: string[] = [];
  checkIdentity(config, errors);
  checkDeclaredLists(config, errors);
  if (errors.length > 0) {
    throw new Error(
      `defineToolkit: ${config.id ?? '(no id)'} has an invalid declaration:\n  ${errors.join('\n  ')}`,
    );
  }
}

/**
 * The manifest half of a toolkit, as the JSON a catalog commits.
 *
 * `tools`, `auth` and the handlers are left out: a manifest describes what the
 * toolkit IS, and the tool list is read from the deployed server itself.
 *
 * @param config - The toolkit configuration.
 * @returns The manifest fields, plus the `generated` marker.
 */
export function toToolkitManifest(config: ToolkitConfig): Record<string, unknown> {
  const { tools: _tools, auth: _auth, ...manifest } = config;
  return { ...manifest, generated: true };
}

export function defineToolkit(
  config: ToolkitConfig,
  options: DefineOptions = {},
): ToolkitDefinition {
  const serverWrites = (config.scopes ?? []).some((s) => s === INGEST_SCOPE);
  validateToolkitManifest(config);
  validateAuth(config.auth);
  const { registry, list } = compileTools(config.tools, serverWrites);
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((url: string | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init));

  async function handle(call: ToolCall): Promise<ToolCallResult> {
    if (call === null || typeof call !== 'object' || typeof call.tool !== 'string') {
      return { ok: false, error: 'malformed tool call', retryable: false, code: 'BAD_REQUEST' };
    }

    const tool = registry.get(call.tool);
    if (tool === undefined) {
      return {
        ok: false,
        error: `unknown tool "${call.tool}"`,
        retryable: false,
        code: 'UNKNOWN_TOOL',
      };
    }

    const parsed = tool.input.safeParse(call.args);
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid arguments for "${call.tool}": ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
        retryable: false,
        code: 'INVALID_PARAMS',
      };
    }

    const logBuffer: unknown[][] = [];
    const knownSecrets = new Set<string>();
    const ctx = buildCtx({
      userId: call.userId,
      ...(call.config !== undefined && { config: call.config }),
      ctxToken: call.ctxToken,
      callbackBase: call.callbackBase,
      troveEnabled: (call.scopes ?? []).some((s) => s === 'trove:search' || s === 'trove:ingest'),
      fetchImpl,
      logSink: (args: unknown[]): void => {
        logBuffer.push(args);
      },
      knownSecrets,
      ...(config.auth ? { auth: config.auth } : {}),
      ...(config.egress ? { egress: config.egress } : {}),
    });

    return runHandler(tool, parsed.data, ctx, logBuffer, knownSecrets);
  }

  // The manifest travels with the compiled server so a catalog can check its
  // committed `manifest.json` against the declaration that produced it.
  // Without this the config is unreachable once `defineToolkit` returns, which
  // is why `toToolkitManifest` shipped with no callers.
  return { tools: list, manifest: toToolkitManifest(config), handle };
}

/**
 * Identity helper that keeps a tool's schema type, so its handler's arguments
 * are typed for real.
 *
 * `tools` is an array, and TypeScript does not infer a generic per array
 * element — every entry falls back to {@link ToolDefinition}'s default and the
 * handler receives `any`. That has always been true here; Zod 3 hid it because
 * its `ZodTypeAny` default WAS `any`, so nothing complained.
 *
 * Wrapping one definition restores the inference, because the generic is then
 * captured at the call:
 *
 * ```ts
 * tools: [
 *   tool({
 *     name: 'search',
 *     description: 'Search.',
 *     input: z.object({ query: z.string() }),
 *     async handler(args) {
 *       return args.query.toUpperCase(); // typed, not `any`
 *     },
 *   }),
 * ]
 * ```
 *
 * Purely a type-level device: it returns its argument untouched, costs nothing
 * at runtime, and is opt-in per tool.
 *
 * @param definition - The tool definition.
 * @returns The same definition, with its schema types preserved.
 */
export function tool<I extends z.ZodType, O extends z.ZodType>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return definition;
}
