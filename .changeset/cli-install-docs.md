---
"@ontrove/cli": patch
---

Document the working install channels: Homebrew (`brew install
hollyburnanalytics/tap/trove`), the `curl`/`irm` install scripts, and Bun/npm.
The install scripts now verify each download against the release `SHA256SUMS`
before extracting (fail-closed on macOS and Windows too).
