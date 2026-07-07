# Contributing to Trove Packages

Thanks for your interest! This monorepo holds the three published `@ontrove/*`
packages. Most changes touch a single package.

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.2 and Node ≥ 20.

```bash
bun install        # install + link the workspace
bun run check      # lint + typecheck + test + build (the full gate CI runs)
```

To iterate on one package, `cd packages/<name>` and use its own
`build` / `test` / `test:watch` / `lint` scripts.

## Making a change

1. Make your change in the relevant package(s) under `packages/`.
2. Add or update tests; keep `bun run check` green.
3. **Add a changeset** describing the change:
   ```bash
   bun run changeset
   ```
   Pick the affected packages and bump type (patch/minor/major) and write a short
   summary. Commit the generated `.changeset/*.md` file with your PR.

## Notes

- `@ontrove/cli` depends on `@ontrove/sdk` and `@ontrove/mcp`; the workspace links
  them locally, but their manifests carry real published semver ranges.
- Public API changes need a `minor` (additive) or `major` (breaking) changeset.

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
