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

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JsonSchema } from './types.js';

/**
 * Compile a Zod schema to a JSON Schema `object` suitable for `inputSchema`.
 *
 * The schema is emitted fully inline (`$refStrategy: 'none'`), so the result is
 * a self-contained object schema with no top-level `$ref`. A non-object root
 * (e.g. `z.string()`) is rejected — tool arguments are always a named-field
 * object.
 *
 * @param schema - The Zod schema for a tool's arguments.
 * @returns A JSON Schema object with `type: 'object'`.
 * @throws {Error} If the schema does not compile to an object schema.
 */
export function compileInputSchema(schema: z.ZodTypeAny): JsonSchema {
  const compiled = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  if (compiled.type !== 'object') {
    throw new Error(
      `tool input schema must be an object (z.object({...})), got type "${String(compiled.type)}"`,
    );
  }

  // Strip the JSON-Schema `$schema` dialect marker — MCP inputSchema omits it.
  const { $schema: _dialect, ...rest } = compiled;
  return { ...rest, type: 'object' } as JsonSchema;
}
