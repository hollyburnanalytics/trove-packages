---
"@ontrove/extend": minor
---

Toolkits can now read files the caller staged in Trove: declare the `trove:files` scope and `ctx.files.read(fileId)` returns the file's name, type, size, sha256 and bytes. It is how a tool takes a receipt, invoice or PDF without the bytes travelling inside the tool call — the caller uploads the file to a one-time link and passes the id. The bytes are checked against the hash taken at upload before they are handed over, so a damaged transfer raises a retryable `ToolError` instead of being passed on.
