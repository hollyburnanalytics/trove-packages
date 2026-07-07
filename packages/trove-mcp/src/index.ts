/**
 * `@ontrove/mcp` — the thin standard library for authoring hosted Trove MCP
 * servers. It owns the MCP protocol, JSON-RPC, schema validation, auth-context
 * injection, secret access, and error envelopes, so authors write only the
 * handlers (see the hosted-MCP SDK reference).
 *
 * @example
 * ```ts
 * import { defineMcpServer, z, ToolError } from "@ontrove/mcp";
 *
 * export default defineMcpServer({
 *   tools: [
 *     {
 *       name: "lookup_order",
 *       description: "Look up an internal order by ID.",
 *       input: z.object({ orderId: z.string().describe("e.g. 'ORD-10423'.") }),
 *       async handler({ orderId }, ctx) {
 *         const token = await ctx.secret("ORDERS_API_TOKEN");
 *         const res = await ctx.fetch(`https://orders.acme.internal/v1/${orderId}`, {
 *           headers: { authorization: `Bearer ${token}` },
 *         });
 *         if (res.status === 404) throw new ToolError(`Order ${orderId} not found`);
 *         return { text: `Order ${orderId}: ok`, structured: await res.json() };
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @module
 */

// Re-exported from zod so authors don't add their own dependency. `@hidden`
// keeps the generated API reference from expanding all of zod's surface; see
// the README for usage.
/** @hidden */
export { z } from 'zod';
export type { FetchLike } from './ctx.js';
export { type DefineOptions, defineMcpServer } from './define.js';
export { ToolError, type ToolErrorOptions } from './errors.js';
export {
  dispatch,
  type FetchHandler,
  listTools,
  toFetchHandler,
} from './runtime.js';
export { compileInputSchema } from './schema.js';
export type {
  FetchJsonOpts,
  JsonSchema,
  McpErrorCode,
  McpServerConfig,
  McpServerDefinition,
  McpToolCall,
  McpToolCallErr,
  McpToolCallOk,
  McpToolCallResult,
  OAuth2ClientCredentials,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
  ToolListEntry,
  ToolResult,
  TroveClient,
  TroveDocument,
  TroveIngestDoc,
  TroveIngestResult,
  TroveSearchOpts,
  TroveSearchResult,
} from './types.js';
