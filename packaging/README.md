# Packaging & distribution

How the `trove` CLI is built and shipped as a self-contained single binary.

## Build

```bash
bun run --filter './packages/trove-cli' build:bin          # host target → dist/bin/trove
bun scripts/build-binaries.mjs --all                        # all shipping targets
```

`build:bin` first runs `build:vendor` (`scripts/build-mcp-worker-runtime.mjs`),
which pre-bundles `@ontrove/extend/toolkit` for the worker target and embeds it
so `trove mcp deploy` works from the binary with no on-disk `@ontrove/extend`. Binaries
are Bun-compiled: the runtime and the `@ontrove/*` packages are embedded, so users
install nothing. `esbuild` is used here only at build time to produce that
embedded runtime — it is not in the shipped binary.

Targets: macOS arm64/x64, Linux x64/arm64, Windows x64. Bun has no Windows-arm64
compile target; those users fall back to `bunx @ontrove/cli`.

## Release

`.github/workflows/binaries.yml` runs on a `v*` tag: cross-compile all targets on
Linux, sign + notarize the macOS binaries on a macOS runner (gated on Apple
secrets — see below), package `*.tar.gz`/`*.zip` with `SHA256SUMS`, and attach
everything to the GitHub Release. The npm release (`release.yml`) is unchanged and
runs independently.

## Install

```bash
curl -fsSL https://ontrove.sh/install.sh | sh     # macOS / Linux  (packaging/install.sh)
irm https://ontrove.sh/install.ps1 | iex          # Windows x64    (packaging/install.ps1)
brew install <tap-owner>/tap/trove                 # Homebrew       (generated formula)
bunx @ontrove/cli                                  # Bun users / Windows-arm64
```

The install script detects OS/arch, downloads the matching release asset, verifies
its checksum, installs to `~/.local/bin`, and wires PATH via the rustup env-file
pattern.

## Homebrew

`scripts/gen-homebrew-formula.mjs <version>` generates `homebrew/trove.rb` from the
packaged archives (fills version + SHA-256). Commit/push it to the tap repo
(`<owner>/homebrew-tap`); the formula URLs point at this repo's release assets
regardless of who owns the tap.

## Signing secrets (macOS)

Set these repo secrets to enable notarization (until then macOS binaries ship
unsigned and the workflow warns): `APPLE_CERT_P12` (base64 Developer ID .p12),
`APPLE_CERT_PASSWORD`, `APPLE_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`,
`APPLE_APP_PASSWORD`. Windows signing (Azure Trusted Signing) is not wired yet —
the Windows binary ships unsigned until that account exists.
