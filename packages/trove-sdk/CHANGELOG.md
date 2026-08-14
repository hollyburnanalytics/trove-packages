# @ontrove/sdk

## 0.10.1

### Patch Changes

- Fix `@ontrove/sdk/contract` throwing on import outside a bundler.

  `0.10.0` shipped the contract module with a bare JSON import. Node's ESM
  loader refuses a JSON module without `with { type: 'json' }`, so the first
  consumer to `import '@ontrove/sdk/contract'` got a TypeError rather than a
  fixture. TypeScript compiled it, every test passed, and none of that could
  see the failure — because the tests import from `src` through a bundler and
  consumers do not.

  A new suite runs plain `node` against the built `dist`, resolving through the
  real `exports` map: the main entry, the contract subpath, and the raw JSON
  path the Mac's runner reads off disk. Publishing is the one action here that
  cannot be taken back, so it is worth a slow test.

## 0.10.0

### Minor Changes

- Own the deployed-source invoke contract, and run it.

  The contract every deployed source must obey is a JSON fixture, and it lived in
  Trove's backend — which made it the backend's contract that other
  implementations were welcome to read. Reading is not executing. Three programs
  speak this contract and only one ran the cases; the third is the Mac runner,
  which ships inside an installed app with no forced update, so a change it does
  not catch reaches people as a silently broken sync on a build nobody can recall.

  It lives here now, at `@ontrove/sdk/contract` (and as raw JSON at
  `@ontrove/sdk/contract/source-invoke.json`, because the Mac's runner is plain
  JavaScript). This package is the one artefact all three can reach.

  Running it found three ways `createSourceWorker` did not speak the contract:

  - An adapter that falls off the end of `sync` was answered with a 500. That is
    an empty run, not a malformed one, and the bundled runtime has always accepted
    it — so the same source worked bundled and broke deployed.
  - `feedName`, `feedUrl` and `stats` were dropped. `SourceSyncResult` had nowhere
    to put them, so a deployed source could not name its own feed, could not
    report that the feed had moved, and could not ask the runner to drain again.
    All three work when the same source runs on a Mac.
  - A `cursor: null` was omitted rather than emitted — the fixture's fault, not
    the worker's. Null and absent are the same statement, since the reader drops
    null either way, so pinning the key set exactly made an implementation wrong
    for being tidier.

  `SourceSyncResult` gains `feedName`, `feedUrl` and `stats` accordingly.

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
