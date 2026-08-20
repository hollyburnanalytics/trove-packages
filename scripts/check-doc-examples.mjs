#!/usr/bin/env node
/**
 * Typecheck the `@ontrove/*` code examples in the package READMEs against the
 * *built* packages, so a drifted example — an import that doesn't exist, a wrong
 * option name, a changed API shape — fails the build instead of shipping.
 *
 * What's checked: every fenced ```ts / ```typescript block that imports from
 * `@ontrove/*` (a self-contained example). To opt a block out — a fragment that
 * references an outer scope, or an intentionally-illustrative snippet ("bring
 * your own RSS parser") — add `no-typecheck` to its fence info string
 * (```ts no-typecheck), which npm/GitHub ignore when rendering.
 *
 * Requires `dist/` to exist (the imports resolve to each package's
 * `dist/index.d.ts`), so run it after `build`. Wired into `bun run check` + CI.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TMP = join(ROOT, '.doc-examples-tmp');

/** Every tracked package README. */
function readmes() {
  return execFileSync('git', ['ls-files', 'packages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /^packages\/[^/]+\/README\.md$/.test(f));
}

/** Extract the checkable (self-contained, non-skipped) `@ontrove` examples. */
function extractBlocks() {
  const blocks = [];
  for (const rel of readmes()) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    let open = false;
    let start = 0;
    let meta = '';
    let buf = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^```(ts|typescript)\b(.*)$/);
      if (!open && fence) {
        open = true;
        start = i + 2; // 1-based line of the first code line
        meta = fence[2];
        buf = [];
      } else if (open && /^```\s*$/.test(line)) {
        open = false;
        const code = buf.join('\n');
        const optedOut = /\bno-typecheck\b/.test(meta) || code.includes('docs-gate: skip');
        if (code.includes("from '@ontrove/") && !optedOut) {
          blocks.push({ rel, line: start, code });
        }
      } else if (open) {
        buf.push(line);
      }
    }
  }
  return blocks;
}

const blocks = extractBlocks();
if (blocks.length === 0) {
  console.log('✓ docs:examples — no self-contained @ontrove examples to check');
  process.exit(0);
}

// Map each `@ontrove/*` import straight to the built `.d.ts` its `exports` entry
// points at — every subpath, not just the root — so the check is independent of
// node_modules layout and only ever sees what consumers get. Reading the exports
// map rather than assuming one root entry is what makes a subpath-shaped package
// (`@ontrove/extend/source`) checkable at all; the earlier version silently had
// no mapping for those and failed with "cannot find module".
const paths = {};
for (const rel of readmes()) {
  const dir = rel.replace(/\/README\.md$/, '');
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  const entries = Object.entries(pkg.exports ?? { '.': { types: './dist/index.d.ts' } });
  for (const [subpath, target] of entries) {
    const types = typeof target === 'string' ? target : target?.types;
    if (types === undefined) continue;
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;
    // Relative to the tsconfig location (TMP), which is one level under ROOT.
    paths[specifier] = [`../${dir}/${types.replace(/^\.\//, '')}`];
  }
}

// Write each example as its own module, plus a tsconfig that resolves the imports.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const files = blocks.map((b, n) => {
  writeFileSync(join(TMP, `example-${n}.ts`), `// from ${b.rel}:${b.line}\n${b.code}\n`);
  return `example-${n}.ts`;
});
writeFileSync(
  join(TMP, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        // Allow untyped params on `any` (e.g. a `res.json()` row) — examples
        // illustrate API usage, not exhaustive typing. Wrong API shapes, bad
        // option names, and missing exports still fail (those don't need it).
        noImplicitAny: false,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        lib: ['es2022', 'dom'],
        types: [],
        paths,
      },
      include: files,
    },
    undefined,
    2,
  ),
);

try {
  execFileSync('bunx', ['tsc', '-p', join(TMP, 'tsconfig.json')], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  console.log(`✓ docs:examples — ${blocks.length} README example(s) typecheck against the built API`);
  rmSync(TMP, { recursive: true, force: true });
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}` || err.message;
  console.error('\n✖ A README example does not typecheck against the package API:\n');
  console.error(out.trim());
  console.error(
    `\nEach error's file maps to a README block:\n  ${blocks
      .map((b, n) => `example-${n}.ts → ${b.rel}:${b.line}`)
      .join('\n  ')}\n`,
  );
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
