---
'@ontrove/cli': major
---

**Breaking: `trove mcp <…>` is now `trove toolkit <…>`.** No alias — the old
verb is gone and reports an unknown command (the help printed underneath names
the new one).

MCP is an implementation detail; **toolkit** is the word for the thing a user
deploys, and the CLI was the last surface still saying otherwise (docs/28).
Every subcommand moves unchanged: `ls`, `deploy`, `pause`, `resume`,
`rollback`, `rm`, `init`, `dev`, `logs`.

Also removed: the top-level `deploy` alias for `mcp deploy`. With `source
deploy` alongside it, a bare `deploy` silently meaning *toolkit* was a coin
flip; say which noun you mean.

`secret set|ls` are unchanged and now have their own line in `--help`.
