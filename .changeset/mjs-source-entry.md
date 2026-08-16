---
'@ontrove/cli': patch
---

`trove source deploy` accepts `index.mjs`, not only `index.ts`.

It looked for a single hardcoded filename, so it could not deploy any source
in the catalogue it exists to serve — every one is plain ESM, including ones
already running in production, which had to be deployed some other way.
esbuild bundles either. `index.ts` still wins when both are present, since
that is what `source init` scaffolds.
