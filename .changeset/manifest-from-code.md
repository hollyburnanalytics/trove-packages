---
'@ontrove/extend': major
'@ontrove/cli': major
---

An extension declares itself in code. `manifest.json` becomes a generated
artifact rather than a second, hand-written copy of the same facts.

`defineSource` now takes the manifest fields alongside `sync`, and
`defineToolkit` takes them alongside `tools`. Both validate eagerly, so a bad
`runsIn`, an unrecognised cadence, a credential smuggled into `config`, or a
secret written as a value rather than a name fails when the module is imported —
at authoring time and at deploy — instead of on the first scheduled run.
`toSourceManifest()` / `toToolkitManifest()` emit the JSON, marked `generated`.

**Why this was worth a major.** Every hand-written manifest in the catalogs had
drifted, in the same direction: the `sdk` field named `^0.1`, `^0.7` and `^0.10`
across 81 toolkits, against a package that had reached 1.0.1. Nothing read it —
not the validator, not the backend, not the Mac's parser — so nothing ever said
so.

The rot was not confined to the catalogs:

- **`SourceManifest` still declared `needs_browser`, `document_semantics` and
  `category`** — the vocabulary retired in the previous release. The type had
  drifted while the validator, which executes, had not. Removing the three
  fields broke no compile anywhere, which is the proof they were dead.
- **`trove source init` scaffolded `watermark`, `documentSemantics`, `location`
  and `needs_browser`** — four retired names — and omitted `runsIn`, `cursor`,
  `ingest` and `egress` entirely. `trove source validate` passed it, because
  authoring mode requires almost none of them. A new author's first two commands
  succeeded and their first deploy did not.
- **`trove mcp init` scaffolded no `icon` and no `version`**, two fields the
  directory shows.

Both scaffolds now build the stub and its manifest from **one** declaration, so
the two cannot disagree again.

`egress` validation moves into the SDK. The rules existed, on the server, so an
author met them at deploy having already written the source: entries must be
bare hostnames (the allowlist is host-exact), a `config:` sentinel must name a
real config field and is refused on a deployed source, no host may be claimed
twice, and an empty reach or a not-fetched host owes an `egressNote` saying why.
