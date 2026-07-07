# @ontrove/cli

## 0.3.1

### Patch Changes

- b99b4e9: Fix `trove mcp deploy` failing in the npm-installed CLI with a missing-module
  error. The command imports a pre-bundled MCP worker runtime that was generated
  into `src/vendor/` (git-ignored) but never emitted into `dist/` or included in
  the published tarball, so the compiled `dist/lib/bundle.js` could not resolve it.
  The build now emits the runtime into `dist/vendor/` (shipped via `files: ["dist"]`)
  and generates it as part of `prepack`, so `trove mcp deploy` works from a plain
  `npm i -g @ontrove/cli` install.
  - @ontrove/sdk@0.3.1
  - @ontrove/mcp@0.3.1

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

### Patch Changes

- b972ae5: Fix `trove login` succeeding but every subsequent command failing with
  `Authentication failed (HTTP 401)`. The login flow requested `offline_access`
  but discarded the resulting refresh token and stored only the short-lived
  access token, which `trove login` verified immediately (so login looked fine)
  but which had expired by the time the user ran their next command.

  The CLI now persists the refresh token and token endpoint at login and, when a
  request is rejected with 401/403, silently redeems the refresh token for a new
  access token, retries once, and saves the rotated credentials — so commands
  keep working across access-token expiry without a re-login. When no refresh
  token is available or the refresh token itself is expired/revoked, the auth
  error still surfaces so the user is told to run `trove login`. The refresh
  token is stored beside the access token (OS keychain when available, else the
  chmod-600 config file).

- Updated dependencies [dbf6fa1]
  - @ontrove/sdk@0.3.0
  - @ontrove/mcp@0.3.0

## 0.2.0

### Minor Changes

- a45b698: Ship `trove` as a self-contained single binary built with `bun build --compile`,
  so installing needs no Node, no bundler, and no toolchain — one `curl … | sh`
  line (or Homebrew) drops a runnable binary on PATH. The authoring toolchain
  (`connector dev/test/sync`, `mcp dev`, `mcp deploy`) now runs on Bun natively:
  it transpiles and runs the user's connector/server TypeScript in-process, with
  `@ontrove/sdk`/`@ontrove/mcp` supplied from the binary by an embedded resolver
  (no `node_modules` needed in the project), and `mcp deploy` bundles the hosted
  artifact with `Bun.build` against a pre-bundled, embedded MCP worker runtime.

  The `esbuild` runtime dependency is removed (it was the Node-era bundler); it is
  now only a build-time devDependency used to pre-bundle the embedded MCP runtime.
  No command, flag, output format, or exit code changed. `trove --version` now
  reports the real version from the compiled binary.

### Patch Changes

- b01b130: Fix `trove login` hanging on macOS. The keychain write piped the token to
  `security add-generic-password -w`, but macOS `security` reads `-w` (with no
  value) from the controlling terminal via getpass — not stdin — so the piped
  token was ignored and login hung on a `password data for new item:` prompt.
  Pass the token as the `-w` value instead (the only reliable non-interactive
  form; briefly visible via `ps` for the one short spawn).

## 0.1.0

Initial release — the `trove` command-line tool: a scriptable GraphQL client for
your knowledge base and the local toolchain for authoring connectors and hosted
MCP servers.
