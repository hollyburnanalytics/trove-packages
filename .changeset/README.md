# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

When you make a change to one or more packages, run:

```bash
bun run changeset
```

Pick the affected packages and the bump type (patch/minor/major) and write a
short summary. Commit the generated file under `.changeset/`. On merge to `main`,
the release workflow opens a "Version Packages" PR; merging that publishes to npm.
