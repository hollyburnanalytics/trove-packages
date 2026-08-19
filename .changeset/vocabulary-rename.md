---
'@ontrove/sdk': major
'@ontrove/mcp': major
'@ontrove/cli': major
---

One word per concept. Breaking, with no compatibility aliases.

Every rename here fixes a place the codebase spelled one idea two ways, which
is how the SDK's type and Trove's "reconciled shape" drifted into disagreeing
about `readonly values` and `max?` — two names for one thing is two things
that can differ.

| was | is |
| --- | --- |
| `Watermark`, `dateWatermark`, `idSetWatermark`, `readDateWatermark`, `advanceDateWatermark`, `WATERMARK_STRATEGIES`, `WatermarkStrategy`, `MVP_DEPLOYED_WATERMARKS` | `Cursor`, `dateCursor`, `idSetCursor`, `readDateCursor`, `advanceDateCursor`, `CURSOR_STRATEGIES`, `CursorStrategy`, `MVP_DEPLOYED_CURSORS` |
| `SourceDocument` | `Document` |
| `SourceLocation`, `LOCATIONS` | `RunsIn`, `RUNS_IN` |
| `DocumentSemantics`, `DOCUMENT_SEMANTICS` | `IngestMode`, `INGEST_MODES` |
| manifest `watermark` | manifest `cursor` |
| manifest `documentSemantics` | manifest `ingest` |
| manifest `needs_browser` | manifest `needsBrowser` |
| manifest `location`, value `client` | manifest `runsIn`, value `mac` |

`cursor` wins over `watermark` because it is what `ctx.cursor` was already
called, what the stored column is called, and what the published invoke
contract already said in all twenty-five of its references — the wire was
right and the type was the outlier. `needsBrowser` was the only snake_case key
among fifteen camelCase ones. `mac` says where the code runs; `client` said
which side of a protocol it sat on.

Consumers must update together: there are no aliases, and a manifest using the
old keys now fails validation rather than being quietly ignored.
