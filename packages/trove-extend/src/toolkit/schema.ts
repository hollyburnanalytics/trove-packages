/**
 * Zod → JSON Schema compilation for `tools/list`.
 *
 * Authors declare tool arguments with Zod; the SDK lifts the schema (including
 * `.describe(...)` text the model reads) into the `inputSchema` JSON Schema
 * returned in `tools/list`. Compilation is deterministic and happens at deploy
 * time, not in the per-request hot path — the runtime only runs a thin
 * `safeParse` guard before the handler.
 *
 * @module
 */

import * as z from 'zod';
import type { JsonSchema } from './types.js';

/**
 * Convert a Zod schema to a draft-7 JSON Schema, inlining any reused subschemas.
 *
 * `reused: 'inline'` keeps the output free of `$defs`/`$ref` — MCP clients read
 * `inputSchema` directly and a reference to a definition they have to resolve is
 * a needless hurdle. `io: 'input'` describes what a caller PASSES, which is the
 * side of a transform a tool's arguments are on.
 */
function toJsonSchema7(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    reused: 'inline',
    io: 'input',
  }) as Record<string, unknown>;
}

/**
 * Compile a Zod schema to a JSON Schema `object` suitable for `inputSchema`.
 *
 * The schema is emitted fully inline, so the result is a self-contained object
 * schema with no top-level `$ref`. A non-object root (e.g. `z.string()`) is
 * rejected — tool arguments are always a named-field object.
 *
 * @param schema - The Zod schema for a tool's arguments.
 * @returns A JSON Schema object with `type: 'object'`.
 * @throws {Error} If the schema does not compile to an object schema.
 */
export function compileInputSchema(schema: z.ZodType): JsonSchema {
  const compiled = toJsonSchema7(schema);

  if (compiled.type !== 'object') {
    throw new Error(
      `tool input schema must be an object (z.object({...})), got type "${String(compiled.type)}"`,
    );
  }

  // Strip the JSON-Schema `$schema` dialect marker — MCP inputSchema omits it.
  const { $schema: _dialect, ...rest } = compiled;
  // Default the root to a closed object: a tool that quietly accepts unknown
  // arguments cannot tell a typo from a feature. An explicit value from the
  // converter (a loose object → `true`) still wins, because `rest` spreads after.
  return { additionalProperties: false, ...rest, type: 'object' } as JsonSchema;
}
