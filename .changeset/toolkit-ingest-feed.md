---
"@ontrove/mcp": minor
---

`ctx.trove.ingest` documents can now declare the **feed** (sub-group) they
belong to within the toolkit's source. `TroveIngestDoc` gains an optional
`feed: { key, name, label? }` (and the new `TroveIngestFeed` type): `key` is the
grouping entity's stable upstream id (a channel id, CIK, series id, …) and the
dedup boundary, `name` its display name, and `label` an optional word for what it
groups by ("Channel", "Show", "Company"). Omit it and a toolkit's documents form
one flat list under its source; declare it and they cluster into named feeds. The
toolkit's source itself is attributed automatically from the verified toolkit
identity — the toolkit only chooses how (and whether) to subdivide.
