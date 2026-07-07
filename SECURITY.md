# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately by email to **security@hollyburnanalytics.com**
(or `matt@hollyburnanalytics.com`). We aim to acknowledge reports within a few
business days and will keep you updated on remediation.

When reporting, please include a description of the issue, its potential impact,
and steps to reproduce.

## Scope

These packages are libraries and a CLI. The CLI handles credentials you supply
(it stores an auth token in the OS keychain, or `~/.trove/config.toml` with
`chmod 600`). Never commit secrets; the CLI never logs or bundles them.

## Supported versions

Security fixes are applied to the latest published version of each package on the
`main` branch.
