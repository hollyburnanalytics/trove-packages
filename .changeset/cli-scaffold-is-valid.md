---
'@ontrove/cli': patch
---

`trove source init` now scaffolds a manifest that `trove source validate`
accepts. It did not: `kind` held a transport (`feed`), `transport` held a value
from no vocabulary (`http`), `document_semantics` was both the former field name
and a value that never existed (`text`), and `watermark` and `location` were
missing. Nothing objected, because the validator did not yet know the
vocabulary — so a new author's first two commands succeeded and their first
deploy did not.
