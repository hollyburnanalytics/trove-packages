---
'@ontrove/mcp': minor
---

`TroveIngestDoc` gains `externalId` — the upstream's own stable id (a video id,
an arXiv id, an episode id).

It is the dedup key within the feed: saving the same `externalId` twice is
idempotent, and the second save returns the document already there instead of
creating a duplicate. Set it whenever the upstream has an id, which is nearly
always. Omit it and every save is a new document — right for content with no
upstream identity (a note), wrong for everything else.

Requires the matching knowledge-base change to take effect.
