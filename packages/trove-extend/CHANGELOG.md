# @ontrove/sdk

## 1.0.1

### Patch Changes

- 12837e0: Finish the `location` → `runsIn` rename inside the validator.

  The field, the type and the vocabulary were renamed, but three things kept the
  old word where a regex could not see them: the error text still read "is not a
  known location", the local variable was still `const location`, and the doc
  comment still described `location`.

  The local one mattered more than it looks. Removing a variable named
  `location` does not leave an unbound identifier — it silently rebinds to the
  DOM `Location` global, so `location !== 'cloud'` kept compiling while
  comparing a `Location` object to a string. `tsc` caught it ("types 'Location'
  and 'string' have no overlap"); nothing at runtime would have.

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

## 0.13.0

### Minor Changes

- d5a848a: Add `stringList`, for reading a `url[]`/`text[]` config field a user filled in.

  Both source catalogs had grown the same function independently — same name,
  same body, two repositories — and it belongs with the package that defines
  `SourceContext.config`. A list field does not arrive in one shape: the web
  form, the Mac app, the CLI and the directory pickers variously send a list, the
  bare string somebody pasted, `null`, or nothing, so a source has to narrow
  before it reads.

  Writing tests for it on the way in found a bug both copies shared: a `null`
  _inside_ the list survived, because `String(null)` is the four-character string
  `"null"` and `filter(Boolean)` keeps it. A `url[]` field with a hole in it
  produced a feed address of `"null"`, which resolved as a relative URL and
  failed as a 404 from the source's own host rather than as the bad config it
  was. Entries that are `null` or `undefined` are now dropped before coercion.

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

## 0.11.0

### Minor Changes

- 25ed77d: The SDK now owns the pieces a source needs in order to be **correct**, not only
  the shapes it has to match.

  - **The cursor writer** — `dateCursor`, `idSetCursor`,
    `advanceDateCursor` and their readers, with the entry cap AND the byte
    budget the platform's cursor limit requires. The wire-contract test now
    asserts its fixtures against the writer that produces them, instead of pinning
    bytes written elsewhere.
  - **The guarded fetch seam** — `fetchPage`, `fetchPageWithMeta`, `fetchBytes`
    and `assertPublicHttpUrl`, with the host guard, request timeout,
    declared-length cap and streaming byte cap. It uses the `fetch` it is given,
    so a source called with a capability-bearing `ctx.fetch` goes through that
    one. The guard refuses IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), which
    normalizes to a form with no dotted quad left to check and slipped past a
    hand-written implementation of the same rules.
  - **The manifest vocabulary** — `SOURCE_KINDS`, `TRANSPORTS`, `LOCATIONS`,
    `CURSOR_STRATEGIES`, `DOCUMENT_SEMANTICS`, `FORMATTING`, `MVP` and the
    rest, with per-field validation folded into `validateSourceManifest`.

  No existing export changed shape; `validateSourceManifest`'s new second
  parameter is optional.

### Patch Changes

- 9cec39d: Documentation only: the package now describes what it owns (the invoke
  contract, the types, `runSource`, manifest validation) and what it does not yet
  own (the helpers a source is actually written against — feed parsing, HTML to
  text, the scrape loop, the cursor writer). The previous wording called it
  "the thin standard library for authoring Trove sources", which described the
  intended destination rather than the current package.

## 0.10.4

## 0.10.3

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
