---
"@ontrove/cli": patch
---

Fix `trove mcp deploy` failing in the npm-installed CLI with a missing-module
error. The command imports a pre-bundled MCP worker runtime that was generated
into `src/vendor/` (git-ignored) but never emitted into `dist/` or included in
the published tarball, so the compiled `dist/lib/bundle.js` could not resolve it.
The build now emits the runtime into `dist/vendor/` (shipped via `files: ["dist"]`)
and generates it as part of `prepack`, so `trove mcp deploy` works from a plain
`npm i -g @ontrove/cli` install.
