import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { ExitCode } from '../src/errors.js';
import { bundleServer, bundleSource } from '../src/lib/bundle.js';
import {
  type CapturedRequest,
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
  type TempHome,
  tempHome,
} from './helpers.js';

/**
 * The real-toolchain smoke suite. Unlike the injected-seam unit tests, these go
 * through `run()` (the real dispatcher) and the real **Bun** loader/bundler —
 * transpiling and running a user's source/server TS in-process with
 * `@ontrove/*` supplied by the embedded resolver, exactly as the shipped binary
 * does. It MUST run under Bun's native test runner (`bun test`, via the
 * `test:smoke` script) — not the Node/vitest coverage runner, whose module
 * loader bypasses the Bun resolver plugin. It uses `bun:test` for that reason.
 */
function runCli(
  argv: string[],
  mock: MockFetch,
  writer: CaptureWriter,
  home: TempHome,
): Promise<number> {
  return run({
    argv,
    writer,
    fetchImpl: mock.fetch,
    isTTY: false,
    configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
  });
}

const SOURCE_SRC = `import { defineSource } from '@ontrove/extend/source';
export default defineSource({
  id: 'smoke-source',
  name: 'Smoke Source',
  description: 'A source used by the real-toolchain smoke suite.',
  icon: '🧪',
  version: '1.0.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'feed',
  cursor: 'none',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'daily',
  status: 'implemented',
  needsBrowser: false,
  egress: ['a.example.com'],
  async sync() {
    return [{ id: 'a', title: 'A', text: 'body', url: 'https://a' }];
  },
});
`;

const SERVER_SRC = `import { defineToolkit, z } from '@ontrove/extend/toolkit';
export default defineToolkit({
  id: 'smoke-toolkit',
  name: 'Smoke Toolkit',
  description: 'A toolkit used by the real-toolchain smoke suite.',
  icon: '🧪',
  version: '1.0.0',
  tools: [
    {
      name: 'ping',
      description: 'Ping.',
      input: z.object({}),
      annotations: { readOnlyHint: true },
      async handler() { return { text: 'pong' }; },
    },
  ],
});
`;

describe('source dev loop via run() (real Bun toolchain)', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  let proj: string;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
    proj = mkdtempSync(join(tmpdir(), 'trove-proj-'));
  });
  afterEach(() => {
    home.cleanup();
    rmSync(proj, { recursive: true, force: true });
  });

  it('source init then dev prints the documents', async () => {
    const mock = mockFetch({});
    expect(await runCli(['source', 'init', join(proj, 'blog')], mock, writer, home)).toBe(
      ExitCode.Success,
    );
    const w2 = captureWriter();
    const code = await runCli(['source', 'dev', join(proj, 'blog')], mock, w2, home);
    expect(code).toBe(ExitCode.Success);
    expect(w2.stdoutText()).toContain('Hello from your new source');
  });

  it('source validate passes a scaffolded manifest', async () => {
    const mock = mockFetch({});
    await runCli(['source', 'init', join(proj, 'blog')], mock, writer, home);
    const w2 = captureWriter();
    const code = await runCli(['source', 'validate', join(proj, 'blog')], mock, w2, home);
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(w2.stdoutText()).valid).toBe(true);
  });

  it('source dev runs a hand-written source and emits documents', async () => {
    writeFileSync(join(proj, 'manifest.json'), '{"id":"blog","name":"Blog","version":"1.0.0"}');
    writeFileSync(join(proj, 'index.ts'), SOURCE_SRC);
    const mock = mockFetch({});
    const code = await runCli(['source', 'dev', proj], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    const docs = JSON.parse(writer.stdoutText());
    expect(docs[0].id).toBe('a');
  });

  it('source sync uploads via ingestDocuments', async () => {
    writeFileSync(join(proj, 'manifest.json'), '{"id":"blog","name":"Blog","version":"1.0.0"}');
    writeFileSync(join(proj, 'index.ts'), SOURCE_SRC);
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ id: 'c_1', name: 'Blog' }] } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return {
          data: {
            source: {
              feeds: [{ id: 's_1', name: 'default', externalKey: 'default', cursor: null }],
            },
          },
        };
      }
      return {
        data: {
          ingestDocuments: {
            documentsIndexed: 1,
            documentsSkipped: 0,
            transcriptionsQueued: 0,
            cursor: null,
            errors: null,
          },
        },
      };
    });
    const code = await runCli(
      ['source', 'sync', proj, '--source', 'Blog', '--feed', 'default'],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls.some((c) => c.operationName === 'CliIngestDocuments')).toBe(true);
  });

  it('source test asserts a hand-written source against fixtures', async () => {
    writeFileSync(join(proj, 'index.ts'), SOURCE_SRC);
    writeFileSync(join(proj, 'fixtures.json'), '{}');
    const mock = mockFetch({});
    const code = await runCli(
      ['source', 'test', proj, '--fixtures', join(proj, 'fixtures.json')],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(writer.stdoutText()).ok).toBe(true);
  });
});

describe('mcp dev loop via run() (real Bun toolchain)', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  let proj: string;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
    proj = mkdtempSync(join(tmpdir(), 'trove-proj-'));
  });
  afterEach(() => {
    home.cleanup();
    rmSync(proj, { recursive: true, force: true });
  });

  it('mcp init then dev --once serves locally over a real socket', async () => {
    const mock = mockFetch({});
    await runCli(['mcp', 'init', join(proj, 'srv')], mock, writer, home);
    const w2 = captureWriter();
    const code = await runCli(['mcp', 'dev', join(proj, 'srv'), '--once'], mock, w2, home);
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(w2.stdoutText()).url).toContain('127.0.0.1');
  });

  it('mcp dev serves a hand-written server', async () => {
    writeFileSync(join(proj, 'server.ts'), SERVER_SRC);
    const mock = mockFetch({});
    const code = await runCli(['mcp', 'dev', proj, '--once', '--port', '0'], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(writer.stdoutText()).tools[0].name).toBe('ping');
  });

  it('mcp logs explains the hosted-runtime log gap (exit 0)', async () => {
    const mock = mockFetch({});
    const code = await runCli(['mcp', 'logs', 'srv'], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(writer.stdoutText()).available).toBe(false);
  });
});

describe('mcp deploy bundling (real Bun bundler + embedded @ontrove/extend/toolkit)', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'trove-proj-'));
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('bundles a hand-written server for the hosted runtime and extracts its tools', async () => {
    const entry = join(proj, 'server.ts');
    writeFileSync(entry, SERVER_SRC);
    // No injected seams: this drives defaultBundleForDeploy, which runs Bun.build
    // over a wrapper and resolves @ontrove/extend/toolkit from the embedded worker runtime.
    const { bundle, tools } = await bundleServer(entry);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'ping',
      description: 'Ping.',
      annotations: { readOnlyHint: true },
    });
    // Full-fidelity metadata, not just name/description.
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    // A self-contained hosted-runtime module: substantial, exposes a default
    // export (the fetch handler), and inlines the MCP runtime — no unresolved
    // `import … from '@ontrove/extend/toolkit'` survives.
    expect(bundle.length).toBeGreaterThan(1000);
    expect(bundle).toMatch(/as default/);
    expect(bundle).not.toMatch(/from\s*['"]@ontrove\/mcp['"]/);
  });
});

describe('mcp deploy via run() (real Bun bundler, mocked GraphQL)', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  const deployResponse = (tools: Array<{ name: string; description: string | null }>) => ({
    data: {
      deployServer: {
        id: 'd',
        version: 'v1',
        status: 'BUILDING',
        scriptName: 's',
        sizeBytes: 1,
        tools,
      },
    },
  });

  it('bundles server.ts, enriches the manifest with bundle+tools, calls CliDeployServer', async () => {
    writeFileSync(
      join(home.home, 'manifest.json'),
      JSON.stringify({ name: 'My Srv', slug: 'my-srv' }),
    );
    writeFileSync(join(home.home, 'server.ts'), SERVER_SRC);
    const mock = mockFetch(deployResponse([{ name: 'ping', description: null }]));
    const code = await runCli(['mcp', 'deploy', '--dir', home.home], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliDeployServer');
    expect(mock.calls[0]?.variables).toMatchObject({ name: 'My Srv', slug: 'my-srv' });
    // The enriched manifest carries the real deployable bundle + full-fidelity
    // tool metadata (annotations derived from the server), not just name/desc.
    const manifest = mock.calls[0]?.variables.manifest as {
      bundle?: unknown;
      tools?: Array<Record<string, unknown>>;
    };
    expect(typeof manifest.bundle).toBe('string');
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools?.[0]).toMatchObject({
      name: 'ping',
      description: 'Ping.',
      annotations: { readOnlyHint: true },
    });
  });

  it('deploy (top-level alias) maps to CliDeployServer', async () => {
    writeFileSync(join(home.home, 'manifest.json'), JSON.stringify({ name: 'A', slug: 'a' }));
    writeFileSync(join(home.home, 'server.ts'), SERVER_SRC);
    const mock = mockFetch(deployResponse([]));
    const code = await runCli(['deploy', '--dir', home.home], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliDeployServer');
  });
});

describe('source deploy bundling (real Bun bundler + embedded source runtime)', () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'trove-proj-'));
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('bundles a hand-written source with the runtime shim in front of it', async () => {
    const entry = join(proj, 'index.ts');
    writeFileSync(entry, SOURCE_SRC);
    // No injected seams: this drives defaultBundleSourceForDeploy, which runs
    // Bun.build over a wrapper and resolves the shim from the embedded runtime.
    const bundle = await bundleSource(entry);
    expect(bundle.length).toBeGreaterThan(1000);
    expect(bundle).toMatch(/as default/);
    // Self-contained: NOTHING under `@ontrove/` is left as an import the sandbox
    // would have to resolve (it cannot — there is no registry there). Matched by
    // prefix, not by a list of names: the previous version of this assertion
    // named `sdk`, and so kept passing after the package was renamed.
    expect(bundle).not.toMatch(/from\s*['"]@ontrove\//);
  });

  it('refuses an @ontrove specifier the embedded runtime does not supply', async () => {
    // The failure this guards is silent, not loud. When a specifier is not
    // matched by the resolver plugin, Bun does not error — it falls through to
    // on-disk resolution, which SUCCEEDS in this workspace and does not exist in
    // the compiled binary. So the bundle looks fine here and breaks at a user's
    // deploy. Refusing unknown `@ontrove/*` up front is what makes that
    // difference observable.
    // `@ontrove/extend/toolkit` is the right specifier for the WRONG kind of
    // extension. It matters that it is a real, installed package: a made-up
    // specifier would fail on ordinary resolution and prove nothing about this
    // guard. This one resolves on disk, so without the guard the bundle
    // succeeds — silently welding the whole toolkit runtime into a source, and
    // only in a workspace where the package happens to exist.
    const entry = join(proj, 'index.ts');
    writeFileSync(entry, `import '@ontrove/extend/toolkit';\n${SOURCE_SRC}`);
    let thrown: unknown;
    try {
      await bundleSource(entry);
    } catch (error) {
      thrown = error;
    }
    // An absent throw leaves this the empty string, which contains nothing —
    // so "it did not fail at all" fails the assertion too.
    expect(thrown instanceof Error ? thrown.message : '').toContain('embedded runtime supplies');
  });

  it('serves the invoke contract when the bundled module is executed', async () => {
    const entry = join(proj, 'index.ts');
    writeFileSync(entry, SOURCE_SRC);
    const bundle = await bundleSource(entry);
    const modulePath = join(proj, 'deployed.mjs');
    writeFileSync(modulePath, bundle);

    const worker = (await import(modulePath)).default as {
      fetch(request: Request): Promise<Response>;
    };
    const response = await worker.fetch(
      new Request('https://invoke/sync', { method: 'POST', body: JSON.stringify({ config: {} }) }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string; title: string }> };
    expect(body.documents).toEqual([{ id: 'a', title: 'A', text: 'body', url: 'https://a' }]);
  });
});

describe('source deploy via run() (real Bun bundler, mocked GraphQL)', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  let proj: string;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
    proj = mkdtempSync(join(tmpdir(), 'trove-proj-'));
  });
  afterEach(() => {
    home.cleanup();
    rmSync(proj, { recursive: true, force: true });
  });

  it('bundles index.ts, inlines it in the manifest, calls CliDeploySource', async () => {
    writeFileSync(
      join(proj, 'manifest.json'),
      JSON.stringify({ id: 'blog', name: 'Blog', version: '1.0.0', egress: ['a.test'] }),
    );
    writeFileSync(join(proj, 'index.ts'), SOURCE_SRC);
    const mock = mockFetch({
      data: {
        deploySource: {
          id: 'sd_1',
          sourceType: 'dev/u_1/blog',
          version: '1.0.0',
          scriptName: 'src-u1-blog',
          status: 'LIVE',
          sizeBytes: 1,
          error: null,
        },
      },
    });
    const code = await runCli(['source', 'deploy', proj], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliDeploySource');
    expect(mock.calls[0]?.variables.slug).toBe('blog');
    const manifest = mock.calls[0]?.variables.manifest as { bundle?: string; egress?: string[] };
    expect(typeof manifest.bundle).toBe('string');
    expect(manifest.egress).toEqual(['a.test']);
  });

  it('refuses a manifest with no egress before bundling anything', async () => {
    writeFileSync(
      join(proj, 'manifest.json'),
      JSON.stringify({ id: 'blog', name: 'Blog', version: '1.0.0' }),
    );
    writeFileSync(join(proj, 'index.ts'), SOURCE_SRC);
    const mock = mockFetch({});
    const code = await runCli(['source', 'deploy', proj], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
    expect(writer.stderrText()).toContain('manifest.json');
    expect(mock.calls).toHaveLength(0);
  });
});
