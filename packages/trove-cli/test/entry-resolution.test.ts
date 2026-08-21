/**
 * Entry-module resolution for both extension kinds.
 *
 * The rename to `extension.ts` is only real if the resolvers PREFER it. The
 * suites that came with the rename all asserted the old names still work,
 * which is the half that cannot fail on its own — these are the half that can.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceEntry } from '../src/commands/source-dev-project.js';

describe('sourceEntry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-entry-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves extension.ts', () => {
    writeFileSync(join(dir, 'extension.ts'), 'export default {};');
    expect(sourceEntry(dir)).toBe(join(dir, 'extension.ts'));
  });

  it('prefers extension.ts over the names it replaces', () => {
    // A half-finished rename must resolve to the file the author just wrote,
    // not the one they meant to delete — otherwise the move looks applied and
    // the old code keeps running.
    writeFileSync(join(dir, 'extension.ts'), 'export default {};');
    writeFileSync(join(dir, 'index.ts'), 'export default {};');
    writeFileSync(join(dir, 'index.mjs'), 'export default {};');
    expect(sourceEntry(dir)).toBe(join(dir, 'extension.ts'));
  });

  it('still resolves index.ts and index.mjs', () => {
    writeFileSync(join(dir, 'index.mjs'), 'export default {};');
    expect(sourceEntry(dir)).toBe(join(dir, 'index.mjs'));
  });

  it('names every accepted filename when the directory holds none', () => {
    expect(() => sourceEntry(dir)).toThrow(/extension\.ts, index\.ts, index\.mjs/);
  });
});
