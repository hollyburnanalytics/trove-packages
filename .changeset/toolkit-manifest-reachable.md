---
'@ontrove/extend': major
---

A toolkit's manifest is reachable from the compiled server, and `visibility`
is spelled the way it is stored.

**`ToolkitDefinition` now carries `manifest`.** `defineToolkit` returned only
`tools` and `handle`, so the declaration that produced the server was
unreachable the moment the module finished loading. `defineSource` returns the
source object itself, which is why sources could have a contract test pinning
`manifest.json` to the code and toolkits could not — and why
`toToolkitManifest` shipped with no callers at all.

That asymmetry had teeth: deploy reads `egress`, `scopes` and `secrets` off the
committed file, so a manifest that drifted from the code shipped the
permissions the code no longer asked for, and nothing could tell.

```ts
const toolkit = defineToolkit({ ... });
toolkit.manifest; // the JSON the catalog commits, minus tools and auth
```

**BREAKING: `visibility` takes `'shared' | 'private'`, not `'public' | 'private'`.**
The value is persisted as the registry's lowercase `visibility` column
(`CHECK(visibility IN ('private','shared'))`) and surfaced as the GraphQL
`McpServerVisibility` enum, `PRIVATE | SHARED`. `public` appeared nowhere
except this package — nothing translated it, and nothing read it, so the field
could not be checked end to end.

To upgrade, replace `visibility: 'public'` with `visibility: 'shared'` in the
toolkit declaration and in the committed `manifest.json`. `private` is
unchanged, and toolkits that omit the field are unaffected.
