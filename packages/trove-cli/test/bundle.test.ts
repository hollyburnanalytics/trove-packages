import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, ExitCode } from '../src/errors.js';
import { bundleServer, bundleSource, loadModule, writeNew } from '../src/lib/bundle.js';

/**
 * These unit tests inject the loader/bundler seams so they run under the
 * Node-instrumented coverage runner. The real Bun loader + deploy bundler (the
 * default paths) are exercised end-to-end by `test/toolchain.smoke.test.ts`,
 * which runs under Bun (see `test:smoke`).
 */

describe('bundleServer', () => {
  it('extracts tools (dropping nameless/invalid) and returns the bundle', async () => {
    const result = await bundleServer('/proj/server.ts', {
      loadImpl: async () => ({
        default: {
          tools: [{ name: 'a', description: 'A' }, { name: 'b' }, { name: '' }, { x: 1 }],
        },
      }),
      bundleImpl: async () => 'BUNDLE',
    });
    expect(result.bundle).toBe('BUNDLE');
    expect(result.tools).toEqual([{ name: 'a', description: 'A' }, { name: 'b' }]);
  });

  it('carries full tool metadata (title, schemas, annotations, alwaysOn)', async () => {
    const result = await bundleServer('/proj/server.ts', {
      loadImpl: async () => ({
        default: {
          tools: [
            {
              name: 'search',
              title: 'Search',
              description: 'find',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              annotations: { readOnlyHint: true },
              alwaysOn: true,
            },
          ],
        },
      }),
      bundleImpl: async () => 'BUNDLE',
    });
    expect(result.tools[0]).toEqual({
      name: 'search',
      title: 'Search',
      description: 'find',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      alwaysOn: true,
    });
  });

  it('throws when the entry default export is not a server', async () => {
    await expect(
      bundleServer('/proj/server.ts', {
        loadImpl: async () => ({ default: { tools: 'not-an-array' } }),
        bundleImpl: async () => 'BUNDLE',
      }),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('propagates a bundler failure', async () => {
    await expect(
      bundleServer('/proj/server.ts', {
        loadImpl: async () => ({ default: { tools: [{ name: 'a' }] } }),
        bundleImpl: async () => {
          throw new CliError('boom', ExitCode.Usage);
        },
      }),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });
});

describe('bundleSource', () => {
  it('returns the deployable module for a source entry', async () => {
    const bundled: string[] = [];
    const bundle = await bundleSource('/proj/index.ts', {
      loadImpl: async () => ({ default: { sync: async () => [] } }),
      bundleImpl: async (entry) => {
        bundled.push(entry);
        return 'BUNDLE';
      },
    });
    expect(bundle).toBe('BUNDLE');
    expect(bundled).toEqual(['/proj/index.ts']);
  });

  it('refuses an entry whose default export is not a source', async () => {
    // Caught here rather than by the sandbox on its first sync, which is hours
    // later and somewhere the author cannot see.
    await expect(
      bundleSource('/proj/index.ts', {
        loadImpl: async () => ({ default: { tools: [] } }),
        bundleImpl: async () => 'BUNDLE',
      }),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('propagates a bundler failure', async () => {
    await expect(
      bundleSource('/proj/index.ts', {
        loadImpl: async () => ({ default: { sync: async () => [] } }),
        bundleImpl: async () => {
          throw new CliError('boom', ExitCode.Usage);
        },
      }),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });
});

describe('writeNew', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-writenew-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a new file', () => {
    const path = join(dir, 'a.txt');
    writeNew(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('refuses to overwrite an existing file', () => {
    const path = join(dir, 'a.txt');
    writeNew(path, 'one');
    expect(() => writeNew(path, 'two')).toThrow(CliError);
  });

  it('rethrows a non-EEXIST filesystem error (missing parent dir)', () => {
    // Writing into a non-existent directory raises ENOENT, not EEXIST.
    const path = join(dir, 'no-such-dir', 'a.txt');
    expect(() => writeNew(path, 'x')).toThrow();
    expect(() => writeNew(path, 'x')).not.toThrow(CliError);
  });
});

describe('loadModule', () => {
  it('returns the default export via the injected loader', async () => {
    const seen: string[] = [];
    const value = await loadModule<{ ok: boolean }>('/x/index.ts', {
      loadImpl: async (entry) => {
        seen.push(entry);
        return { default: { ok: true } };
      },
    });
    expect(value.ok).toBe(true);
    expect(seen).toEqual(['/x/index.ts']);
  });

  it('propagates a loader failure', async () => {
    await expect(
      loadModule('/x/index.ts', {
        loadImpl: async () => {
          throw new CliError('boom', ExitCode.Usage);
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  it('throws when the module has no default export', async () => {
    await expect(loadModule('/x/index.ts', { loadImpl: async () => ({}) })).rejects.toThrow(
      /no default export/,
    );
  });
});
