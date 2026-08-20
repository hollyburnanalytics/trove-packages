---
'@ontrove/extend': major
'@ontrove/cli': major
---

`@ontrove/sdk` and `@ontrove/mcp` become one package, `@ontrove/extend`.

```
@ontrove/extend            the shared spine: ExtensionContext, the guarded fetch
@ontrove/extend/source     defineSource, cursors, config, the manifest vocabulary
@ontrove/extend/toolkit    defineToolkit, tool, ToolError, z
@ontrove/extend/contract   the invoke contract fixture
```

`sdk` said nothing about what it was for, and `mcp` named a protocol that the
product taxonomy calls an implementation detail. What an author builds is a
source or a toolkit, and now that is what they import.

**The merge earns itself on the spine.** `ExtensionContext` — a credential, a
guarded fetch, a log line, the clock — was declared twice, in two packages that
could not import each other, with a type-level assertion in the CLI holding
them together. That assertion worked, and it was the right answer for two
packages; it is unnecessary for one. `ToolContext` now `extends
ExtensionContext`, `LogChannel` has one declaration instead of two
"structurally identical, deliberately" copies, and agreement is structural
rather than checked.

Renamed with it, for the same reason `mcp` went: `defineMcpServer` →
`defineToolkit`, `McpServerDefinition` → `ToolkitDefinition`, `McpServerConfig`
→ `ToolkitConfig`, `McpToolCall*` → `ToolCall*`, `McpErrorCode` →
`ToolErrorCode`.

`zod` stays a PEER dependency of the merged package, as it was of `@ontrove/mcp`
— a toolkit and its host must not end up with two copies of zod's types.

**The deploy bundlers now refuse an `@ontrove/*` specifier they do not supply**,
instead of falling through to on-disk resolution. That fall-through is why this
needed saying: renaming the package updated the wrapper's import text and left
the resolver matching the retired name, and nothing failed — a workspace has the
package on disk, and the compiled binary does not. So the bundle looked fine in
CI and would have broken at deploy. The specifier is now one constant feeding
both the wrapper and the filter, and a failed bundle reports the bundler's own
reasons rather than a bare "Bundle failed".

A source may import `@ontrove/extend`, the shared spine — `/source` re-exports
all of it. A toolkit may not: `/toolkit` does not re-export the guarded-fetch
helpers, so supplying it there would hand back a module missing `fetchPage`.
