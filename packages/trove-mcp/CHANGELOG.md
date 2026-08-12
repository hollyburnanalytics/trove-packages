# @ontrove/mcp

## 0.10.1

## 0.10.0

### Minor Changes

- A toolkit can have settings: `ctx.config`.

  Sources have had typed, validated, user-editable settings for a long time.
  Toolkits could hold a secret and nothing else, so a toolkit that wanted a home
  airport or a company domain had to take it as an argument on every call — which
  means the model guesses it, and the user cannot set it once.

  `ctx.config` is the caller's stored values for this toolkit, frozen on the way
  in: they are the user's settings, not scratch space, and a tool that mutates its
  own settings mid-call confuses only itself. A toolkit that declares no `config`
  block in its manifest sees `{}`.

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

### Minor Changes

- 5cbe063: `TroveIngestDoc` gains `fallback` — a second artifact to capture when `fileUrl` turns out not to exist.

  Some sources publish the same document in more than one form, and only one of them reliably exists: arXiv has back-rendered HTML for many papers but not all, while every paper has a PDF. Name the preferred artifact as `fileUrl` and the sure thing as `fallback`, and Trove finds out which is real **server-side** — off the tool's clock, where a miss costs a retry nobody is waiting on.

  ```ts
  await ctx.trove.ingest([
    {
      title: paper.title,
      text: abstract,
      fileUrl: `https://arxiv.org/html/${paper.id}`,
      mimeType: "text/html",
      fallback: { fileUrl: paper.pdfUrl, mimeType: "application/pdf" },
    },
  ]);
  ```

  Without it a toolkit has to probe for itself — a request per candidate before the save can even begin, on a tool call that is cancelled after about eight seconds.

## 0.7.0

### Minor Changes

- d7f9486: `TroveIngestDoc` gains `externalId` — the upstream's own stable id (a video id,
  an arXiv id, an episode id).

  It is the dedup key within the feed: saving the same `externalId` twice is
  idempotent, and the second save returns the document already there instead of
  creating a duplicate. Set it whenever the upstream has an id, which is nearly
  always. Omit it and every save is a new document — right for content with no
  upstream identity (a note), wrong for everything else.

  Requires the matching knowledge-base change to take effect.

## 0.6.0

### Minor Changes

- a9af139: `TroveIngestDoc` gains `date` and `tags`.

  `date` is the content's own **publish** date (ISO 8601) — when the paper, episode
  or video was published, not when you are saving it. Set it whenever the upstream
  tells you: only the toolkit knows the real date, and it is what recency ranking
  and date filters sort on. A document saved without one is only ever as old as the
  day it was ingested.

  `tags` files the document under free-text tags (trimmed, deduped, max 32 × 64
  chars).

  Both fields were already accepted by the knowledge base; the SDK simply had no
  way to express them, so every hosted save landed undated.

### Patch Changes

- 4cbb067: Document the `ctx.trove` knowledge-base client in the README: the full
  `TroveIngestDoc` field reference (`fileUrl`, `audioUrl`, `mimeType`,
  `captureOnly`) and the feed API for grouping a toolkit's documents by channel,
  show, company, or series. No API change — that surface shipped in 0.5.0; the
  README was simply silent about it.

## 0.5.0

### Minor Changes

- f70cd98: `ctx.trove.ingest` documents can now capture a file by URL. `TroveIngestDoc`
  gains `fileUrl`/`audioUrl` + `mimeType` (the file Trove fetches and stores) and a
  `captureOnly` flag that retains the artifact plus a searchable metadata record
  without running the AI processing (transcription / text extraction) — so a
  toolkit can capture now and enrich later. `text` is now optional when a file is
  supplied.
- 8103348: `ctx.trove.ingest` documents can now declare the **feed** (sub-group) they
  belong to within the toolkit's source. `TroveIngestDoc` gains an optional
  `feed: { key, name, label? }` (and the new `TroveIngestFeed` type): `key` is the
  grouping entity's stable upstream id (a channel id, CIK, series id, …) and the
  dedup boundary, `name` its display name, and `label` an optional word for what it
  groups by ("Channel", "Show", "Company"). Omit it and a toolkit's documents form
  one flat list under its source; declare it and they cluster into named feeds. The
  toolkit's source itself is attributed automatically from the verified toolkit
  identity — the toolkit only chooses how (and whether) to subdivide.

### Patch Changes

- 12ff00e: Docs: align README one-liners to the v2 positioning — lead with "the tools you give Claude" (capabilities Claude doesn't have on its own), not the knowledge base. No API changes.

## 0.4.0

### Minor Changes

- 5c24067: Support Zod 4 in addition to Zod 3. Tool input schemas now compile to JSON Schema
  via Zod 4's native `z.toJSONSchema` when the caller uses `zod@^4`, falling back
  to `zod-to-json-schema` on `zod@^3.25` — the peer range widens to
  `^3.25.28 || ^4`. Output is normalized so the emitted schema (including a closed
  `additionalProperties: false` root) is identical across both Zod versions.

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

Initial release — the hosted-MCP authoring SDK: `defineMcpServer`, the `ctx`
capability object (`fetch`/`fetchJson`/`requireSecret`/`log`), declarative OAuth2
auth, egress guarding, secret redaction, and `ToolError`.
