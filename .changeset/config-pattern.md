---
'@ontrove/extend': minor
---

`ManifestConfigField` gains `pattern` — a regex a preference value must match.

Two shipped toolkits already declared it, so it was a field their authors could
write and the compiler could not see. Whether a client enforces the pattern is a
separate question from whether an author may state it.
