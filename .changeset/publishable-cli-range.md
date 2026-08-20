---
'@ontrove/cli': patch
---

`@ontrove/cli` depended on `@ontrove/extend` as `workspace:*`, which is a
monorepo-local instruction rather than a version range. `changeset publish`
shells out to `npm publish`, which ships it verbatim — so `@ontrove/cli@2.0.0`
reached the registry with a specifier no installer outside this repo can
resolve, and `bun add -g @ontrove/cli` failed outright.

Restores a real range (`^2.0.0`), and adds `deps:check` to the gate. The check
has to be a rule about the manifest rather than a test, because inside the
workspace the protocol resolves perfectly: this is a defect that exists only
once the package leaves the place it is tested.
