/**
 * The hosted runtime entry.
 *
 * A deployed server's bundle re-exports its `defineMcpServer(...)` value as
 * `default`; the deploy pipeline wraps it with {@link toFetchHandler} (or
 * {@link dispatch} is called directly through the in-process test dispatcher).
 * The runtime POSTs `{ tool, args, ctxToken, callbackBase, userId, scopes }`
 * and reads back `tools/list` on GET.
 *
 * @module
 */

import type {
  McpServerDefinition,
  McpToolCall,
  McpToolCallResult,
  ToolListEntry,
} from './types.js';

/**
 * A minimal fetch handler shape, matching the `fetch` signature the hosted
 * runtime exposes for each request.
 */
export interface FetchHandler {
  /** Handle one HTTP request into the runtime. */
  fetch(request: Request): Promise<Response>;
}

/** JSON response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Coerce an arbitrary parsed body into an {@link McpToolCall}, filling defaults.
 *
 * @param body - The parsed request JSON.
 * @returns A normalized call, or `null` if it cannot be a tool call.
 */
function toCall(body: unknown): McpToolCall | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.tool !== 'string') return null;
  return {
    tool: b.tool,
    args: b.args ?? {},
    ctxToken: typeof b.ctxToken === 'string' ? b.ctxToken : '',
    callbackBase: typeof b.callbackBase === 'string' ? b.callbackBase : '',
    userId: typeof b.userId === 'string' ? b.userId : '',
    scopes: Array.isArray(b.scopes) ? (b.scopes as string[]) : [],
    // Absent for a toolkit that declares no settings, which is why this is `{}`
    // rather than a rejection: the field's absence is the ordinary case, not a
    // malformed call.
    config:
      b.config !== null && typeof b.config === 'object' && !Array.isArray(b.config)
        ? (b.config as Record<string, unknown>)
        : {},
  };
}

/**
 * Dispatch one normalized call against a server definition.
 *
 * This is the seam the in-process test dispatcher drives: it runs the real SDK
 * end-to-end without an isolated-sandbox boundary.
 *
 * @param server - The compiled server definition.
 * @param call - The normalized tool call.
 * @returns The normalized result.
 */
export function dispatch(
  server: McpServerDefinition,
  call: McpToolCall,
): Promise<McpToolCallResult> {
  return server.handle(call);
}

/**
 * The `tools/list` descriptors for a server.
 *
 * @param server - The compiled server definition.
 * @returns The list entries.
 */
export function listTools(server: McpServerDefinition): ReadonlyArray<ToolListEntry> {
  return server.tools;
}

/**
 * Wrap a server definition as a runtime `fetch` handler.
 *
 * - `GET  *`            → `{ tools }` (the `tools/list` corpus)
 * - `POST *`            → run the body as a tool call, returns {@link McpToolCallResult}
 *
 * Malformed JSON or a non-tool body yields a normalized `BAD_REQUEST` error
 * (HTTP 200 with `{ ok: false }`), so the caller always parses a result rather
 * than a transport error.
 *
 * @param server - The compiled server definition.
 * @returns A `fetch` handler the bundle can export as `default`.
 */
export function toFetchHandler(server: McpServerDefinition): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method === 'GET') {
        return json({ tools: server.tools });
      }
      if (request.method !== 'POST') {
        return json(
          { ok: false, error: 'method not allowed', retryable: false, code: 'BAD_REQUEST' },
          405,
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({
          ok: false,
          error: 'invalid JSON body',
          retryable: false,
          code: 'BAD_REQUEST',
        });
      }

      const call = toCall(body);
      if (call === null) {
        return json({
          ok: false,
          error: 'malformed tool call',
          retryable: false,
          code: 'BAD_REQUEST',
        });
      }

      const result = await server.handle(call);
      return json(result);
    },
  };
}
