---
'@ontrove/mcp': minor
'@ontrove/cli': minor
'@ontrove/sdk': minor
---

Require Zod 4.

The SDK claimed `zod: ^3.25.28 || ^4` and only half meant it. The runtime
genuinely worked on both — it detected `z.toJSONSchema` and picked a converter —
but the TYPES were Zod 3's: tool inputs were constrained with `z.ZodTypeAny`,
which Zod 4 removed. On Zod 4 that constraint stopped resolving, `I` fell back to
its default, and `z.infer<I>` became `unknown`.

It failed silently, which is the part worth fixing. A consumer on Zod 4 did not
get an error at install or a broken build — they got handlers whose arguments
were `unknown`, reported as errors in their own code. One repo carried 110 of
those before anyone traced them here.

So: `z.ZodTypeAny` → `z.ZodType` (the name that exists in both), the peer range
narrows to `^4`, and the Zod 3 branch goes with it — including the
`zod-to-json-schema` dependency, now that `z.toJSONSchema` is always there. A
consumer still on Zod 3 now fails at install, loudly, instead of at typecheck,
mysteriously.

Migrating: most Zod 3 schemas need no change. `.passthrough()`, `z.url()` and
two-argument `z.record()` all work as before; the common break is one-argument
`z.record(v)`, which Zod 4 requires be written `z.record(z.string(), v)`.
