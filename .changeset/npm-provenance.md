---
"@ontrove/sdk": patch
"@ontrove/mcp": patch
"@ontrove/cli": patch
---

Publishes now include a signed npm provenance attestation, so consumers can
cryptographically verify each tarball was built and published from this repo's
release workflow at a specific commit.
