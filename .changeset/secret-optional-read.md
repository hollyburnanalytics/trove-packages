---
'@ontrove/extend': minor
'@ontrove/cli': patch
---

`ctx.secret(name)` resolves `undefined` for a credential that is declared but
not set; `ctx.requireSecret(name)` is the half that raises.

They were documented as behaving "identically; the name is the documentation" —
two names for one behaviour, and no way at all to read an optional credential.
**Four toolkits had independently written the same workaround**
(`try { await ctx.secret(n) } catch { return undefined }`): x, pocket-casts,
bunkers and usda-agtransport. Two sources skipped the mechanism entirely and
reached into the legacy `ctx.credentials` bag instead. Optional credentials are
ordinary — an API key that raises a rate limit, an OAuth client secret a public
client does not have.

`/internal/secret` answers `200 { value: null }` for declared-but-unset, so the
SDK can tell it apart from a name the manifest never declared, which still
fails. A host implementing the callback must return `null` rather than an error
status for an unset credential.

Also: `toWireDocument` carries `fallback`. It is accepted by Trove's ingest and
carried on the local path, and this mapper dropped it — the same silent-drop
that lost `contentType` on the deployed path once already.
