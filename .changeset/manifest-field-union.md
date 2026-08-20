---
'@ontrove/extend': minor
---

The manifest and context types describe what the catalogs and runtimes actually
use — measured as a union across all 124 manifests and all three runtimes, in
one pass rather than a field per release.

- `SourceManifest.historyReach` was `string`; every one of the 24 declarations
  is `{ kind, note }`. Now `HistoryReach`, with `HISTORY_REACH_KINDS`
  (`full` | `window` | `recent-only`) and a `checkHistoryReach` rule, so the
  shape is enforced at import time rather than merely described.
- `SourceManifest.fanOut` was `Record<string, unknown>`; all seven uses are a
  bare key name, and `checkFanOut` has always required a string. The type was
  the only thing that disagreed.
- `SourceManifest.generated` is declared. Every generated manifest carries it.
- `ExtensionContext.cache` is declared: Trove's cloud runtime supplies it and
  two sources read it, but no type said so. Optional, because a host may
  provide none.
- `SourceContext.browser` is declared, for `needsBrowser` sources. Only the Mac
  runtime supplies one.

`historyReach` is the sole breaking shape, and no published manifest used the
old one, so nothing on npm needs changing.
