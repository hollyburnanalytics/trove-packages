---
'@ontrove/extend': minor
---

`ManifestConfigField` gains the four keys the catalogs already use: `pattern`,
`hint`, `default` and `directory`.

The type described three keys; the manifests used seven. Every one of the four
was something an author could write and the compiler could not see — including
`directory`, which is what turns a text input into a searchable picker, and so
is among the most consequential things a field can declare.

Found by taking the union of config keys across all 124 manifests rather than
one compile error at a time.
