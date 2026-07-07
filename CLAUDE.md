# trove-packages

Public (MIT), npm-published monorepo for Trove's authoring packages:

- **`@ontrove/sdk`** (`packages/trove-sdk`) — the source SDK (`sync(ctx)`).
- **`@ontrove/mcp`** (`packages/trove-mcp`) — the toolkit SDK (`defineMcpServer`; every toolkit runs as a hosted MCP server).
- **`@ontrove/cli`** (`packages/trove-cli`) — the `trove` CLI (GraphQL client + authoring toolchain).

These packages are the **public** authoring surface for Trove. They document
their own contract and observable behaviour; they must not reference Trove's
non-public product internals or hosting implementation.

## Dev commands

```bash
bun install
bun run check        # build → lint → typecheck → test (build first: cli needs the sdk/mcp dist)
bun run build        # build sdk + mcp, then cli
bun run lint         # Biome
bun run typecheck    # tsc --noEmit, all packages
bun run test         # vitest, all packages
bun run refs:check   # guard: no internal references in shipped source (see below)
bun run api:docs     # local preview of the TypeDoc API reference (git-ignored)
```

Add a **changeset** (`bun run changeset`) for any change to a package's public surface.

## Documentation

Docs live in three layers. Keep each in its lane.

| Layer | Where | Audience | Job |
|---|---|---|---|
| **1. Inline JSDoc** | `packages/*/src` | devs in-IDE + published `src` | The API contract + observable behaviour. The single source of truth for signatures. |
| **2. Package README** | `packages/*/README.md` | someone landing on npm | Install + quickstart + orientation; link to the docs site by section name. |
| **3. Docs site** (`docs.ontrove.sh`) | built separately from the published packages | "learn Trove" | Narrative guides + the **generated** API reference (built from the published packages). Narrative pages do **not** hand-restate signatures. |

**API reference is generated, not hand-written.** JSDoc is the source of truth.
The public reference is generated **into the docs site** (`docs.ontrove.sh`) from
the published packages — which ship their `src` — at docs-build time, so it
tracks each release with no drift. `bun run api:docs` here runs TypeDoc into a
git-ignored `api-reference/` as a **local preview aid** only.

### The rule: no internal references in shipped artifacts

Everything in `packages/*/src` and the READMEs ships (sdk/mcp publish `src`; the
cli publishes compiled `dist` with comments intact). So shipped comments must
describe only the public contract and observable behaviour — never a private
design-doc citation or a hosting-implementation detail. `bun run refs:check`
(`scripts/check-no-internal-refs.mjs`) enforces this in CI.

When you're tempted to write an internal pointer, do one of:

- **(a)** keep the explanatory prose, **drop** the citation;
- **(b)** if a pointer genuinely helps, name the public docs section in plain
  English (e.g. "see the toolkit SDK reference") — never a design-doc number and
  never a hardcoded docs URL;
- **(c)** delete it when it was pure bookkeeping.

Describe behaviour a caller can observe, not how it's hosted: say "an egress
proxy that blocks requests to private/loopback/link-local addresses," "the
hosted runtime," "each request runs in an isolated sandbox," or "a Trove-provided
callback" rather than any internal component name. `refs:check` fails the build
on the patterns it knows about; when in doubt, prefer the behavioural phrasing.

### JSDoc conventions

- Every exported function, type, and interface has JSDoc (it's also what TypeDoc
  renders).
- Document the **contract and observable behaviour** a caller relies on, not the
  internal implementation. Explain *why* in user terms when it prevents a footgun.
- Use `@link` to other public symbols; never to internal docs.

### README conventions

Each package README follows the same shape: one-line what-it-is → `## Install`
→ `## Quickstart` (a runnable example) → the key reference tables (e.g. the
`ctx` object) → `## License`. Link out to the docs site by section name.

Every README code block that imports from `@ontrove/*` is typechecked against
the built packages by `bun run docs:examples` (`scripts/check-doc-examples.mjs`,
in `check` + CI) — a drifted import, a wrong option, a renamed export fails the
build. Opt a fragment or intentionally-illustrative snippet out with a
`no-typecheck` fence info string (` ```ts no-typecheck `), which npm/GitHub
ignore when rendering.

## Pre-publish checklist

1. `bun run check` green.
2. `bun run refs:check` green (no internal references).
3. `npm pack --dry-run` in each package; eyeball the file list and spot-check the
   tarball for anything that shouldn't ship.
4. Changeset present; versions bumped.
