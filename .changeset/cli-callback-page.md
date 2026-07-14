---
'@ontrove/cli': minor
---

`trove login`'s browser callback page is now a real page — and tells the truth when a sign-in fails.

It was a bare `<h2>Trove CLI</h2>` on a white background: the one part of the CLI a user ever sees, looking like a 1997 error. It now carries Trove's own palette, works in light and dark, and is entirely self-contained — no fonts, stylesheets or images fetched from anywhere, so it renders on a plane or behind a corporate proxy rather than sitting blank after a login that already worked.

More importantly, a **failed** sign-in no longer claims success. The handler used to answer *"You may close this window"* whatever came back — so a denied or malformed authorization looked exactly like a good one, and you returned to a terminal that had failed with no idea why. A refusal now says so, in the browser and in the terminal.
