#!/usr/bin/env bun
/**
 * Compile the `trove` CLI into self-contained single binaries with
 * `bun build --compile` — one per platform, with the Bun runtime and the
 * `@ontrove/*` packages embedded, so users install nothing (no Node, no bun).
 *
 * Usage:
 *   bun scripts/build-binaries.mjs                 # host target only (fast local build)
 *   bun scripts/build-binaries.mjs --all           # every shipping target
 *   bun scripts/build-binaries.mjs bun-linux-x64   # a specific Bun target
 *
 * `esbuild` is marked `--external`: it is the Node-fallback bundler and is never
 * reached under Bun (the binary uses Bun-native bundling), so it must not be
 * pulled into the binary. Requires `build:vendor` to have run first: the deploy
 * bundlers embed the pre-built MCP worker runtime (`mcp deploy`) and source
 * worker runtime (`source deploy`).
 *
 * @module
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENTRY = join(ROOT, 'packages', 'trove-cli', 'src', 'index.ts');
const OUT_DIR = join(ROOT, 'dist', 'bin');

/** The shipping targets. Bun compile has no Windows-arm64 target (npx fallback). */
const TARGETS = [
  { target: 'bun-darwin-arm64', out: 'trove-darwin-arm64' },
  { target: 'bun-darwin-x64', out: 'trove-darwin-x64' },
  { target: 'bun-linux-x64-baseline', out: 'trove-linux-x64' },
  { target: 'bun-linux-arm64', out: 'trove-linux-arm64' },
  { target: 'bun-windows-x64-baseline', out: 'trove-windows-x64.exe' },
];

const arg = process.argv[2];
let selected;
if (arg === '--all') {
  selected = TARGETS;
} else if (arg) {
  const found = TARGETS.find((t) => t.target === arg);
  if (!found) {
    console.error(`Unknown target '${arg}'. Known: ${TARGETS.map((t) => t.target).join(', ')}`);
    process.exit(1);
  }
  selected = [found];
} else {
  // Host target: let Bun pick by omitting --target.
  selected = [{ target: null, out: 'trove' }];
}

for (const { target, out } of selected) {
  const outfile = join(OUT_DIR, out);
  const cmd = [
    'bun',
    'build',
    ENTRY,
    '--compile',
    '--external',
    'esbuild',
    ...(target ? ['--target', target] : []),
    '--outfile',
    outfile,
  ];
  console.log(`→ ${target ?? 'host'} → dist/bin/${out}`);
  const proc = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if (!proc.success) {
    console.error(`✗ compile failed for ${target ?? 'host'}`);
    process.exit(1);
  }
}
console.log(`✓ built ${selected.length} bin-target(s) into dist/bin/`);
