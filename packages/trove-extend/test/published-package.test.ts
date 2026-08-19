/**
 * The BUILT package, imported the way a consumer imports it.
 *
 * Every other test here imports from `src`, through Vitest, which resolves and
 * transforms modules its own way. That hides a whole class of defect: code that
 * is correct TypeScript, compiles cleanly, passes every test, and then throws
 * on `import` for anyone who is not running a bundler.
 *
 * This happened. `@ontrove/sdk@0.10.0` (this package's predecessor) shipped a contract module whose JSON
 * import carried no `with { type: 'json' }` attribute. Node's ESM loader
 * refuses that outright, so the first consumer to `import '@ontrove/extend/contract'`
 * — the Trove backend, minutes after publishing — got a TypeError instead of a
 * fixture, and the fix meant another version.
 *
 * So this suite runs plain `node`, against `dist`, resolving through the real
 * `exports` map. It is slow by the standards of the rest of the file and worth
 * it: publishing is the one action here that cannot be taken back.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Evaluate a snippet in a plain Node process rooted in this package.
 *
 * @param code - The ESM snippet to run.
 * @returns Whatever the snippet wrote to stdout, trimmed.
 */
function inNode(code: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('the built package', () => {
  beforeAll(() => {
    // A skip here would be the same silence this suite exists to remove, so it
    // says what to do instead.
    if (!existsSync(join(packageRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing — run `bun run build` before this suite.');
    }
  });

  it('imports its main entry under plain Node', () => {
    expect(
      inNode("import('@ontrove/extend/source').then((m) => console.log(typeof m.defineSource));"),
    ).toBe('function');
  });

  it('imports the contract subpath under plain Node', () => {
    // The one that broke. `dist/contract/index.js` imports a JSON module, which
    // Node refuses without an import attribute — a failure no amount of
    // TypeScript checking or bundler-based testing can see.
    const out = inNode(
      "import('@ontrove/extend/contract').then((m) => console.log(m.contract.version, m.CASE_SECTIONS.length));",
    );
    expect(out).toBe('1 5');
  });

  it('exposes the raw contract JSON as a file a non-TypeScript reader can open', () => {
    // The Mac's runner is plain JavaScript with no build step: it reads this
    // path off disk. If the `exports` map stopped listing it, that runner would
    // lose its copy of the contract and go back to being unguarded.
    const out = inNode(
      "import('node:fs').then(async (fs) => {" +
        "const { createRequire } = await import('node:module');" +
        "const path = createRequire(process.cwd() + '/x.js').resolve('@ontrove/extend/contract/source-invoke.json');" +
        "console.log(JSON.parse(fs.readFileSync(path, 'utf8')).contract);" +
        '});',
    );
    expect(out).toBe('source-invoke');
  });
});
