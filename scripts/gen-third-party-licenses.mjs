#!/usr/bin/env node
/**
 * Generate THIRD-PARTY-LICENSES.txt for the standalone `trove` binaries.
 *
 * The Bun single-binary statically embeds the CLI's production dependency tree
 * (zod, zod-to-json-schema, open, …). MIT/ISC/BSD terms require the license text
 * and copyright notice to travel with any redistribution, so we bundle an
 * aggregated notice file into each release tarball.
 *
 * Walks the CLI's production deps transitively — descending through the
 * first-party `@ontrove/*` packages to pick up *their* third-party deps, but not
 * listing the `@ontrove/*` packages themselves (they are MIT under this repo's
 * own LICENSE). Resolves each package from the installed workspace, reads its
 * declared license and license file, and writes a deduped, sorted notice.
 *
 * Usage: node scripts/gen-third-party-licenses.mjs [outfile]
 *   default outfile: dist/bin/THIRD-PARTY-LICENSES.txt
 *
 * @module
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = process.argv[2] || join(ROOT, 'dist', 'bin', 'THIRD-PARTY-LICENSES.txt');

// Resolve package directories from the filesystem rather than `require.resolve`
// — packages with strict `exports` (e.g. `open`) hide `./package.json`, and Bun
// installs into an isolated `.bun/<name>@<version>/node_modules/<name>` store
// rather than a flat tree. Search the direct-dep symlinks first, then that store.
const NM_BASES = [
  join(ROOT, 'packages', 'trove-cli', 'node_modules'),
  join(ROOT, 'packages', 'trove-extend', 'node_modules'),
  join(ROOT, 'node_modules'),
];
const BUN_STORE = join(ROOT, 'node_modules', '.bun');

/** Resolve a package's directory (the folder holding its package.json), or null. */
function pkgDir(name) {
  for (const base of NM_BASES) {
    const p = join(base, name);
    if (existsSync(join(p, 'package.json'))) return realpathSync(p);
  }
  // Bun store: node_modules/.bun/<name>@<version>/node_modules/<name>.
  if (existsSync(BUN_STORE)) {
    const enc = `${name.replace('/', '+')}@`;
    const hit = readdirSync(BUN_STORE).find((d) => d.startsWith(enc));
    if (hit) {
      const p = join(BUN_STORE, hit, 'node_modules', name);
      if (existsSync(join(p, 'package.json'))) return p;
    }
  }
  return null;
}

const LICENSE_FILES = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.\w+)?$/i;

/** Find and read the license text shipped in a package directory, if any. */
function licenseText(dir) {
  for (const f of readdirSync(dir)) {
    if (LICENSE_FILES.test(f)) return readFileSync(join(dir, f), 'utf8').trim();
  }
  return null;
}

/** SPDX id (or a readable fallback) from a package.json. */
function spdx(pj) {
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license?.type) return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => l.type || l).join(' OR ');
  return 'UNKNOWN';
}

const collected = new Map(); // key: name@version → { name, version, license, text }
const missing = [];

function walk(name) {
  const dir = pkgDir(name);
  if (!dir) {
    if (!name.startsWith('@ontrove/')) missing.push(name);
    return;
  }
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${pj.name}@${pj.version}`;
  const firstParty = pj.name.startsWith('@ontrove/');

  // Record third-party packages; skip our own (covered by this repo's LICENSE).
  if (!firstParty && !collected.has(key)) {
    collected.set(key, {
      name: pj.name,
      version: pj.version,
      license: spdx(pj),
      text: licenseText(dir),
    });
  }
  // Descend into deps either way — our packages pull in third-party deps.
  for (const dep of Object.keys(pj.dependencies || {})) {
    if (!collected.has(dep)) walk(dep);
  }
}

const cli = JSON.parse(readFileSync(join(ROOT, 'packages', 'trove-cli', 'package.json'), 'utf8'));
for (const dep of Object.keys(cli.dependencies || {})) walk(dep);

if (missing.length > 0) {
  console.error(`✖ could not resolve (is the workspace installed?): ${[...new Set(missing)].join(', ')}`);
  process.exit(1);
}

const entries = [...collected.values()].sort((a, b) => a.name.localeCompare(b.name));
const sep = `\n\n${'-'.repeat(78)}\n\n`;
const body = entries
  .map((e) => {
    const head = `${e.name} ${e.version} — ${e.license}`;
    return e.text ? `${head}\n\n${e.text}` : `${head}\n\n(No license file shipped; declared license: ${e.license}.)`;
  })
  .join(sep);

const header =
  'THIRD-PARTY LICENSES\n\n' +
  'The standalone `trove` binaries statically embed the following third-party\n' +
  'packages. Their license terms and copyright notices are reproduced below.\n' +
  `The trove packages themselves are MIT-licensed (see LICENSE).\n\n${'='.repeat(78)}\n\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, header + body + '\n');
console.log(`✓ wrote ${OUT} — ${entries.length} third-party package(s)`);
