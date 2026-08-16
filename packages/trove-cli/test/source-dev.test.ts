import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSource, type TroveSource } from '@ontrove/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as sourceDev from '../src/commands/source-dev.js';
import { buildContext, type CommandContext } from '../src/context.js';
import { ExitCode } from '../src/errors.js';
import { parseArgs } from '../src/lib/args.js';
import {
  type CapturedRequest,
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
} from './helpers.js';

/** Build a command context wired to a mock fetch + temp home + a stored token. */
function ctxFor(mock: MockFetch, writer: CaptureWriter, home: string): CommandContext {
  return buildContext({
    globals: { json: true },
    writer,
    fetchImpl: mock.fetch,
    configEnv: { home, env: { TROVE_TOKEN: 'tok' } },
    isTTY: false,
  });
}

/** A loader dep returning a fixed source. */
function loaderFor(source: TroveSource): sourceDev.SourceDevDeps {
  return { load: async <T>() => source as unknown as T };
}

describe('source init', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-conn-'));
    writer = captureWriter();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('scaffolds manifest.json + index.ts', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    const code = await sourceDev.init(ctx, parseArgs([join(dir, 'my-blog')]));
    expect(code).toBe(ExitCode.Success);
    const projDir = join(dir, 'my-blog');
    const manifest = JSON.parse(readFileSync(join(projDir, 'manifest.json'), 'utf8'));
    expect(manifest.id).toBe('my-blog');
    expect(existsSync(join(projDir, 'index.ts'))).toBe(true);
  });

  it('requires a name', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await expect(sourceDev.init(ctx, parseArgs([]))).rejects.toMatchObject({
      code: ExitCode.Usage,
    });
  });
});

describe('source dev', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-conn-'));
    writer = captureWriter();
    writeFileSync(join(dir, 'manifest.json'), '{"id":"x","name":"X","version":"1.0.0"}');
    writeFileSync(join(dir, 'index.ts'), '// source');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const source = defineSource({
    async sync(ctx) {
      ctx.log('syncing');
      return [
        { id: '1', title: 'One', text: 'first', contentType: 'text' },
        { id: '1', title: 'dup', text: 'dup' },
        { id: '2', title: 'Two', text: 'second' },
      ];
    },
  });

  it('runs sync locally and prints documents as JSON (dedups)', async () => {
    const mock = mockFetch({});
    const ctx = ctxFor(mock, writer, dir);
    const code = await sourceDev.dev(ctx, parseArgs([dir]), loaderFor(source));
    expect(code).toBe(ExitCode.Success);
    const docs = JSON.parse(writer.stdoutText());
    expect(docs.map((d: { title: 'Fixture'; id: string }) => d.id)).toEqual(['1', '2']);
    expect(mock.calls.length).toBe(0); // no upload
  });

  it('renders a human table with a cursor footer', async () => {
    const mock = mockFetch({});
    const ctx = buildContext({
      globals: {},
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: dir, env: { TROVE_TOKEN: 'tok' } },
      isTTY: true,
    });
    const cur = defineSource({
      async sync() {
        return {
          documents: [{ title: 'Fixture', id: 'a', text: 'x' }],
          cursor: { type: 'date', value: 'd' },
        };
      },
    });
    await sourceDev.dev(ctx, parseArgs([dir]), loaderFor(cur));
    expect(writer.stdoutText()).toContain('ID');
    expect(writer.stderrText()).toContain('next cursor');
  });

  it('errors when index.ts is missing', async () => {
    rmSync(join(dir, 'index.ts'));
    const mock = mockFetch({});
    await expect(
      sourceDev.dev(ctxFor(mock, writer, dir), parseArgs([dir]), loaderFor(source)),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('rejects a non-source default export', async () => {
    const mock = mockFetch({});
    await expect(
      sourceDev.dev(ctxFor(mock, writer, dir), parseArgs([dir]), {
        load: async <T>() => ({}) as T,
      }),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('reads --config and --cursor into the run', async () => {
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ feedUrl: 'https://f' }));
    let seenConfig: Record<string, unknown> = {};
    let seenCursor: unknown;
    const probe = defineSource({
      async sync(ctx) {
        seenConfig = ctx.config as Record<string, unknown>;
        seenCursor = ctx.cursor;
        return [{ title: 'Fixture', id: 'a', text: 'b' }];
      },
    });
    const mock = mockFetch({});
    await sourceDev.dev(
      ctxFor(mock, writer, dir),
      parseArgs([dir, '--config', configFile, '--cursor', '{"type":"date","value":"d"}'], {
        value: ['config', 'cursor'],
      }),
      loaderFor(probe),
    );
    expect(seenConfig.feedUrl).toBe('https://f');
    expect(seenCursor).toEqual({ type: 'date', value: 'd' });
  });

  it('rejects a non-object --config file', async () => {
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, '[1,2,3]');
    const mock = mockFetch({});
    await expect(
      sourceDev.dev(
        ctxFor(mock, writer, dir),
        parseArgs([dir, '--config', configFile], { value: ['config'] }),
        loaderFor(source),
      ),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('rejects an unreadable --config file', async () => {
    const mock = mockFetch({});
    await expect(
      sourceDev.dev(
        ctxFor(mock, writer, dir),
        parseArgs([dir, '--config', join(dir, 'nope.json')], { value: ['config'] }),
        loaderFor(source),
      ),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('emits jsonl (one document per line)', async () => {
    const mock = mockFetch({});
    const ctx = buildContext({
      globals: { jsonl: true },
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: dir, env: { TROVE_TOKEN: 'tok' } },
      isTTY: false,
    });
    await sourceDev.dev(ctx, parseArgs([dir]), loaderFor(source));
    const lines = writer.stdoutText().split('\n');
    expect(lines.length).toBe(2);
  });

  it('--quiet suppresses the log lines', async () => {
    const mock = mockFetch({});
    const ctx = buildContext({
      globals: { json: true, quiet: true },
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: dir, env: { TROVE_TOKEN: 'tok' } },
      isTTY: false,
    });
    await sourceDev.dev(ctx, parseArgs([dir]), loaderFor(source));
    expect(writer.stderrText()).not.toMatch(/log:/);
  });
});

describe('source validate', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-conn-'));
    writer = captureWriter();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a valid manifest', async () => {
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ title: 'Fixture', id: 'ok', name: 'OK', version: '1.0.0' }),
    );
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await sourceDev.validate(ctx, parseArgs([dir]));
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(writer.stdoutText()).valid).toBe(true);
  });

  it('fails a manifest with a credential-shaped config key (human)', async () => {
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        title: 'Fixture',
        id: 'bad',
        name: 'Bad',
        version: '1.0.0',
        config: { apiKey: {} },
      }),
    );
    const ctx = buildContext({ globals: {}, writer, isTTY: true, configEnv: { home: dir } });
    const code = await sourceDev.validate(ctx, parseArgs([dir]));
    expect(code).toBe(ExitCode.Usage);
    expect(writer.stderrText()).toMatch(/credential/i);
  });

  it('errors when manifest.json is absent', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await expect(sourceDev.validate(ctx, parseArgs([dir]))).rejects.toMatchObject({
      code: ExitCode.Usage,
    });
  });

  it('errors when manifest.json is invalid JSON', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await expect(sourceDev.validate(ctx, parseArgs([dir]))).rejects.toMatchObject({
      code: ExitCode.Usage,
    });
  });
});

describe('source test', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-conn-'));
    writer = captureWriter();
    writeFileSync(join(dir, 'index.ts'), '// source');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asserts document shape against fixtures (pass)', async () => {
    writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ 'https://feed': '<rss/>' }));
    const source = defineSource({
      async sync(ctx) {
        const res = await ctx.fetch('https://feed');
        const body = await res.text();
        return [{ title: 'Fixture', id: '1', text: body }];
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await sourceDev.test(
      ctx,
      parseArgs([dir, '--fixtures', join(dir, 'fixtures.json')], { value: ['fixtures'] }),
      loaderFor(source),
    );
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(writer.stdoutText()).ok).toBe(true);
  });

  it('reports problems for malformed documents (human, exit 2)', async () => {
    const source = defineSource({
      async sync() {
        return {
          documents: [
            { title: 'Fixture', id: 'only-id' } as unknown as {
              title: 'Fixture';
              id: string;
              text: string;
            },
          ],
        };
      },
    });
    const ctx = buildContext({
      globals: {},
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: true,
      configEnv: { home: dir },
    });
    const code = await sourceDev.test(ctx, parseArgs([dir]), loaderFor(source));
    expect(code).toBe(ExitCode.Usage);
    expect(writer.stderrText()).toMatch(/text.*audioUrl|audioUrl.*text/);
  });

  it('flags an empty result set', async () => {
    const source = defineSource({
      async sync() {
        return [];
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await sourceDev.test(ctx, parseArgs([dir]), loaderFor(source));
    expect(code).toBe(ExitCode.Usage);
    expect(JSON.parse(writer.stdoutText()).problems).toContain('sync returned no documents');
  });

  it('passes (human) and stringifies non-string fixture values', async () => {
    writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ 'https://feed': { hello: 1 } }));
    const source = defineSource({
      async sync(ctx) {
        const res = await ctx.fetch('https://feed');
        return [{ title: 'Fixture', id: '1', text: await res.text() }];
      },
    });
    const ctx = buildContext({
      globals: {},
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: true,
      configEnv: { home: dir },
    });
    const code = await sourceDev.test(
      ctx,
      parseArgs([dir, '--fixtures', join(dir, 'fixtures.json')], { value: ['fixtures'] }),
      loaderFor(source),
    );
    expect(code).toBe(ExitCode.Success);
    expect(writer.stderrText()).toMatch(/passed shape checks/);
  });

  it('rejects a non-object fixtures file', async () => {
    writeFileSync(join(dir, 'fixtures.json'), '[1]');
    const source = defineSource({
      async sync() {
        return [{ title: 'Fixture', id: '1', text: 'x' }];
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: false,
      configEnv: { home: dir },
    });
    await expect(
      sourceDev.test(
        ctx,
        parseArgs([dir, '--fixtures', join(dir, 'fixtures.json')], { value: ['fixtures'] }),
        loaderFor(source),
      ),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('rejects a malformed (unparseable) fixtures file', async () => {
    writeFileSync(join(dir, 'fixtures.json'), '{ broken');
    const source = defineSource({
      async sync() {
        return [{ title: 'Fixture', id: '1', text: 'x' }];
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: false,
      configEnv: { home: dir },
    });
    await expect(
      sourceDev.test(
        ctx,
        parseArgs([dir, '--fixtures', join(dir, 'fixtures.json')], { value: ['fixtures'] }),
        loaderFor(source),
      ),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('serves 404 for an unknown fixture URL', async () => {
    writeFileSync(join(dir, 'fixtures.json'), '{}');
    const source = defineSource({
      async sync(ctx) {
        const res = await ctx.fetch('https://unknown');
        return [{ title: 'Fixture', id: '1', text: `status:${String(res.status)}` }];
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await sourceDev.test(
      ctx,
      parseArgs([dir, '--fixtures', join(dir, 'fixtures.json')], { value: ['fixtures'] }),
      loaderFor(source),
    );
    expect(code).toBe(ExitCode.Success);
  });

  it('flags a document with no id', async () => {
    const source = defineSource({
      async sync() {
        return {
          documents: [
            { title: 'Fixture', id: '', text: 'x' } as unknown as {
              title: 'Fixture';
              id: string;
              text: string;
            },
          ],
        };
      },
    });
    const ctx = buildContext({
      globals: { json: true },
      writer,
      fetchImpl: mockFetch({}).fetch,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await sourceDev.test(ctx, parseArgs([dir]), loaderFor(source));
    expect(code).toBe(ExitCode.Usage);
    expect(JSON.parse(writer.stdoutText()).problems.join(' ')).toMatch(/id/);
  });

  it('source validate --json on an invalid manifest', async () => {
    rmSync(join(dir, 'index.ts'));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ title: 'Fixture', id: 'BAD UPPER', name: 'x', version: 'nope' }),
    );
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await sourceDev.validate(ctx, parseArgs([dir]));
    expect(code).toBe(ExitCode.Usage);
    expect(JSON.parse(writer.stdoutText()).valid).toBe(false);
  });
});

describe('source sync', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-conn-'));
    writer = captureWriter();
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ title: 'Fixture', id: 'my-blog', name: 'My Blog', version: '1.0.0' }),
    );
    writeFileSync(join(dir, 'index.ts'), '// source');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const source = defineSource({
    async sync() {
      return {
        documents: [{ id: 'd1', title: 'Doc', text: 'body', url: 'https://x' }],
        cursor: { type: 'date', value: '2026-06-14' },
      };
    },
  });

  it('runs locally then ingests with cursor CAS against an existing source', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ title: 'Fixture', id: 'c_1', name: 'My Blog' }] } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return {
          data: {
            source: {
              feeds: [
                {
                  title: 'Fixture',
                  id: 's_1',
                  name: 'default',
                  externalKey: 'default',
                  cursor: null,
                },
              ],
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
            cursor: '{"type":"date","value":"2026-06-14"}',
            errors: [],
          },
        },
      };
    });
    const ctx = ctxFor(mock, writer, dir);
    const code = await sourceDev.sync(
      ctx,
      parseArgs([dir, '--feed', 'default'], { value: ['source', 'feed'] }),
      loaderFor(source),
    );
    expect(code).toBe(ExitCode.Success);
    const ingestCall = mock.calls.find((c) => c.operationName === 'CliIngestDocuments');
    expect(ingestCall?.variables.sourceId).toBe('c_1');
    expect(ingestCall?.variables.feedId).toBe('s_1');
    expect(ingestCall?.variables.cursor).toBe('{"type":"date","value":"2026-06-14"}');
    const docs = ingestCall?.variables.documents as Array<{ externalId: string }>;
    expect(docs[0]?.externalId).toBe('d1');
  });

  it('passes cursorBefore when the feed already has a cursor', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ title: 'Fixture', id: 'c_1', name: 'My Blog' }] } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return {
          data: {
            source: {
              feeds: [
                {
                  id: 's_1',
                  name: 'default',
                  externalKey: 'default',
                  cursor: '{"type":"date","value":"2026-01-01"}',
                },
              ],
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
    const ctx = ctxFor(mock, writer, dir);
    await sourceDev.sync(ctx, parseArgs([dir], { value: ['source', 'feed'] }), loaderFor(source));
    const ingestCall = mock.calls.find((c) => c.operationName === 'CliIngestDocuments');
    expect(ingestCall?.variables.cursorBefore).toBe('{"type":"date","value":"2026-01-01"}');
  });

  it('creates the source + feed with --create', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') return { data: { sources: [] } };
      if (req.operationName === 'CliCreateSource') {
        return { data: { createSource: { title: 'Fixture', id: 'c_new' } } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return { data: { source: { feeds: [] } } };
      }
      if (req.operationName === 'CliAddFeed') {
        return {
          data: {
            addFeed: {
              title: 'Fixture',
              id: 'f_new',
              name: 'default',
              externalKey: 'default',
              cursor: null,
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
    const ctx = ctxFor(mock, writer, dir);
    const code = await sourceDev.sync(
      ctx,
      parseArgs([dir, '--create'], { boolean: ['create'] }),
      loaderFor(source),
    );
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls.some((c) => c.operationName === 'CliCreateSource')).toBe(true);
    expect(mock.calls.some((c) => c.operationName === 'CliAddFeed')).toBe(true);
  });

  it('errors when the source is absent and --create is not given', async () => {
    const mock = mockFetch({ data: { sources: [] } });
    const ctx = ctxFor(mock, writer, dir);
    await expect(
      sourceDev.sync(ctx, parseArgs([dir], { value: ['source'] }), loaderFor(source)),
    ).rejects.toMatchObject({ code: ExitCode.NotFound });
  });

  it('errors when neither --source nor a manifest name is available', async () => {
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ title: 'Fixture', id: 'x', version: '1.0.0' }),
    );
    const mock = mockFetch({ data: { sources: [] } });
    const ctx = ctxFor(mock, writer, dir);
    await expect(
      sourceDev.sync(ctx, parseArgs([dir], { value: ['source'] }), loaderFor(source)),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('--quiet suppresses sync log lines', async () => {
    const noisy = defineSource({
      async sync(ctx) {
        ctx.log('working');
        return [{ title: 'Fixture', id: 'd1', text: 'b' }];
      },
    });
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ title: 'Fixture', id: 'c_1', name: 'My Blog' }] } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return {
          data: {
            source: {
              feeds: [
                {
                  title: 'Fixture',
                  id: 's_1',
                  name: 'default',
                  externalKey: 'default',
                  cursor: null,
                },
              ],
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
    const ctx = buildContext({
      globals: { json: true, quiet: true },
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: dir, env: { TROVE_TOKEN: 'tok' } },
      isTTY: false,
    });
    await sourceDev.sync(ctx, parseArgs([dir], { value: ['source', 'feed'] }), loaderFor(noisy));
    expect(writer.stderrText()).not.toMatch(/log:/);
  });

  it('matches a source by id (c_…) directly', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ title: 'Fixture', id: 'c_99', name: 'Other' }] } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return {
          data: {
            source: {
              feeds: [
                {
                  title: 'Fixture',
                  id: 's_1',
                  name: 'default',
                  externalKey: 'default',
                  cursor: null,
                },
              ],
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
    const ctx = ctxFor(mock, writer, dir);
    const code = await sourceDev.sync(
      ctx,
      parseArgs([dir, '--source', 'c_99'], { value: ['source'] }),
      loaderFor(source),
    );
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls.find((c) => c.operationName === 'CliSourceFeeds')?.variables.id).toBe('c_99');
  });

  it('errors when the feed is absent and --create is not given', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ title: 'Fixture', id: 'c_1', name: 'My Blog' }] } };
      }
      return { data: { source: { feeds: [] } } };
    });
    const ctx = ctxFor(mock, writer, dir);
    await expect(
      sourceDev.sync(ctx, parseArgs([dir], { value: ['source', 'feed'] }), loaderFor(source)),
    ).rejects.toMatchObject({ code: ExitCode.NotFound });
  });

  it('renders the ingest result as a human record', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ title: 'Fixture', id: 'c_1', name: 'My Blog' }] } };
      }
      if (req.operationName === 'CliSourceFeeds') {
        return {
          data: {
            source: {
              feeds: [
                {
                  title: 'Fixture',
                  id: 's_1',
                  name: 'default',
                  externalKey: 'default',
                  cursor: null,
                },
              ],
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
            cursor: 'c',
            errors: null,
          },
        },
      };
    });
    const ctx = buildContext({
      globals: {},
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: dir, env: { TROVE_TOKEN: 'tok' } },
      isTTY: true,
    });
    await sourceDev.sync(ctx, parseArgs([dir], { value: ['source', 'feed'] }), loaderFor(source));
    expect(writer.stdoutText()).toMatch(/indexed/);
  });
});

describe('source deploy', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-conn-'));
    writer = captureWriter();
    writeFileSync(join(dir, 'index.ts'), '// source');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A bundler dep that records the entry it was handed. */
  function bundlerFor(entries: string[]): sourceDev.SourceDeployDeps {
    return {
      bundle: async (entry: string) => {
        entries.push(entry);
        return 'BUNDLE';
      },
    };
  }

  /** Write a manifest with the given overrides applied. */
  function writeManifest(overrides: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'my-blog',
        name: 'My Blog',
        version: '1.2.0',
        egress: ['example.com'],
        ...overrides,
      }),
    );
  }

  /** A `deploySource` envelope with the given status. */
  function deployResponse(status: string, error: string | null = null): unknown {
    return {
      data: {
        deploySource: {
          id: 'sd_1',
          sourceType: 'dev/u_1/my-blog',
          version: '1.2.0',
          scriptName: 'src-u1-my-blog',
          status,
          sizeBytes: 6,
          error,
        },
      },
    };
  }

  it('bundles index.ts and sends the manifest with the bundle inlined', async () => {
    writeManifest();
    const entries: string[] = [];
    const mock = mockFetch(deployResponse('LIVE'));
    const code = await sourceDev.deploy(
      ctxFor(mock, writer, dir),
      parseArgs([dir], { value: ['slug'] }),
      bundlerFor(entries),
    );
    expect(code).toBe(ExitCode.Success);
    expect(entries).toEqual([join(dir, 'index.ts')]);
    expect(mock.calls[0]?.operationName).toBe('CliDeploySource');
    expect(mock.calls[0]?.variables.slug).toBe('my-blog');
    expect(mock.calls[0]?.variables.manifest).toMatchObject({
      id: 'my-blog',
      version: '1.2.0',
      egress: ['example.com'],
      bundle: 'BUNDLE',
    });
  });

  it('deploys an index.mjs source, which is what the catalogue is written in', async () => {
    // This looked for `index.ts` and nothing else, so `trove source deploy`
    // could not deploy a single source in the catalogue it exists to serve —
    // every one is plain ESM, including ones already running in production,
    // which had to be deployed some other way. esbuild bundles either.
    rmSync(join(dir, 'index.ts'));
    writeFileSync(join(dir, 'index.mjs'), '// source');
    writeManifest();
    const entries: string[] = [];
    const code = await sourceDev.deploy(
      ctxFor(mockFetch(deployResponse('LIVE')), writer, dir),
      parseArgs([dir], { value: ['slug'] }),
      bundlerFor(entries),
    );
    expect(code).toBe(ExitCode.Success);
    expect(entries).toEqual([join(dir, 'index.mjs')]);
  });

  it('prefers index.ts when both are present, since that is what init scaffolds', async () => {
    writeFileSync(join(dir, 'index.mjs'), '// source');
    writeManifest();
    const entries: string[] = [];
    await sourceDev.deploy(
      ctxFor(mockFetch(deployResponse('LIVE')), writer, dir),
      parseArgs([dir], { value: ['slug'] }),
      bundlerFor(entries),
    );
    expect(entries).toEqual([join(dir, 'index.ts')]);
  });

  it('names both filenames when neither is there', async () => {
    rmSync(join(dir, 'index.ts'));
    writeManifest();
    await expect(
      sourceDev.deploy(
        ctxFor(mockFetch(deployResponse('LIVE')), writer, dir),
        parseArgs([dir], { value: ['slug'] }),
        {},
      ),
    ).rejects.toThrow(/index\.ts or index\.mjs/);
  });

  it('refuses a manifest with no egress, naming the file', async () => {
    writeManifest({ egress: undefined });
    const mock = mockFetch(deployResponse('LIVE'));
    await expect(
      sourceDev.deploy(ctxFor(mock, writer, dir), parseArgs([dir], { value: ['slug'] }), {}),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
    // The refusal must name the file the author has open, and must happen
    // before anything is bundled or sent.
    await expect(
      sourceDev.deploy(ctxFor(mock, writer, dir), parseArgs([dir], { value: ['slug'] }), {}),
    ).rejects.toThrow(new RegExp(join(dir, 'manifest.json').replaceAll('/', '\\/')));
    expect(mock.calls).toHaveLength(0);
  });

  it('refuses an empty egress list', async () => {
    writeManifest({ egress: [] });
    const mock = mockFetch(deployResponse('LIVE'));
    await expect(
      sourceDev.deploy(ctxFor(mock, writer, dir), parseArgs([dir], { value: ['slug'] }), {}),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('refuses an egress list that is not all hostnames', async () => {
    writeManifest({ egress: ['example.com', 42] });
    const mock = mockFetch(deployResponse('LIVE'));
    await expect(
      sourceDev.deploy(ctxFor(mock, writer, dir), parseArgs([dir], { value: ['slug'] }), {}),
    ).rejects.toThrow(/non-empty hostname/);
  });

  it('takes the slug from --slug over the manifest id', async () => {
    writeManifest();
    const mock = mockFetch(deployResponse('LIVE'));
    await sourceDev.deploy(
      ctxFor(mock, writer, dir),
      parseArgs([dir, '--slug', 'other-name'], { value: ['slug'] }),
      bundlerFor([]),
    );
    expect(mock.calls[0]?.variables.slug).toBe('other-name');
  });

  it('requires a slug when the manifest has no id', async () => {
    writeManifest({ title: 'Fixture', id: undefined });
    const mock = mockFetch(deployResponse('LIVE'));
    await expect(
      sourceDev.deploy(ctxFor(mock, writer, dir), parseArgs([dir], { value: ['slug'] }), {}),
    ).rejects.toThrow(/--slug/);
  });

  it('errors when index.ts is absent', async () => {
    writeManifest();
    rmSync(join(dir, 'index.ts'));
    const mock = mockFetch(deployResponse('LIVE'));
    await expect(
      sourceDev.deploy(ctxFor(mock, writer, dir), parseArgs([dir], { value: ['slug'] }), {}),
    ).rejects.toThrow(/No index\.ts/);
  });

  it('fails when the deployment did not go live, saying why', async () => {
    writeManifest();
    const mock = mockFetch(deployResponse('FAILED', 'script exceeded the size limit'));
    const code = await sourceDev.deploy(
      ctxFor(mock, writer, dir),
      parseArgs([dir], { value: ['slug'] }),
      bundlerFor([]),
    );
    // Reporting success here would leave the author waiting for documents that
    // nothing is going to produce.
    expect(code).toBe(ExitCode.Transport);
    expect(writer.stderrText()).toMatch(/script exceeded the size limit/);
  });

  it('fails a BUILDING deployment with a reason of its own', async () => {
    writeManifest();
    const mock = mockFetch(deployResponse('BUILDING'));
    const code = await sourceDev.deploy(
      ctxFor(mock, writer, dir),
      parseArgs([dir], { value: ['slug'] }),
      bundlerFor([]),
    );
    expect(code).toBe(ExitCode.Transport);
    expect(writer.stderrText()).toMatch(/will not sync/);
  });

  it('renders the deployment as a human record', async () => {
    writeManifest();
    const mock = mockFetch(deployResponse('LIVE'));
    const ctx = buildContext({
      globals: {},
      writer,
      fetchImpl: mock.fetch,
      configEnv: { home: dir, env: { TROVE_TOKEN: 'tok' } },
      isTTY: true,
    });
    const code = await sourceDev.deploy(ctx, parseArgs([dir], { value: ['slug'] }), bundlerFor([]));
    expect(code).toBe(ExitCode.Success);
    expect(writer.stdoutText()).toMatch(/dev\/u_1\/my-blog/);
    expect(writer.stdoutText()).toMatch(/example\.com/);
  });
});
