---
"@ontrove/mcp": minor
---

`ctx.trove.ingest` documents can now capture a file by URL. `TroveIngestDoc`
gains `fileUrl`/`audioUrl` + `mimeType` (the file Trove fetches and stores) and a
`captureOnly` flag that retains the artifact plus a searchable metadata record
without running the AI processing (transcription / text extraction) — so a
toolkit can capture now and enrich later. `text` is now optional when a file is
supplied.
