---
'@ontrove/mcp': minor
'@ontrove/cli': minor
'@ontrove/sdk': minor
---

Enforce declared `output` schemas.

A tool's `output` schema was inert. `compileTools` checked it was a real
schema, and then nothing ever used it: `ToolResult.structured` was typed
`unknown` regardless of `O`, and `runHandler` passed `result.structured`
straight through as `structuredContent` without parsing it. Input had always
been validated. The asymmetry was never deliberate — a tool could contradict its
own advertised output and neither the compiler nor the runtime would notice.

Now both ends check:

- **Types.** `ToolResult<S>` carries the structured shape, and `handler` returns
  `ToolResult<NoInfer<z.infer<O>>>`. `NoInfer` is load-bearing: without it `O`
  would also be inferred FROM the returned value, so schema and value would
  agree by construction and check nothing.
- **Runtime.** `runHandler` parses `structured` against `output` and surfaces the
  PARSED value, so declared coercions apply. A mismatch is a non-retryable
  `TOOL_ERROR` naming the offending path — the handler and its schema disagree,
  and calling again produces the same disagreement.

Only tools that declare an `output` AND are wrapped in `tool()` are type-checked;
the generic has to be captured somewhere to mean anything. Everything else is
unaffected.

Also tightens `ToolDefinition`'s defaults from `z.ZodType<any>` to `z.ZodType`.
The `any` was a compatibility shim for definitions written inline in the `tools`
array, which get the defaults because TS does not infer a generic per array
element — it reproduced Zod 3's `ZodTypeAny`, and it is the reason handler
arguments compiled for years without being checked. Both integration repos are
now fully on `tool()`, so nothing depends on it, and an inline definition fails
immediately and visibly instead of silently opting out of typing. `tool()` is a
one-word fix at the definition site.
