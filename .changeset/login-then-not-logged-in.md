---
'@ontrove/cli': patch
'@ontrove/sdk': patch
---

Fix every command reporting "Not logged in" straight after `trove login`.

`trove login` stores a refresh token; the access token it mints is short-lived
and often absent moments later. That state was reported as being logged out,
and the advice — run `trove login` — was not just unhelpful but wrong, since
logging in again returns you to the same place.

The recovery already existed and was already tested: `onAuthFailure` renews an
expired token mid-command on a 401. It never ran, because the CLI failed
locally before any request could come back 401. A client is now built whenever
refresh credentials are present, and the first 401 drives the same refresh.
Being genuinely logged out still fails, and still says the one thing that fixes
it.

`@ontrove/sdk` gains `contract` on `ContractFixtures` — always present in the
JSON, missing from the type. It matters most to the reader that cannot use the
type at all: a plain-JavaScript runner opens the raw file and has only these
keys to confirm it read the right one.
