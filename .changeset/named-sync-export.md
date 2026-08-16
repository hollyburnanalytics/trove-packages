---
'@ontrove/cli': patch
---

`trove source` accepts a bare `export async function sync(ctx)`.

The source commands required `export default defineSource({ sync })` and
rejected everything else — which is every source in the catalogue, including
adapters already syncing in production. A source's whole contract is one
`sync(ctx)` function, and `createSourceWorker` already normalises a bare
function to `{ sync }`, so the wrapper was never load-bearing at the runtime
end. `run`/`test`/`sync` also only looked for `index.ts`, so they could not
open a `.mjs` project either.
