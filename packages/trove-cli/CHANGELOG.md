# @ontrove/cli

## 1.0.1

### Patch Changes

- Updated dependencies [12837e0]
  - @ontrove/sdk@1.0.1
  - @ontrove/mcp@1.0.1

## 1.0.0

### Major Changes

- b488a77: One word per concept. Breaking, with no compatibility aliases.

  Every rename here fixes a place the codebase spelled one idea two ways, which
  is how the SDK's type and Trove's "reconciled shape" drifted into disagreeing
  about `readonly values` and `max?` — two names for one thing is two things
  that can differ.

  | was                                                                                                                                                                 | is                                                                                                                                          |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
  | `Cursor`, `dateCursor`, `idSetCursor`, `readDateCursor`, `advanceDateCursor`, `CURSOR_STRATEGIES`, `CursorStrategy`, `MVP_DEPLOYED_CURSORS` | `Cursor`, `dateCursor`, `idSetCursor`, `readDateCursor`, `advanceDateCursor`, `CURSOR_STRATEGIES`, `CursorStrategy`, `MVP_DEPLOYED_CURSORS` |
  | `Document`                                                                                                                                                    | `Document`                                                                                                                                  |
  | `RunsIn`, `LOCATIONS`                                                                                                                                       | `RunsIn`, `RUNS_IN`                                                                                                                         |
  | `DocumentSemantics`, `DOCUMENT_SEMANTICS`                                                                                                                           | `IngestMode`, `INGEST_MODES`                                                                                                                |
  | manifest `cursor`                                                                                                                                                | manifest `cursor`                                                                                                                           |
  | manifest `ingest`                                                                                                                                        | manifest `ingest`                                                                                                                           |
  | manifest `needsBrowser`                                                                                                                                            | manifest `needsBrowser`                                                                                                                     |
  | manifest `location`, value `client`                                                                                                                                 | manifest `runsIn`, value `mac`                                                                                                              |

  `cursor` wins over `cursor` because it is what `ctx.cursor` was already
  called, what the stored column is called, and what the published invoke
  contract already said in all twenty-five of its references — the wire was
  right and the type was the outlier. `needsBrowser` was the only snake_case key
  among fifteen camelCase ones. `mac` says where the code runs; `client` said
  which side of a protocol it sat on.

  Consumers must update together: there are no aliases, and a manifest using the
  old keys now fails validation rather than being quietly ignored.

### Patch Changes

- Updated dependencies [b488a77]
  - @ontrove/sdk@1.0.0
  - @ontrove/mcp@1.0.0

## 0.13.0

### Patch Changes

- Updated dependencies [d5a848a]
  - @ontrove/sdk@0.13.0
  - @ontrove/mcp@0.13.0

## 0.12.0

### Minor Changes

- 5bf1c24: A deployed source's cursor now reaches its adapter unchanged, as the invoke
  contract has always required.

  `toCursor` reshaped anything it did not recognise into `{ type: 'none' }`.
  A source that resumes from a monotonic id stores `{ sinceId }`, so every run
  was handed "first run", re-read its API from the top, and advanced nothing —
  with no error anywhere. It is now `toCursor`, which returns what it was given.

  The same function invented a cursor where there was none. `ctx.cursor` is now
  absent on a first sync, in `runSource` and in the deployed worker, matching
  Trove's own runtime and the contract case "a wire null cursor becomes
  undefined". `SourceContext.cursor` is optional accordingly: it was declared
  required and documented as `{ type: 'none' }` on a first run, so an author who
  believed the type and wrote `ctx.cursor.type` compiled cleanly and crashed on
  the first sync of every feed.

  `MVP_DEPLOYED_CURSORS` is new, and `validateSourceManifest` uses it: a
  `runtime: deployed` source may declare `highWaterId`, because its cursor is
  returned byte-for-byte, while a bundled source may not, because that runtime
  parses the cursor and a shape it does not name parses to nothing. The refusal
  message says which case you are in.

### Patch Changes

- Updated dependencies [5bf1c24]
  - @ontrove/sdk@0.12.0
  - @ontrove/mcp@0.12.0

## 0.11.0

### Patch Changes

- 075799f: Test-only: fix seven broken optional chains that Biome 2.5.8 caught.
- 25ed77d: `trove source init` now scaffolds a manifest that `trove source validate`
  accepts. It did not: `kind` held a transport (`feed`), `transport` held a value
  from no vocabulary (`http`), `document_semantics` was both the former field name
  and a value that never existed (`text`), and `cursor` and `location` were
  missing. Nothing objected, because the validator did not yet know the
  vocabulary — so a new author's first two commands succeeded and their first
  deploy did not.
- Updated dependencies [25ed77d]
- Updated dependencies [9cec39d]
  - @ontrove/sdk@0.11.0
  - @ontrove/mcp@0.11.0

## 0.10.4

### Patch Changes

- c3c5e93: `trove source deploy` accepts `index.mjs`, not only `index.ts`.

  It looked for a single hardcoded filename, so it could not deploy any source
  in the catalogue it exists to serve — every one is plain ESM, including ones
  already running in production, which had to be deployed some other way.
  esbuild bundles either. `index.ts` still wins when both are present, since
  that is what `source init` scaffolds.

- feda9a5: `trove source` accepts a bare `export async function sync(ctx)`.

  The source commands required `export default defineSource({ sync })` and
  rejected everything else — which is every source in the catalogue, including
  adapters already syncing in production. A source's whole contract is one
  `sync(ctx)` function, and `createSourceWorker` already normalises a bare
  function to `{ sync }`, so the wrapper was never load-bearing at the runtime
  end. `run`/`test`/`sync` also only looked for `index.ts`, so they could not
  open a `.mjs` project either.

  - @ontrove/sdk@0.10.4
  - @ontrove/mcp@0.10.4

## 0.10.3

### Patch Changes

- 3aed0fc: Fix the macOS binaries dying with "Ran out of executable memory".

  0.10.2's Homebrew and standalone binaries were signed, notarized, the right
  architecture, and could not run a single command. `trove` is a Bun single-file
  binary: JavaScriptCore compiles JavaScript to machine code at run time and needs
  executable memory, and the hardened runtime forbids that without an entitlement
  saying otherwise. The signing step passed `--options runtime` and no
  `--entitlements`.

  Only the binary distributions were affected. Installs from npm run under your
  own Bun or Node and were always fine.

  - @ontrove/sdk@0.10.3
  - @ontrove/mcp@0.10.3

## 0.10.2

### Patch Changes

- 3263000: Fix every command reporting "Not logged in" straight after `trove login`.

  `trove login` stores a refresh token; the access token it mints is short-lived
  and often absent moments later. That state was reported as being logged out,
  and the advice — run `trove login` — was not just unhelpful but wrong, since
  logging in again returns you to the same place.

  The recovery already existed and was already tested: `onAuthFailure` renews an
  expired token mid-command on a 401. It never ran, because the CLI failed
  locally before any request could come back 401. A client is now built whenever
  refresh credentials are present, and the first 401 drives the same refresh.
  Being genuinely logged out still fails, and still says the one thing that fixes
  it.

  `@ontrove/sdk` gains `contract` on `ContractFixtures` — always present in the
  JSON, missing from the type. It matters most to the reader that cannot use the
  type at all: a plain-JavaScript runner opens the raw file and has only these
  keys to confirm it read the right one.

- Updated dependencies [3263000]
  - @ontrove/sdk@0.10.2
  - @ontrove/mcp@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies
  - @ontrove/sdk@0.10.1
  - @ontrove/mcp@0.10.1

## 0.10.0

### Minor Changes

- The deployed shim stopped refusing what the SDK spine already has.

  Two refusals, both correct when written and both outlived by the context spine.

  `assertNoCredentials` turned away any invoke carrying a secret, on the grounds
  that a source had no way to read one. `SourceContext` has had `secret(name)`
  since the spine was named, so this was refusing sources that would work — and
  telling their authors to go run them on a Mac. Credentials now reach the source
  through `ctx.secret(name)`: a map goes in, and only a lookup by declared name
  comes out, so a source cannot enumerate credentials it never asked for.

  `deadlineMs` was documented as deliberately not surfaced, on the grounds that a
  deadline would be a cloud-only capability. `ctx.deadline` is on the spine too.
  It arrives as a duration and is exposed as an absolute instant, because the
  runner computes the budget on a different machine.

  `createSourceWorker` also now accepts a bare `sync` function as well as a
  `defineSource` result, so an existing adapter does not need rewriting to become
  deployable.

- 37e59f6: Add `trove source deploy` — one command to put a source on Trove's own schedule.

  Deploying a source previously meant bundling it by hand and calling a GraphQL
  mutation from a browser console. `trove source deploy` now bundles `index.ts`
  with a runtime shim that adapts the sandbox's request to your existing
  `sync(ctx)` — nothing in a source is deployment-specific — and hands the result
  to `deploySource`.

  The rule that comes with the sandbox is refused locally, so you hear it while
  the file is still open rather than hours later on a machine you cannot see:
  `manifest.json` must declare `egress` — the hosts the source may reach, and its
  entire reach. A deployment that does not go live exits non-zero and says why.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ontrove/sdk@0.10.0
  - @ontrove/mcp@0.10.0

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

### Patch Changes

- 17e2e19: `trove get` no longer breaks against the current API, and no longer decides for itself what the pipeline's stages are.

  `GET_DOCUMENT` selected `audioDownloadedAt`, `transcribedAt`, `extractedAt` and `embeddedAt`. Those fields are gone from the API, and GraphQL rejects a query that names an unknown field — so this did not degrade to a missing row, it failed the whole `get` operation. The CLI has no schema-drift CI, so nothing would have caught it before a user did.

  The replacement is the point rather than a patch. That block was five hard-coded rows read off five nullable date columns, which meant the CLI decided what the pipeline's stages **were** — and printed a stale list the moment the server's stage set changed. It is now a loop over the stages the server reports, so a sixth stage appears with no change here.

  A `SKIPPED` stage is shown with its state rather than hidden. "not needed" answers _"why is there no formatted version of this"_, which the old blank row could not distinguish from "never ran".

  `lastProcessedAt` survives — it answers a different question, and the API now derives it from the stage ledger rather than from a column nothing writes.

- Updated dependencies [da907d9]
- Updated dependencies [9cf21dd]
  - @ontrove/mcp@0.9.0
  - @ontrove/sdk@0.9.0

## 0.8.0

### Minor Changes

- 3559d55: `trove login`'s browser callback page is now a real page — and tells the truth when a sign-in fails.

  It was a bare `<h2>Trove CLI</h2>` on a white background: the one part of the CLI a user ever sees, looking like a 1997 error. It now carries Trove's own palette, works in light and dark, and is entirely self-contained — no fonts, stylesheets or images fetched from anywhere, so it renders on a plane or behind a corporate proxy rather than sitting blank after a login that already worked.

  More importantly, a **failed** sign-in no longer claims success. The handler used to answer _"You may close this window"_ whatever came back — so a denied or malformed authorization looked exactly like a good one, and you returned to a terminal that had failed with no idea why. A refusal now says so, in the browser and in the terminal.

### Patch Changes

- Updated dependencies [5cbe063]
  - @ontrove/mcp@0.8.0
  - @ontrove/sdk@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [d7f9486]
  - @ontrove/mcp@0.7.0
  - @ontrove/sdk@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [a9af139]
- Updated dependencies [4cbb067]
  - @ontrove/mcp@0.6.0
  - @ontrove/sdk@0.6.0

## 0.5.0

### Minor Changes

- 9b861f4: `trove search` gains a `--sort` option (`relevance` | `published` | `ingested`):
  `relevance` (default) keeps the search ranking, `published` re-sorts the top
  relevant matches newest-published first, and `ingested` orders by most-recently
  added. `trove get` now shows both date axes — `published` (when the content was
  created) and `indexed` (when Trove ingested it) — plus the per-stage processing
  timestamps (audio downloaded / transcribed / extracted / embedded / last
  processed) for the stages a document actually went through.

### Patch Changes

- 12ff00e: Docs: align README one-liners to the v2 positioning — lead with "the tools you give Claude" (capabilities Claude doesn't have on its own), not the knowledge base. No API changes.
- Updated dependencies [f70cd98]
- Updated dependencies [12ff00e]
- Updated dependencies [8103348]
  - @ontrove/mcp@0.5.0
  - @ontrove/sdk@0.5.0

## 0.4.0

### Patch Changes

- 206dcd1: Correct the overview wording: hosted MCP-server deployment on Trove's cloud is in
  preview, not a shipped guarantee. Toolkits are MCP servers you author and test
  locally today; the README now says so plainly instead of stating hosted
  deployment as present-tense fact.
- Updated dependencies [5c24067]
  - @ontrove/mcp@0.4.0
  - @ontrove/sdk@0.4.0

## 0.3.3

### Patch Changes

- 2a3e59b: Publishes now include a signed npm provenance attestation, so consumers can
  cryptographically verify each tarball was built and published from this repo's
  release workflow at a specific commit.
- Updated dependencies [2a3e59b]
  - @ontrove/sdk@0.3.3
  - @ontrove/mcp@0.3.3

## 0.3.2

### Patch Changes

- 783c200: Document the working install channels: Homebrew (`brew install
hollyburnanalytics/tap/trove`), the `curl`/`irm` install scripts, and Bun/npm.
  The install scripts now verify each download against the release `SHA256SUMS`
  before extracting (fail-closed on macOS and Windows too).
  - @ontrove/sdk@0.3.2
  - @ontrove/mcp@0.3.2

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
