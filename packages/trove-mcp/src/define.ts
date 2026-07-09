/**
 * `defineMcpServer` — the single entry point for authoring a hosted server.
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

import { buildCtx, type FetchLike } from './ctx.js';
import { ToolError } from './errors.js';
import { redactSecrets } from './redact.js';
import { compileInputSchema } from './schema.js';
import type {
  McpServerConfig,
  McpServerDefinition,
  McpToolCall,
  McpToolCallResult,
  OAuth2ClientCredentials,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
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
 * Options for {@link defineMcpServer} — primarily injection points for tests.
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
    throw new Error(`defineMcpServer: invalid tool name "${String(tool.name)}"`);
  }
  if (registry.has(tool.name)) {
    throw new Error(`defineMcpServer: duplicate tool name "${tool.name}"`);
  }
  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    throw new Error(`defineMcpServer: tool "${tool.name}" needs a non-empty description`);
  }
  if (typeof tool.handler !== 'function') {
    throw new Error(`defineMcpServer: tool "${tool.name}" needs a handler function`);
  }
  if (tool.input === undefined || typeof tool.input.safeParse !== 'function') {
    throw new Error(`defineMcpServer: tool "${tool.name}" needs a Zod schema for \`input\``);
  }
  if (tool.output !== undefined && typeof tool.output.safeParse !== 'function') {
    throw new Error(`defineMcpServer: tool "${tool.name}" \`output\` must be a Zod schema`);
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
    throw new Error('defineMcpServer: `tools` must be a non-empty array');
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
): Promise<McpToolCallResult> {
  try {
    const raw = await tool.handler(args, ctx);
    const result = normalizeResult(raw);
    if (tool.output !== undefined && result.structured !== undefined) {
      return { ok: true, result, structuredContent: result.structured };
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
 * The returned {@link McpServerDefinition} exposes the compiled `tools/list`
 * descriptors and a `handle(call)` that the runtime entry wires to the
 * hosted runtime's `fetch`. Authoring errors (empty/duplicate/invalid tools,
 * non-object schemas) throw eagerly so `trove deploy` can statically validate.
 *
 * @param config - The `{ tools }` configuration.
 * @param options - Optional injection points (test fetch).
 * @returns The compiled server definition.
 */
export function defineMcpServer(
  config: McpServerConfig,
  options: DefineOptions = {},
): McpServerDefinition {
  const serverWrites = (config.scopes ?? []).some((s) => s === INGEST_SCOPE);
  validateAuth(config.auth);
  const { registry, list } = compileTools(config.tools, serverWrites);
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((url: string | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init));

  async function handle(call: McpToolCall): Promise<McpToolCallResult> {
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

  return { tools: list, handle };
}
