---
'@ontrove/sdk': minor
---

Add `stringList`, for reading a `url[]`/`text[]` config field a user filled in.

Both source catalogs had grown the same function independently — same name,
same body, two repositories — and it belongs with the package that defines
`SourceContext.config`. A list field does not arrive in one shape: the web
form, the Mac app, the CLI and the directory pickers variously send a list, the
bare string somebody pasted, `null`, or nothing, so a source has to narrow
before it reads.

Writing tests for it on the way in found a bug both copies shared: a `null`
*inside* the list survived, because `String(null)` is the four-character string
`"null"` and `filter(Boolean)` keeps it. A `url[]` field with a hole in it
produced a feed address of `"null"`, which resolved as a relative URL and
failed as a 404 from the source's own host rather than as the bad config it
was. Entries that are `null` or `undefined` are now dropped before coercion.
