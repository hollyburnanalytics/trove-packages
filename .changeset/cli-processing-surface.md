---
'@ontrove/cli': patch
---

`trove get` no longer breaks against the current API, and no longer decides for itself what the pipeline's stages are.

`GET_DOCUMENT` selected `audioDownloadedAt`, `transcribedAt`, `extractedAt` and `embeddedAt`. Those fields are gone from the API, and GraphQL rejects a query that names an unknown field — so this did not degrade to a missing row, it failed the whole `get` operation. The CLI has no schema-drift CI, so nothing would have caught it before a user did.

The replacement is the point rather than a patch. That block was five hard-coded rows read off five nullable date columns, which meant the CLI decided what the pipeline's stages **were** — and printed a stale list the moment the server's stage set changed. It is now a loop over the stages the server reports, so a sixth stage appears with no change here.

A `SKIPPED` stage is shown with its state rather than hidden. "not needed" answers *"why is there no formatted version of this"*, which the old blank row could not distinguish from "never ran".

`lastProcessedAt` survives — it answers a different question, and the API now derives it from the stage ledger rather than from a column nothing writes.
