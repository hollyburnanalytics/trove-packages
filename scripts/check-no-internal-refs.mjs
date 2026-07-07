#!/usr/bin/env node
/**
 * Guard: fail if any *shipped or tracked* prose carries a reference to Trove's
 * internal design docs. These leak nothing secret on their own, but they are
 * dangling pointers for public readers and expose naming we don't document.
 * See CLAUDE.md → "Documentation" for the policy and the public-facing
 * alternatives.
 *
 * Scope = what becomes public: every package `src/**.ts` (sdk/mcp publish `src`;
 * cli's `dist` is built from it), the package READMEs, plus the tracked prose at
 * the repo root and under `docs/` and `packaging/`. `test/` is not shipped.
 *
 * The committed rules below match only generic, non-revealing patterns
 * (design-doc citations, decision tags). A private, git-ignored
 * `internal-denylist.local.mjs` beside this file may add maintainer-only rules
 * for hosting-internal names; it is absent in a fresh clone, which is fine.
 *
 * Run standalone (`node scripts/check-no-internal-refs.mjs`) or via `bun run
 * check`. Exits non-zero (listing every offending file:line) on a hit.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * Generic, non-revealing rules — safe to keep in the public repo. They match the
 * *shape* of an internal citation without naming any private component.
 */
const RULES = [
  { re: /docs\/\d/, why: 'internal design-doc citation (e.g. docs/20 §3) — keep the prose, drop the pointer' },
  { re: /\bRFC docs\//, why: 'internal RFC citation — describe the behaviour instead' },
  { re: /\bD(?:1|2|9|14)\b(?=[^a-zA-Z0-9]*(?:§|\)|\/|,|\.|$))/, why: 'internal decision tag (D1/D2/D9/D14) — delete' },
];

/**
 * Load maintainer-only rules from the git-ignored local denylist, if present.
 * Absent in a public clone — the generic rules above still run.
 */
async function loadRules() {
  try {
    const extra = (await import('./internal-denylist.local.mjs')).default;
    if (Array.isArray(extra)) return [...RULES, ...extra];
  } catch {
    // No local denylist — generic rules only.
  }
  return RULES;
}

/**
 * Tracked files that become public and carry prose: package `src/**.ts`, the
 * package + root READMEs, and everything under `docs/` and `packaging/`.
 * (`git ls-files` pathspecs don't recurse with `*`, so we list tracked files and
 * filter here.) This script and the local denylist are excluded so the guard
 * never matches its own rule text.
 */
function trackedProse() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(
      (f) =>
        /^packages\/[^/]+\/src\/.*\.ts$/.test(f) ||
        /^packages\/[^/]+\/README\.md$/.test(f) ||
        f === 'README.md' ||
        f === 'CLAUDE.md' ||
        /^docs\/.*\.md$/.test(f) ||
        /^packaging\/.*\.md$/.test(f),
    );
}

const rules = await loadRules();
const files = trackedProse();
const hits = [];
for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { re, why } of rules) {
      if (re.test(line)) hits.push({ rel, line: i + 1, text: line.trim(), why });
    }
  });
}

if (hits.length > 0) {
  console.error(`\n✖ ${hits.length} internal reference(s) found in tracked prose:\n`);
  for (const h of hits) {
    console.error(`  ${h.rel}:${h.line}  — ${h.why}`);
    console.error(`      ${h.text}`);
  }
  console.error('\nSee CLAUDE.md → "Documentation" for the public-facing alternatives.\n');
  process.exit(1);
}

console.log(`✓ no internal references in tracked prose (${files.length} files scanned)`);
