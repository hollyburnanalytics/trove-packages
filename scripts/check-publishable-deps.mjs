#!/usr/bin/env node
/**
 * No published package may depend on another through the `workspace:` protocol.
 *
 * ## Why
 *
 * `workspace:*` is a monorepo-local instruction, not a version range. `changeset
 * publish` shells out to `npm publish`, which does not rewrite it — so the
 * tarball goes to the registry carrying a specifier no installer outside this
 * repo can resolve. `@ontrove/cli@2.0.0` shipped that way and could not be
 * installed at all; every check in CI passed, because inside the workspace the
 * protocol resolves perfectly.
 *
 * That is the tell: this is a bug that only exists once the code leaves the
 * place where it is tested. So the gate has to be a rule about the manifest, not
 * a test run in the workspace.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const manifests = execFileSync('git', ['ls-files', 'packages/*/package.json'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

/** Dependency kinds that end up in the published tarball's manifest. */
const SHIPPED = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const offenders = [];
for (const rel of manifests) {
  const pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  if (pkg.private === true) continue;
  for (const kind of SHIPPED) {
    for (const [name, range] of Object.entries(pkg[kind] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        offenders.push({ pkg: pkg.name, kind, name, range });
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('\n✖ A published package depends on another via the workspace protocol:\n');
  for (const o of offenders) {
    console.error(`  ${o.pkg} → ${o.kind}.${o.name} = "${o.range}"`);
  }
  console.error(
    '\nnpm publishes this verbatim, so the tarball is uninstallable outside this\n' +
      'repo. Use a real semver range (e.g. "^2.0.0").\n',
  );
  process.exit(1);
}

console.log(`✓ publishable deps — ${String(manifests.length)} manifest(s) carry real ranges`);
