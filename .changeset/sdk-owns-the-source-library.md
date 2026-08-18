---
'@ontrove/sdk': minor
---

The SDK now owns the pieces a source needs in order to be **correct**, not only
the shapes it has to match.

- **The watermark writer** — `dateWatermark`, `idSetWatermark`,
  `advanceDateWatermark` and their readers, with the entry cap AND the byte
  budget the platform's cursor limit requires. The wire-contract test now
  asserts its fixtures against the writer that produces them, instead of pinning
  bytes written elsewhere.
- **The guarded fetch seam** — `fetchPage`, `fetchPageWithMeta`, `fetchBytes`
  and `assertPublicHttpUrl`, with the host guard, request timeout,
  declared-length cap and streaming byte cap. It uses the `fetch` it is given,
  so a source called with a capability-bearing `ctx.fetch` goes through that
  one. The guard refuses IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), which
  normalizes to a form with no dotted quad left to check and slipped past a
  hand-written implementation of the same rules.
- **The manifest vocabulary** — `SOURCE_KINDS`, `TRANSPORTS`, `LOCATIONS`,
  `WATERMARK_STRATEGIES`, `DOCUMENT_SEMANTICS`, `FORMATTING`, `MVP` and the
  rest, with per-field validation folded into `validateSourceManifest`.

No existing export changed shape; `validateSourceManifest`'s new second
parameter is optional.
