---
'@ontrove/mcp': minor
---

`TroveIngestDoc` gains `date` and `tags`.

`date` is the content's own **publish** date (ISO 8601) — when the paper, episode
or video was published, not when you are saving it. Set it whenever the upstream
tells you: only the toolkit knows the real date, and it is what recency ranking
and date filters sort on. A document saved without one is only ever as old as the
day it was ingested.

`tags` files the document under free-text tags (trimmed, deduped, max 32 × 64
chars).

Both fields were already accepted by the knowledge base; the SDK simply had no
way to express them, so every hosted save landed undated.
