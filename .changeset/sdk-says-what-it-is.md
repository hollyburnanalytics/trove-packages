---
'@ontrove/sdk': patch
---

Documentation only: the package now describes what it owns (the invoke
contract, the types, `runSource`, manifest validation) and what it does not yet
own (the helpers a source is actually written against — feed parsing, HTML to
text, the scrape loop, the watermark writer). The previous wording called it
"the thin standard library for authoring Trove sources", which described the
intended destination rather than the current package.
