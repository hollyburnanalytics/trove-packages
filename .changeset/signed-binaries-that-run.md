---
'@ontrove/cli': patch
---

Fix the macOS binaries dying with "Ran out of executable memory".

0.10.2's Homebrew and standalone binaries were signed, notarized, the right
architecture, and could not run a single command. `trove` is a Bun single-file
binary: JavaScriptCore compiles JavaScript to machine code at run time and needs
executable memory, and the hardened runtime forbids that without an entitlement
saying otherwise. The signing step passed `--options runtime` and no
`--entitlements`.

Only the binary distributions were affected. Installs from npm run under your
own Bun or Node and were always fine.
