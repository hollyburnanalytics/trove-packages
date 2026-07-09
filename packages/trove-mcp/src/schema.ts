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
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JsonSchema } from './types.js';

/**
 * Zod 4 ships a native `z.toJSONSchema`; Zod 3 does not (and its internal schema
 * format is incompatible with the `zod-to-json-schema` package's Zod-4 path).
 * Detect the runtime peer at load time and pick the matching converter, so both
 * `zod@^3.25` and `zod@^4` produce an equivalent inline JSON Schema 7 object.
 */
const nativeToJsonSchema: unknown = (z as { toJSONSchema?: unknown }).toJSONSchema;

/** Convert a Zod schema to a draft-7 JSON Schema, inlining any reused subschemas. */
function toJsonSchema7(schema: z.ZodTypeAny): Record<string, unknown> {
  if (typeof nativeToJsonSchema === 'function') {
    // Zod 4: `reused: 'inline'` matches the Zod-3 `$refStrategy: 'none'` behaviour
    // (no `$defs`/`$ref`); `io: 'input'` describes what a caller passes in.
    return (nativeToJsonSchema as (s: unknown, o?: unknown) => Record<string, unknown>)(schema, {
      target: 'draft-7',
      reused: 'inline',
      io: 'input',
    });
  }
  // Zod 3.
  return zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
}

/**
 * Compile a Zod schema to a JSON Schema `object` suitable for `inputSchema`.
 *
 * The schema is emitted fully inline, so the result is a self-contained object
 * schema with no top-level `$ref`. A non-object root (e.g. `z.string()`) is
 * rejected — tool arguments are always a named-field object. Works with both
 * `zod@^3.25` and `zod@^4`.
 *
 * @param schema - The Zod schema for a tool's arguments.
 * @returns A JSON Schema object with `type: 'object'`.
 * @throws {Error} If the schema does not compile to an object schema.
 */
export function compileInputSchema(schema: z.ZodTypeAny): JsonSchema {
  const compiled = toJsonSchema7(schema);

  if (compiled.type !== 'object') {
    throw new Error(
      `tool input schema must be an object (z.object({...})), got type "${String(compiled.type)}"`,
    );
  }

  // Strip the JSON-Schema `$schema` dialect marker — MCP inputSchema omits it.
  const { $schema: _dialect, ...rest } = compiled;
  // Default the root to a closed object (`additionalProperties: false`) so the
  // contract is identical across Zod versions — Zod 3's `zod-to-json-schema`
  // emits this, Zod 4's native converter does not. An explicit value from the
  // converter (e.g. `.passthrough()`/`.loose()` → `true`) still wins.
  return { additionalProperties: false, ...rest, type: 'object' } as JsonSchema;
}
