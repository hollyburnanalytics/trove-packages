---
"@ontrove/cli": minor
---

`trove search` gains a `--sort` option (`relevance` | `published` | `ingested`):
`relevance` (default) keeps the search ranking, `published` re-sorts the top
relevant matches newest-published first, and `ingested` orders by most-recently
added. `trove get` now shows both date axes — `published` (when the content was
created) and `indexed` (when Trove ingested it) — plus the per-stage processing
timestamps (audio downloaded / transcribed / extracted / embedded / last
processed) for the stages a document actually went through.
