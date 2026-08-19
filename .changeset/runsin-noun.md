---
'@ontrove/sdk': patch
---

Finish the `location` → `runsIn` rename inside the validator.

The field, the type and the vocabulary were renamed, but three things kept the
old word where a regex could not see them: the error text still read "is not a
known location", the local variable was still `const location`, and the doc
comment still described `location`.

The local one mattered more than it looks. Removing a variable named
`location` does not leave an unbound identifier — it silently rebinds to the
DOM `Location` global, so `location !== 'cloud'` kept compiling while
comparing a `Location` object to a string. `tsc` caught it ("types 'Location'
and 'string' have no overlap"); nothing at runtime would have.
