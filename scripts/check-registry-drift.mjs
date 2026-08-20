#!/usr/bin/env node
/**
 * Every publishable package's version must be **ahead of or equal to** what the
 * registry already has.
 *
 * ## Why this is its own check
 *
 * `@ontrove/extend@3.2.0` reached npm from a `changeset version` run locally
 * whose result was never committed. `main` stayed at 3.1.0 while the registry
 * moved to 3.2.0, and the changeset that produced it stayed in `.changeset/`
 * looking unreleased. The next `changeset version` therefore consumed it a
 * SECOND time and produced 3.2.0 again — a version that already existed, which
 * `npm publish` refuses and `changeset publish` skips without much noise.
 *
 * Nothing in the repo could see this, because the repo has no idea what is on
 * npm. That is the whole gap: a number held in two places, one of which nobody
 * compiles. The same shape as `check-changeset-config` and
 * `check-publishable-deps` — and, at this point, the same shape as most of the
 * bugs this package has had.
 *
 * Behind the registry is the error. AHEAD is normal: that is exactly what a
 * pending release looks like between `changeset version` and `changeset
 * publish`.
 *
 * Skipped offline (`SKIP_REGISTRY_CHECK=1`, or any network failure), because a
 * check that cannot reach the registry has nothing to say and must not be the
 * reason a build fails on a train.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Compare two semver strings.
 *
 * @param {string} a - The left version.
 * @param {string} b - The right version.
 * @returns {number} Negative when `a` sorts before `b`, positive after, 0 equal.
 */
function compare(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The version the registry currently serves as `latest`.
 *
 * @param {string} name - The package name.
 * @returns {string | null} The version, or `null` when unreachable or unpublished.
 */
function publishedVersion(name) {
  try {
    return execFileSync('npm', ['view', `${name}@latest`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

if (process.env.SKIP_REGISTRY_CHECK === '1') {
  console.log('registry drift — skipped (SKIP_REGISTRY_CHECK=1)');
  process.exit(0);
}

const problems = [];
let checked = 0;

for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(ROOT, 'packages', entry.name, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private === true || typeof manifest.name !== 'string') continue;

  const published = publishedVersion(manifest.name);
  if (published === null) continue; // unpublished, or offline
  checked += 1;

  if (compare(manifest.version, published) < 0) {
    problems.push(
      `${manifest.name}: repo says ${manifest.version}, registry serves ${published}.\n` +
        `  The repo is BEHIND npm — a release was published without its version\n` +
        `  bump being committed. Set the version to ${published} and re-run\n` +
        `  \`changeset version\`, or the next release will try to republish a\n` +
        `  version that already exists.`,
    );
  }
}

if (problems.length > 0) {
  console.error('✗ registry drift — repo is behind npm:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}\n`);
  process.exit(1);
}

console.log(`✓ registry drift — ${String(checked)} package(s) at or ahead of npm`);
