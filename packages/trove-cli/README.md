# `@ontrove/cli` — the Trove command-line tool

`trove` is a single, scriptable command-line tool for all of Trove: building and
deploying the tools you give Claude (your own toolkits, hosted on Trove's cloud),
capturing documents, authoring sources, and querying everything — all over the
one GraphQL API at `api.ontrove.sh/graphql`.

> **GraphQL is the API. The CLI is a convenience layer.** Every `trove` command is
> a thin wrapper over a documented GraphQL operation. The CLI has no privileged
> access and no private endpoint — it is just another client of the same Open Host
> Service the MCP tools and the web app use.

## Install

`trove` ships as a self-contained single binary (`bun build --compile`) — the Bun
runtime and the `@ontrove/*` packages are embedded, so the binary installs need
**nothing else on your machine**: no Node, no Bun, no toolchain.

**Homebrew** (macOS/Linux):

```bash
brew install hollyburnanalytics/tap/trove
```

**Shell script** (macOS/Linux):

```bash
curl -fsSL https://ontrove.sh/install.sh | sh
```

Windows (x64):

```powershell
irm https://ontrove.sh/install.ps1 | iex
```

**Bun / npm** — if you already have Bun, skip the binary and run the package
directly (npm works too, but the CLI *runs on Bun*, so you need Bun on your PATH):

```bash
bunx @ontrove/cli               # run without installing
bun add --global @ontrove/cli   # install it globally
npm i -g @ontrove/cli           # or from npm (requires Bun on PATH)
```

> The binary channels cover macOS (arm64 + x64), Linux (x64 + arm64), and Windows
> x64; each download's checksum is verified against the release `SHA256SUMS`.
> Windows on ARM has no native binary — use `bunx @ontrove/cli` there.

## Quickstart

```bash
# Authenticate. `trove login` opens your browser (loopback OAuth + PKCE) and
# stores the token in the OS keychain when available, else ~/.trove/config.toml
# (chmod 600). Prefer the non-interactive path for CI:
trove login --token "$CLERK_JWT" --email you@example.com
# ...or set TROVE_TOKEN and skip login entirely.

trove whoami                         # verify the token + print corpus size
trove search "database indexing"     # semantic search (top-K)
trove list --source "The Guardian" --json | jq '.totalCount'
trove get d_123 | $EDITOR -          # full text to stdout for piping
trove get d_123 --offset-words 0 --max-words 800   # page a long transcript
trove save --url https://example.com/post --tag reading
```

## Source & toolkit authoring

The CLI is the local toolchain for `@ontrove/extend` — `/source` for sources and
`/toolkit` for your own toolkits: scaffold, run locally, then push.

```bash
# Sources (client-side execution → ingestDocuments)
trove source init my-blog            # scaffold manifest.json + index.ts
cd my-blog
trove source dev --json | jq '.[].title'      # run sync(ctx) locally, no upload
trove source test --fixtures fixtures.json    # assert document shape offline
trove source validate                         # lint manifest (credential-key check)
trove source sync --source "My Blog" --feed default --create   # → ingestDocuments
trove source deploy                           # → deploySource; Trove runs it on a schedule

# Toolkits (@ontrove/extend/toolkit)
trove toolkit init my-server                 # scaffold manifest.json + server.ts
cd my-server
trove toolkit dev --port 8788                # bundle + serve over http://127.0.0.1:8788
trove toolkit deploy                         # mutation deployServer (PROPOSED runtime)
```

## Output & scripting

- **Human by default at a TTY** — aligned tables, `[doc:ID]` handles, color.
- **`--json` / `--jsonl`** — the GraphQL `data` shape for `jq`/`fzf` pipelines.
  When stdout is **not** a TTY, the CLI auto-selects `--json`.
- **Data → stdout, diagnostics → stderr.** `trove search … --json | jq` is never
  polluted by progress/chrome.
- Honors `NO_COLOR`, `--no-color`, `--quiet`.

```bash
trove search "distributed systems" --jsonl \
  | jq -r '[.relevanceScore, .document.title] | @tsv' | sort -rn | fzf
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Usage / validation error |
| `4` | Auth error (not logged in, expired token, or access not granted for this account) |
| `5` | Not found (`document`/`source` returned `null`) |
| `7` | Transport / server error |
| `8` | Retryable conflict — `ingest` cursor CAS rejection (re-read the cursor and retry) |

## Profiles

`~/.trove/config.toml` holds named profiles (an environment + identity each):

```toml
default_profile = "prod"

[profiles.prod]
api_url = "https://api.ontrove.sh"
issuer  = "https://accounts.ontrove.sh"
token   = "…"
email   = "you@example.com"

[profiles.dev]
api_url = "http://localhost:8787"
```

Select with `--profile <name>`, `TROVE_PROFILE`, or `default_profile`.
`TROVE_TOKEN` overrides any stored token (the CI path). `--endpoint <url>`
overrides a profile's `api_url`.

## Commands → GraphQL operations

| Command | GraphQL operation | Kind |
|---|---|---|
| `login` / `logout` / `whoami` | — (Clerk; `whoami` calls `query stats`) | Auth |
| `search <query>` | `query search` | Read |
| `discover <topic>` | `query discover` | Read |
| `recent` | `query recent` | Read |
| `get <id…>` | `query document(id)` | Read |
| `list` | `query documents` | Read |
| `sources` | `query sources` | Read |
| `source <id\|name>` | `query source(id)` | Read |
| `stats` | `query stats` | Read |
| `save` | `mutation saveDocument` | Write |
| `ingest` | `mutation ingestDocuments` (cursor CAS) | Write |
| `source init` | — (scaffold `@ontrove/extend/source` project) | Local |
| `source dev` | — (local `sync(ctx)` on Bun) | Local |
| `source test` | — (local fixtures assertion) | Local |
| `source validate` | — (`validateSourceManifest`) | Local |
| `source sync` | `mutation ingestDocuments` (+ `createSource`/`addFeed` w/ `--create`) | Write |
| `source deploy` | `mutation deploySource` | Write |
| `toolkit init` | — (scaffold `@ontrove/extend/toolkit` project) | Local |
| `toolkit dev` | — (local server over `127.0.0.1`) | Local |
| `toolkit logs` | — (explains the deployed runtime log gap) | Info |
| `toolkit ls` | `query mcpServers` | Read |
| `toolkit deploy` / `deploy` | `mutation deployServer` | Write |
| `toolkit pause` / `resume` / `rm` | `pauseServer` / `resumeServer` / `deleteServer` | Write |
| `toolkit rollback` | `mutation rollbackServer` | Write |
| `secret set` | `mutation setServerSecret` | Write |
| `secret ls` | `query mcpServers` (`secrets` — names only) | Read |
| `gql <file\|->` | _arbitrary, user-supplied_ | Escape hatch |

The toolkit management commands (`mcp deploy/pause/resume/rollback/rm`,
`secret set/ls`) wrap the corresponding GraphQL mutations; the **deployed
runtime** (where each request runs in an isolated sandbox) is still **PROPOSED**,
so `toolkit logs` has no GraphQL operation to call —
it explains that per-script logs come from the deployed runtime and points there
rather than inventing a fake op. Everything else — the `source init/dev/test/
validate/sync/deploy` and `mcp init/dev` local toolchain, `login`'s loopback OAuth
flow, keychain token storage, `get` word-paging, and `secret ls` — is implemented
here.

`source deploy` is the one source verb that moves where the sync runs: it bundles
`index.ts` with a runtime shim that adapts the sandbox's request to your
`sync(ctx)`, so nothing in your source is deployment-specific. Two rules follow
from the sandbox, and the CLI refuses the deploy rather than letting you find out
later:

- **`manifest.json` must declare `egress`** — the list of hosts the source may
  reach. It is the deployed source's entire reach, so a source without one can
  fetch nothing.
- **A deployed source gets no credentials.** `sync(ctx)` sees preferences
  (`ctx.config`) and nothing else. A source that needs a secret stays on
  `source sync`, where it runs on your own machine.

## Development

```bash
bun install        # from the packages/ workspace root (links @ontrove/extend)
bun run typecheck  # tsc --noEmit (strict)
bun run lint       # biome check
bun run test       # vitest (mocked fetch — no network, no credentials)
bun run build      # tsc → dist/ (the `trove` bin)
```

> `@ontrove/cli` lives in the `packages/` bun workspace alongside `@ontrove/extend`,
> which it depends on via published semver. A single `bun install` at `packages/`
> links both locally; building `@ontrove/extend` first (`bun run build` in it) makes
> its `dist/` available to the CLI.

All tests run against a mocked GraphQL endpoint and a temp `$HOME`; none touch the
network. The OAuth browser/loopback and OS-keychain seams are injected and mocked
in tests (the one genuinely-unrunnable wiring lives in `src/commands/login-live.ts`,
which is excluded from coverage). Branch coverage is gated at 90%.

## Support

Guides and the full reference live at [docs.ontrove.sh](https://docs.ontrove.sh).

Report bugs or security issues to <matt@hollyburnanalytics.com>.

## License

Released under the [MIT License](./LICENSE). © 2026 Hollyburn Analytics Inc.
