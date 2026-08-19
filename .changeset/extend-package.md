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
