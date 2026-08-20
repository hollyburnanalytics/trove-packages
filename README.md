# Trove Packages

[![CI](https://github.com/hollyburnanalytics/trove-packages/actions/workflows/ci.yml/badge.svg)](https://github.com/hollyburnanalytics/trove-packages/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The developer toolchain for [Trove](https://ontrove.sh) — a personal knowledge
base for AI. This monorepo holds the published `@ontrove/*` packages used to
author sources and toolkits, and to talk to your knowledge base.

| Package | What it's for | Install |
|---------|---------------|-----|
| [`@ontrove/extend`](packages/trove-extend) | Author **sources** (`@ontrove/extend/source` — `defineSource`, cursors, the document shape, a local-run harness, manifest validation) and **toolkits** (`@ontrove/extend/toolkit` — `defineToolkit`, `tool`, `ToolError`, Zod schemas), over one shared capability object. | `npm i @ontrove/extend` |
| [`@ontrove/cli`](packages/trove-cli) | The `trove` command-line tool — a scriptable GraphQL client for your knowledge base and the toolchain for authoring sources and building & deploying toolkits. | `brew install hollyburnanalytics/tap/trove` · [other channels](packages/trove-cli#install) |

> Looking for working examples? See **[the examples gallery](https://github.com/hollyburnanalytics/trove-integrations)** —
> real sources and toolkits built on these packages.

## Layout

```
packages/
  trove-extend/ → @ontrove/extend
  trove-cli/    → @ontrove/cli   (depends on @ontrove/extend)
```

## Development

Requires [Bun](https://bun.sh) ≥ 1.2 and Node ≥ 20.

```bash
bun install        # install + link the workspace
bun run build      # build all packages (extend first, then the CLI)
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
