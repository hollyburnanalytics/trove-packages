---
'@ontrove/extend': minor
---

A toolkit can declare a connection Trove holds for it, instead of holding an
OAuth refresh token it cannot keep.

The interesting providers rotate: the provider issues a new refresh token and
kills the old one, and a toolkit has no way to write a secret back. Every
toolkit that tried ended up telling its user to re-authorize by hand, once a
day, forever — `mcp/x`'s bookmark tools are the worked example.

```ts
defineToolkit({
  auth: { type: 'oauth_connection', provider: 'intuit', connectLabel: 'Connect QuickBooks' },
  tools: [ /* … */ ],
});

// in a handler:
const token = await ctx.requireAccessToken();
```

Trove runs the authorization flow, stores the tokens, refreshes them under a
per-tenant lock, and hands back one that is valid now. The toolkit never sees
the refresh token, never sees the client credentials (they are Trove's, not
the toolkit's), and never stores anything.

`requireAccessToken` is present only on a toolkit that declares a connection,
and raises — naming the provider, not retryable — when nobody has connected it
or when the connection needs reauthorizing. Both are fixed by a person in the
dashboard, which is what the message says.

The declaration is carried into the emitted manifest, because the platform
renders the Connect button from it. A `oauth2_client_credentials` block still
is not: that one is wiring between a toolkit and its own vaulted secrets, and
nothing outside the toolkit has a part in it.
