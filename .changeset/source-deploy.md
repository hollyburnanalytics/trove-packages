---
'@ontrove/cli': minor
---

Add `trove source deploy` — one command to put a source on Trove's own schedule.

Deploying a source previously meant bundling it by hand and calling a GraphQL
mutation from a browser console. `trove source deploy` now bundles `index.ts`
with a runtime shim that adapts the sandbox's request to your existing
`sync(ctx)` — nothing in a source is deployment-specific — and hands the result
to `deploySource`.

The two rules that come with the sandbox are refused locally, so you hear them
while the file is still open rather than hours later on a machine you cannot
see: `manifest.json` must declare `egress` (the hosts the source may reach, its
entire reach), and a deployed source is given no credentials (`sync(ctx)` sees
`ctx.config` and nothing else). A deployment that does not go live exits
non-zero and says why.
