# Trove Packages

[![CI](https://github.com/hollyburnanalytics/trove-packages/actions/workflows/ci.yml/badge.svg)](https://github.com/hollyburnanalytics/trove-packages/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The developer toolchain for [Trove](https://ontrove.sh) — a personal knowledge
base for AI. This monorepo holds the three published `@ontrove/*` packages used
to author sources, build your own toolkits (every toolkit runs as a full MCP
server on Trove's cloud), and talk to your knowledge base.

| Package | What it's for | Install |
|---------|---------------|-----|
| [`@ontrove/sdk`](packages/trove-sdk) | Author **sources** — `defineSource`, the `sync(ctx)` capability object, the document shape, a local-run harness, and manifest validation. | `npm i @ontrove/sdk` |
| [`@ontrove/mcp`](packages/trove-mcp) | Author **toolkits** — `defineMcpServer`, the `ctx` capability object, Zod schemas, and `ToolError`. | `npm i @ontrove/mcp` |
| [`@ontrove/cli`](packages/trove-cli) | The `trove` command-line tool — a scriptable GraphQL client for your knowledge base and the toolchain for authoring sources and building & deploying toolkits. | `bunx @ontrove/cli` · [other channels](packages/trove-cli#install) |

> Looking for working examples? See **[the examples gallery](https://github.com/hollyburnanalytics/trove-integrations)** —
> real sources and toolkits built on these packages.

## Layout

```
packages/
  trove-sdk/    → @ontrove/sdk
  trove-mcp/    → @ontrove/mcp
  trove-cli/    → @ontrove/cli   (depends on the two SDKs)
```

## Development

Requires [Bun](https://bun.sh) ≥ 1.2 and Node ≥ 20.

```bash
bun install        # install + link the workspace
bun run build      # build all packages (SDKs first, then the CLI)
bun run test       # run every package's tests
bun run lint       # Biome across all packages
bun run check      # lint + typecheck + test + build
```

Each package is self-contained — `cd packages/<name>` and run its own
`build`/`test`/`lint` scripts when iterating on one.

## Releasing

Releases are managed with [Changesets](https://github.com/changesets/changesets)
and published to npm from CI.

```bash
bun run changeset        # describe your change (pick packages + bump type)
```

Merging a changeset to `main` opens a "Version Packages" PR; merging that PR
publishes the bumped packages to npm. (Requires the `NPM_TOKEN` repo secret.)

## License

Released under the [MIT License](LICENSE). © 2026 Hollyburn Analytics Inc.
