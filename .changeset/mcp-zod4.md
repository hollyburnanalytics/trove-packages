---
"@ontrove/mcp": minor
---

Support Zod 4 in addition to Zod 3. Tool input schemas now compile to JSON Schema
via Zod 4's native `z.toJSONSchema` when the caller uses `zod@^4`, falling back
to `zod-to-json-schema` on `zod@^3.25` — the peer range widens to
`^3.25.28 || ^4`. Output is normalized so the emitted schema (including a closed
`additionalProperties: false` root) is identical across both Zod versions.
