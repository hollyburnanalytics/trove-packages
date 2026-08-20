#!/usr/bin/env node
/**
 * Every package named in `.changeset/config.json` must exist in the workspace.
 *
 * ## Why this is its own check
 *
 * The `fixed` group named `@ontrove/sdk` and `@ontrove/mcp` for one commit after
 * they were merged into `@ontrove/extend`. Nothing noticed: the config is not
 * TypeScript, no test reads it, and `bun run check` never opened it. The failure
 * surfaced in the **release** job, after the PR was merged — the one place where
 * a failure means nothing publishes and the fix needs a second PR.
 *
 * Validating it here moves that failure to where it is cheap. It is the same
 * lesson the merge itself was about: a name held in two places drifts, and the
 * copy nobody compiles is the one that drifts silently.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** @returns {Set<string>} Every package name in the workspace. */
function workspacePackages() {
  const dirs = execFileSync('git', ['ls-files', 'packages/*/package.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return new Set(dirs.map((rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')).name));
}

const config = JSON.parse(readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8'));
const present = workspacePackages();

/** Every package name the config refers to, with the option it came from. */
const referenced = [
  ...[...(config.fixed ?? []), ...(config.linked ?? [])].flatMap((group, i) =>
    group.map((name) => ({ name, where: `fixed/linked group ${String(i)}` })),
  ),
  ...(config.ignore ?? []).map((name) => ({ name, where: 'ignore' })),
];

// A glob is legitimate here (changesets accepts micromatch), and resolving one
// properly is the changesets CLI's job, not this check's. Skip them rather than
// report a false positive.
const missing = referenced.filter(
  ({ name }) => !/[*?[\]{}!]/.test(name) && !present.has(name),
);

if (missing.length > 0) {
  console.error('\n✖ .changeset/config.json names packages that do not exist:\n');
  for (const { name, where } of missing) console.error(`  ${name}  (${where})`);
  console.error(
    `\nWorkspace packages: ${[...present].sort().join(', ')}\n` +
      'Left unfixed, the release job fails AFTER merge and nothing publishes.\n',
  );
  process.exit(1);
}

console.log(
  `✓ changeset config — ${String(referenced.length)} package reference(s) all resolve`,
);
