---
'@ontrove/sdk': minor
'@ontrove/cli': minor
---

A deployed source's cursor now reaches its adapter unchanged, as the invoke
contract has always required.

`toWatermark` reshaped anything it did not recognise into `{ type: 'none' }`.
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

`MVP_DEPLOYED_WATERMARKS` is new, and `validateSourceManifest` uses it: a
`runtime: deployed` source may declare `highWaterId`, because its cursor is
returned byte-for-byte, while a bundled source may not, because that runtime
parses the cursor and a shape it does not name parses to nothing. The refusal
message says which case you are in.
