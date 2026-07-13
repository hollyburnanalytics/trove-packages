# @ontrove/mcp

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
