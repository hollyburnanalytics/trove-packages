---
'@ontrove/cli': minor
---

`extension.ts` is the entry filename for both extension kinds, and `init`
scaffolds it.

Resolution accepts the names it replaces — sources `index.ts`/`index.mjs`,
toolkits `server.ts` — because these directories belong to the author, not to a
catalog anyone versions, and the CLI has to open what is actually on disk.
`extension.ts` wins where both exist: a half-finished rename should resolve to
the file you just wrote, not the one you meant to replace.

The two toolkit paths now search **one shared list** (`TOOLKIT_ENTRY_FILENAMES`
in `lib/bundle`). They were briefly two, which was long enough to ship a `dev`
that found the file and a `deploy` that did not.
