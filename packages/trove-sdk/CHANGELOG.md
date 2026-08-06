# @ontrove/sdk

## 0.9.0

### Minor Changes

- da907d9: Enforce declared `output` schemas.

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

- 9cf21dd: Require Zod 4.

  The SDK claimed `zod: ^3.25.28 || ^4` and only half meant it. The runtime
  genuinely worked on both — it detected `z.toJSONSchema` and picked a converter —
  but the TYPES were Zod 3's: tool inputs were constrained with `z.ZodTypeAny`,
  which Zod 4 removed. On Zod 4 that constraint stopped resolving, `I` fell back to
  its default, and `z.infer<I>` became `unknown`.

  It failed silently, which is the part worth fixing. A consumer on Zod 4 did not
  get an error at install or a broken build — they got handlers whose arguments
  were `unknown`, reported as errors in their own code. One repo carried 110 of
  those before anyone traced them here.

  So: `z.ZodTypeAny` → `z.ZodType` (the name that exists in both), the peer range
  narrows to `^4`, and the Zod 3 branch goes with it — including the
  `zod-to-json-schema` dependency, now that `z.toJSONSchema` is always there. A
  consumer still on Zod 3 now fails at install, loudly, instead of at typecheck,
  mysteriously.

  Migrating: most Zod 3 schemas need no change. `.passthrough()`, `z.url()` and
  two-argument `z.record()` all work as before; the common break is one-argument
  `z.record(v)`, which Zod 4 requires be written `z.record(z.string(), v)`.

## 0.8.0

## 0.7.0

## 0.6.0

## 0.5.0

### Patch Changes

- 12ff00e: Docs: align README one-liners to the v2 positioning — lead with "the tools you give Claude" (capabilities Claude doesn't have on its own), not the knowledge base. No API changes.

## 0.4.0

## 0.3.3

### Patch Changes

- 2a3e59b: Publishes now include a signed npm provenance attestation, so consumers can
  cryptographically verify each tarball was built and published from this repo's
  release workflow at a specific commit.

## 0.3.2

## 0.3.1

## 0.3.0

### Minor Changes

- dbf6fa1: Product-taxonomy renames: connectors are now **sources** (their per-feed
  children are **feeds**), and hosted MCP servers are presented as **toolkits**.
  No compatibility aliases.

  - `@ontrove/sdk`: `defineConnector` → `defineSource`, `runConnector` →
    `runSource`, `validateConnectorManifest` → `validateSourceManifest`,
    `TroveConnector` → `TroveSource`, and `ConnectorDocument`/`ConnectorContext`/
    `ConnectorSyncResult`/`ConnectorManifest`/`ConnectorContentType` →
    `Source*`.
  - `@ontrove/cli`: the `trove connector`/`trove connectors` command family is now
    `trove source`/`trove sources`; `--connector` filter flags are now `--source`,
    and the child-level `--source` flag is now `--feed` (`trove ingest --source
<id> --feed <id>`). All GraphQL operations target the renamed schema
    (`sources`, `source`, `createSource`, `addFeed`, `sourceId`/`feedId`,
    `totalSources`, `documentsBySourceType`, …). The `trove mcp *` namespace is
    unchanged.
  - `@ontrove/mcp`: `ctx.trove.search`'s `TroveSearchOpts.connector` option is now
    `source` (requires a Trove cloud that accepts the `source` wire key).

## 0.1.0

Initial release — the connector authoring SDK: `defineConnector`, the `sync(ctx)`
capability object, the document shape, the local-run harness, and manifest
validation.
