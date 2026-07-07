# @ontrove/mcp

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
