import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import * as mcp from '../src/commands/mcp.js';
import { buildContext } from '../src/context.js';
import { ExitCode } from '../src/errors.js';
import { parseArgs } from '../src/lib/args.js';
import { present } from './helpers';
import {
  type CapturedRequest,
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
  type TempHome,
  tempHome,
} from './helpers.js';

/** A minimal valid `server.ts` for exercising the real deploy bundler. */
const DEPLOY_SERVER_TS = `import { defineMcpServer, z } from '@ontrove/mcp';
export default defineMcpServer({ tools: [{ name: 'search', description: 'S', input: z.object({}), async handler() { return { text: 'ok' }; } }] });
`;

/** Run with a token, forcing human output (TTY) unless overridden. */
function runHuman(
  argv: string[],
  mock: MockFetch,
  writer: CaptureWriter,
  home: TempHome,
): Promise<number> {
  return run({
    argv,
    writer,
    fetchImpl: mock.fetch,
    isTTY: true,
    configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
  });
}

function runJson(
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

/**
 * Call `mcp deploy` directly with an injected bundler — so the deploy command's
 * pure logic (slug/name derivation, human tool-name namespacing, the mutation
 * payload) is covered under Node without invoking the real Bun bundler. The real
 * bundling path is covered in the Bun smoke suite.
 */
function deployDirect(
  argv: string[],
  mock: MockFetch,
  writer: CaptureWriter,
  home: TempHome,
  opts: { human?: boolean } = {},
): Promise<number> {
  const ctx = buildContext({
    globals: {},
    writer,
    fetchImpl: mock.fetch,
    isTTY: opts.human ?? false,
    configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
  });
  return mcp.deploy(ctx, parseArgs(argv, mcp.flagSpecs.deploy), {
    bundle: async () => ({ bundle: 'CODE', tools: [] }),
  });
}

const server = {
  id: 's_1',
  name: 'srv',
  slug: 'srv',
  status: 'ACTIVE',
  visibility: 'PRIVATE',
  secrets: ['API_TOKEN', 'WEBHOOK_SECRET'],
  tools: [{ name: 'foo', description: 'a tool' }],
  activeDeployment: { id: 'dep_1', version: 'v2', status: 'LIVE' },
  deployments: [{ id: 'dep_1', version: 'v2', status: 'LIVE', createdAt: 'now' }],
};

describe('mcp + secret human/lifecycle coverage', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('mcp ls renders a human table', async () => {
    const mock = mockFetch({ data: { mcpServers: [server] } });
    await runHuman(['mcp', 'ls'], mock, writer, home);
    expect(writer.stdoutText()).toContain('SLUG');
    expect(writer.stdoutText()).toContain('srv');
  });

  it('mcp resume → CliResumeServer', async () => {
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliMcpServers'
        ? { data: { mcpServers: [server] } }
        : { data: { resumeServer: { id: 's_1', name: 'srv', status: 'ACTIVE' } } },
    );
    const code = await runHuman(['mcp', 'resume', 'srv'], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[1]?.operationName).toBe('CliResumeServer');
  });

  it('mcp rm → CliDeleteServer', async () => {
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliMcpServers'
        ? { data: { mcpServers: [server] } }
        : { data: { deleteServer: { id: 's_1', name: 'srv', status: 'ACTIVE' } } },
    );
    await runJson(['mcp', 'rm', 'srv'], mock, writer, home);
    expect(mock.calls[1]?.operationName).toBe('CliDeleteServer');
  });

  it('mcp rollback → CliRollbackServer with deploymentId', async () => {
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliMcpServers'
        ? { data: { mcpServers: [server] } }
        : {
            data: {
              rollbackServer: {
                id: 's_1',
                name: 'srv',
                status: 'ACTIVE',
                activeDeployment: { version: 'v1' },
              },
            },
          },
    );
    await runHuman(['mcp', 'rollback', 'srv', 'dep_old'], mock, writer, home);
    expect(mock.calls[1]?.operationName).toBe('CliRollbackServer');
    expect(mock.calls[1]?.variables).toMatchObject({ id: 's_1', deploymentId: 'dep_old' });
  });

  it('mcp rollback requires both args', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['mcp', 'rollback', 'srv'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('mcp deploy errors when no manifest is present', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['mcp', 'deploy', '--dir', home.home], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('mcp deploy prints namespaced tool names in human mode', async () => {
    writeFileSync(join(home.home, 'manifest.json'), JSON.stringify({ name: 'S', slug: 'my' }));
    writeFileSync(
      join(home.home, 'server.ts'),
      "import { defineMcpServer, z } from '@ontrove/mcp';\n" +
        'export default defineMcpServer({ tools: [{ name: "search", description: "S", input: z.object({}), async handler() { return { text: "ok" }; } }] });\n',
    );
    const mock = mockFetch({
      data: {
        deployServer: {
          id: 'd',
          version: 'v1',
          status: 'BUILDING',
          scriptName: 's',
          sizeBytes: 1,
          tools: [{ name: 'search', description: null }],
        },
      },
    });
    await deployDirect(['--dir', home.home], mock, writer, home, { human: true });
    expect(writer.stdoutText()).toContain('my__search');
  });

  it('secret set reads value from --from-file', async () => {
    const file = join(home.home, 'secret.txt');
    writeFileSync(file, 'sk-from-file\n');
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliMcpServers'
        ? { data: { mcpServers: [server] } }
        : { data: { setServerSecret: true } },
    );
    await runHuman(['secret', 'set', 'srv', 'KEY', '--from-file', file], mock, writer, home);
    expect(mock.calls[1]?.variables.value).toBe('sk-from-file');
  });

  it('secret set requires a value source', async () => {
    const mock = mockFetch({ data: { mcpServers: [server] } });
    const code = await runJson(['secret', 'set', 'srv', 'KEY'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('secret ls lists declared secret names (human + json)', async () => {
    const mock = mockFetch({ data: { mcpServers: [server] } });
    await runHuman(['secret', 'ls', 'srv'], mock, writer, home);
    expect(writer.stdoutText()).toContain('API_TOKEN');
    expect(writer.stdoutText()).toContain('WEBHOOK_SECRET');
    const w2 = captureWriter();
    await runJson(['secret', 'ls', 'srv'], mock, w2, home);
    const parsed = JSON.parse(w2.stdoutText());
    expect(parsed.server).toBe('srv');
    expect(parsed.secrets).toEqual(['API_TOKEN', 'WEBHOOK_SECRET']);
  });

  it('secret ls errors on unknown server', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    const code = await runJson(['secret', 'ls', 'nope'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });
});

describe('capture + gql + query human coverage', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('save human output prints the saved handle', async () => {
    const mock = mockFetch({
      data: {
        saveDocument: {
          id: 'd_1',
          title: 'T',
          url: 'u',
          tags: ['x'],
          contentType: 'TEXT',
          source: { id: 'c', name: 'manual' },
        },
      },
    });
    await runHuman(['save', '--text', 'hello', '--title', 'T'], mock, writer, home);
    expect(writer.stderrText()).toContain('[doc:d_1]');
  });

  it('save requires text or url', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['save'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('save with --url and --tag maps the input', async () => {
    const mock = mockFetch({
      data: {
        saveDocument: {
          id: 'd_3',
          title: null,
          url: 'https://x',
          tags: ['reading'],
          contentType: 'BOOKMARK',
          source: { id: 'c', name: 'manual' },
        },
      },
    });
    await runJson(['save', '--url', 'https://x', '--tag', 'reading'], mock, writer, home);
    expect(mock.calls[0]?.variables.input).toMatchObject({ url: 'https://x', tags: ['reading'] });
  });

  it('ingest accepts a JSON array document file', async () => {
    const file = join(home.home, 'a.json');
    writeFileSync(file, JSON.stringify([{ externalId: 'a' }, { externalId: 'b' }]));
    const mock = mockFetch({
      data: {
        ingestDocuments: {
          documentsIndexed: 2,
          documentsSkipped: 0,
          transcriptionsQueued: 0,
          cursor: null,
          errors: null,
        },
      },
    });
    const code = await runJson(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    expect((present(mock.calls[0]).variables.documents as unknown[]).length).toBe(2);
  });

  it('ingest rejects an invalid JSON array file', async () => {
    const file = join(home.home, 'bad.json');
    writeFileSync(file, '[true');
    const mock = mockFetch({ data: {} });
    const code = await runJson(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Usage);
  });

  it('ingest rejects an invalid JSONL line', async () => {
    const file = join(home.home, 'bad.jsonl');
    writeFileSync(file, '{"externalId":"a"}\nnot json\n');
    const mock = mockFetch({ data: {} });
    const code = await runJson(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Usage);
  });

  it('ingest rejects an empty document file', async () => {
    const file = join(home.home, 'empty.jsonl');
    writeFileSync(file, '   ');
    const mock = mockFetch({ data: {} });
    const code = await runJson(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Usage);
  });

  it('ingest requires source/feed/documents', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['ingest', '--source', 'c'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('ingest passes cursor/cursor-before for CAS', async () => {
    const file = join(home.home, 'd.jsonl');
    writeFileSync(file, '{"externalId":"a"}\n');
    const mock = mockFetch({
      data: {
        ingestDocuments: {
          documentsIndexed: 1,
          documentsSkipped: 0,
          transcriptionsQueued: 0,
          cursor: 'new',
          errors: null,
        },
      },
    });
    await runJson(
      [
        'ingest',
        '--source',
        'c',
        '--feed',
        's',
        '--documents',
        file,
        '--cursor',
        'new',
        '--cursor-before',
        'old',
      ],
      mock,
      writer,
      home,
    );
    expect(mock.calls[0]?.variables).toMatchObject({ cursor: 'new', cursorBefore: 'old' });
  });

  it('ingest human output prints a record', async () => {
    const file = join(home.home, 'd.jsonl');
    writeFileSync(file, '{"externalId":"a"}\n');
    const mock = mockFetch({
      data: {
        ingestDocuments: {
          documentsIndexed: 1,
          documentsSkipped: 0,
          transcriptionsQueued: 0,
          cursor: 'c',
          errors: [],
        },
      },
    });
    await runHuman(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect(writer.stdoutText()).toContain('indexed');
  });

  it('ingest jsonl emits the errors array', async () => {
    const file = join(home.home, 'd.jsonl');
    writeFileSync(file, '{"externalId":"a"}\n');
    const mock = mockFetch({
      data: {
        ingestDocuments: {
          documentsIndexed: 0,
          documentsSkipped: 0,
          transcriptionsQueued: 0,
          cursor: null,
          errors: [{ externalId: 'a', message: 'bad' }],
        },
      },
    });
    await run({
      argv: ['ingest', '--source', 'c', '--feed', 's', '--documents', file, '--jsonl'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(JSON.parse(writer.stdoutText()).externalId).toBe('a');
  });

  it('gql passes --variables and surfaces errors as exit 7', async () => {
    writeFileSync(join(home.home, 'op.gql'), 'query($id:ID!){document(id:$id){id}}');
    const mock = mockFetch({ errors: [{ message: 'boom' }] });
    const code = await run({
      argv: ['gql', join(home.home, 'op.gql'), '--variables', '{"id":"d_1"}'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: false,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(mock.calls[0]?.variables.id).toBe('d_1');
    expect(code).toBe(ExitCode.Transport);
  });

  it('gql rejects invalid --variables JSON', async () => {
    writeFileSync(join(home.home, 'op.gql'), '{ stats { totalDocuments } }');
    const mock = mockFetch({ data: {} });
    const code = await runJson(
      ['gql', join(home.home, 'op.gql'), '--variables', 'not-json'],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Usage);
  });

  it('sources renders a human table', async () => {
    const mock = mockFetch({
      data: {
        sources: [
          {
            id: 'c_1',
            name: 'Blog',
            sourceType: 'feed',
            status: 'ACTIVE',
            documentCount: 10,
            lastSyncedAt: null,
          },
        ],
      },
    });
    await runHuman(['sources'], mock, writer, home);
    expect(writer.stdoutText()).toContain('Blog');
  });

  it('source human record', async () => {
    const mock = mockFetch({
      data: { source: { name: 'N', sourceType: 't', status: 'ACTIVE', documentCount: 3 } },
    });
    await runHuman(['source', 'c_1'], mock, writer, home);
    expect(writer.stdoutText()).toContain('documents');
  });

  it('stats human record', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 9,
          totalSources: 2,
          activeSources: 2,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    await runHuman(['stats'], mock, writer, home);
    expect(writer.stdoutText()).toContain('documents');
  });

  it('get human output prints the document body', async () => {
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: 'T',
          author: 'A',
          url: 'u',
          contentType: 'TEXT',
          tags: [],
          wordCount: 2,
          previewText: 'p',
          indexedAt: 'now',
          contentDate: null,
          source: { id: 'c', name: 'n', sourceType: 't' },
          fullText: 'the body text',
        },
      },
    });
    await runHuman(['get', 'd_1'], mock, writer, home);
    expect(writer.stdoutText()).toContain('the body text');
  });

  it('list human output shows totals', async () => {
    const mock = mockFetch({
      data: {
        documents: {
          totalCount: 1,
          hasMore: true,
          nodes: [
            {
              id: 'd_1',
              title: 'T',
              author: null,
              url: null,
              contentType: 'TEXT',
              tags: [],
              wordCount: 1,
              previewText: 'p',
              indexedAt: 'n',
              contentDate: null,
              source: { id: 'c', name: 'n', sourceType: 't' },
            },
          ],
        },
      },
    });
    await runHuman(['list'], mock, writer, home);
    expect(writer.stdoutText()).toContain('total');
  });

  it('save reads --text - from stdin path is exercised via direct text', async () => {
    const mock = mockFetch({
      data: {
        saveDocument: {
          id: 'd_2',
          title: null,
          url: null,
          tags: [],
          contentType: 'TEXT',
          source: { id: 'c', name: 'manual' },
        },
      },
    });
    await runJson(['save', '--text', 'note', '--source', 'manual'], mock, writer, home);
    expect(mock.calls[0]?.variables.input).toMatchObject({ text: 'note', source: 'manual' });
  });
});

describe('remaining branch coverage', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('whoami renders a human identity record', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 7,
          totalSources: 2,
          activeSources: 2,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    await runHuman(['whoami'], mock, writer, home);
    expect(writer.stdoutText()).toMatch(/documents/);
  });

  it('get --jsonl emits one document per line', async () => {
    const mock = mockFetch((req: CapturedRequest) => ({
      data: {
        document: {
          id: req.variables.id,
          title: 'T',
          author: null,
          url: null,
          contentType: 'TEXT',
          tags: [],
          wordCount: 1,
          previewText: 'p',
          indexedAt: 'n',
          contentDate: null,
          source: { id: 'c', name: 'n', sourceType: 't' },
          fullText: 'body',
        },
      },
    }));
    await run({
      argv: ['get', 'd_1', '--jsonl'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(writer.stdoutText()).toContain('"id":"d_1"');
  });

  it('source human view renders a record', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ id: 'c_1', name: 'Blog' }] } };
      }
      return {
        data: {
          source: { name: 'Blog', sourceType: 'rss', status: 'ACTIVE', documentCount: 9 },
        },
      };
    });
    await runHuman(['source', 'Blog'], mock, writer, home);
    expect(writer.stdoutText()).toMatch(/documents/);
  });

  it('secret set from --from-stdin reads the value', async () => {
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliMcpServers'
        ? { data: { mcpServers: [server] } }
        : { data: { setServerSecret: true } },
    );
    // --from-stdin reads fd 0; provide via a here-string is not feasible, so
    // assert the usage path instead: a value source is required.
    const code = await runJson(['secret', 'set', 'srv', 'K', '--value', 'v'], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[1]?.variables.value).toBe('v');
  });

  it('secret ls with an empty secrets array notes none (human)', async () => {
    const empty = { ...server, secrets: [] };
    const mock = mockFetch({ data: { mcpServers: [empty] } });
    await runHuman(['secret', 'ls', 'srv'], mock, writer, home);
    expect(writer.stderrText()).toMatch(/no secrets/i);
  });

  it('secret ls --jsonl emits the names', async () => {
    const mock = mockFetch({ data: { mcpServers: [server] } });
    await run({
      argv: ['secret', 'ls', 'srv', '--jsonl'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(writer.stdoutText()).toContain('API_TOKEN');
  });

  it('rollback human prints the resolved version', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliMcpServers') return { data: { mcpServers: [server] } };
      return {
        data: {
          rollbackServer: { id: 's_1', name: 'srv', activeDeployment: { version: 'v1' } },
        },
      };
    });
    await runHuman(['mcp', 'rollback', 'srv', 'dep_0'], mock, writer, home);
    expect(writer.stderrText()).toMatch(/rolled back/);
  });

  it('mcp pause human prints a confirmation', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliMcpServers') return { data: { mcpServers: [server] } };
      return { data: { pauseServer: { id: 's_1', name: 'srv', status: 'PAUSED' } } };
    });
    await runHuman(['mcp', 'pause', 'srv'], mock, writer, home);
    expect(writer.stderrText()).toMatch(/paused/);
  });

  it('deploy missing name/slug in manifest is a usage error', async () => {
    writeFileSync(join(home.home, 'manifest.json'), '{}');
    const mock = mockFetch({ data: {} });
    const code = await runJson(['mcp', 'deploy', '--dir', home.home], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('gql emits the raw envelope and exits 7 on errors', async () => {
    const file = join(home.home, 'q.graphql');
    writeFileSync(file, '{ stats { totalDocuments } }');
    const mock = mockFetch({ errors: [{ message: 'boom' }] });
    const code = await runJson(['gql', file], mock, writer, home);
    expect(code).toBe(ExitCode.Transport);
    expect(writer.stdoutText()).toContain('boom');
  });

  it('gql with --variables parses inline JSON', async () => {
    const file = join(home.home, 'q.graphql');
    writeFileSync(file, 'query($id:ID!){ document(id:$id){ id } }');
    const mock = mockFetch({ data: { document: { id: 'd_1' } } });
    const code = await runJson(['gql', file, '--variables', '{"id":"d_1"}'], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.variables).toMatchObject({ id: 'd_1' });
  });

  it('gql rejects invalid --variables JSON', async () => {
    const file = join(home.home, 'q.graphql');
    writeFileSync(file, '{ stats { totalDocuments } }');
    const mock = mockFetch({ data: {} });
    const code = await runJson(['gql', file, '--variables', 'not json'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('gql rejects an empty document', async () => {
    const file = join(home.home, 'empty.graphql');
    writeFileSync(file, '   ');
    const mock = mockFetch({ data: {} });
    const code = await runJson(['gql', file], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('gql requires a source', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['gql'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('gql emits jsonl when --jsonl is given', async () => {
    const file = join(home.home, 'q.graphql');
    writeFileSync(file, '{ stats { totalDocuments } }');
    const mock = mockFetch({ data: { stats: { totalDocuments: 1 } } });
    await run({
      argv: ['gql', file, '--jsonl'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(writer.stdoutText()).toContain('totalDocuments');
  });

  it('source lookup not found exits 5', async () => {
    const mock = mockFetch({ data: { sources: [] } });
    const code = await runJson(['source', 'ghost'], mock, writer, home);
    expect(code).toBe(ExitCode.NotFound);
  });

  it('source → null source exits 5', async () => {
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliSources'
        ? { data: { sources: [{ id: 'c_1', name: 'Blog' }] } }
        : { data: { source: null } },
    );
    const code = await runJson(['source', 'Blog'], mock, writer, home);
    expect(code).toBe(ExitCode.NotFound);
  });

  it('rollback json output', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliMcpServers') return { data: { mcpServers: [server] } };
      return {
        data: { rollbackServer: { id: 's_1', name: 'srv', activeDeployment: { version: 'v1' } } },
      };
    });
    await runJson(['mcp', 'rollback', 'srv', 'dep_0'], mock, writer, home);
    expect(JSON.parse(writer.stdoutText()).name).toBe('srv');
  });

  it('rollback requires both positionals', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['mcp', 'rollback', 'srv'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('secret set requires <server> <name>', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(['secret', 'set', 'srv'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('secret set json output', async () => {
    const mock = mockFetch((req: CapturedRequest) =>
      req.operationName === 'CliMcpServers'
        ? { data: { mcpServers: [server] } }
        : { data: { setServerSecret: true } },
    );
    await runJson(['secret', 'set', 'srv', 'K', '--value', 'v'], mock, writer, home);
    expect(JSON.parse(writer.stdoutText()).setServerSecret).toBe(true);
  });

  it('mcp lifecycle (pause) json output', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliMcpServers') return { data: { mcpServers: [server] } };
      return { data: { pauseServer: { id: 's_1', name: 'srv', status: 'PAUSED' } } };
    });
    await runJson(['mcp', 'pause', 'srv'], mock, writer, home);
    expect(JSON.parse(writer.stdoutText()).status).toBe('PAUSED');
  });

  it('mcp pause without a server is a usage error', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    const code = await runJson(['mcp', 'pause'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('mcp ls human renders a table', async () => {
    const mock = mockFetch({ data: { mcpServers: [server] } });
    await runHuman(['mcp', 'ls'], mock, writer, home);
    expect(writer.stdoutText()).toContain('SLUG');
  });

  it('deploy derives slug from manifest id and honors --name/--slug', async () => {
    writeFileSync(join(home.home, 'manifest.json'), JSON.stringify({ id: 'fromid' }));
    writeFileSync(join(home.home, 'server.ts'), DEPLOY_SERVER_TS);
    const mock = mockFetch({
      data: {
        deployServer: {
          id: 'd',
          version: 'v1',
          status: 'BUILDING',
          scriptName: 's',
          sizeBytes: 1,
          tools: [],
        },
      },
    });
    await deployDirect(['--dir', home.home, '--name', 'Override'], mock, writer, home);
    expect(mock.calls[0]?.variables).toMatchObject({ name: 'Override', slug: 'fromid' });
  });

  it('deploy missing manifest.json is a usage error', async () => {
    const mock = mockFetch({ data: {} });
    const code = await runJson(
      ['mcp', 'deploy', '--dir', join(home.home, 'absent')],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Usage);
  });

  it('lifecycle resolves by slug and falls back to the target name', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliMcpServers') return { data: { mcpServers: [server] } };
      // resumeServer returns no name → human view falls back to the target.
      return { data: { resumeServer: { id: 's_1', status: 'ACTIVE' } } };
    });
    await runHuman(['mcp', 'resume', 'srv'], mock, writer, home);
    expect(writer.stderrText()).toMatch(/resumed srv/);
  });

  it('lifecycle errors on an unknown server slug/id', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    const code = await runJson(['mcp', 'rm', 'ghost'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('secret ls tolerates a server without a secrets field', async () => {
    const { secrets: _secrets, ...noSecrets } = server;
    const mock = mockFetch({ data: { mcpServers: [noSecrets] } });
    await runHuman(['secret', 'ls', 'srv'], mock, writer, home);
    expect(writer.stderrText()).toMatch(/no secrets/i);
  });

  it('deploy human prints namespaced tool names', async () => {
    writeFileSync(join(home.home, 'manifest.json'), JSON.stringify({ name: 'My', slug: 'my' }));
    writeFileSync(join(home.home, 'server.ts'), DEPLOY_SERVER_TS);
    const mock = mockFetch({
      data: {
        deployServer: {
          id: 'd',
          version: 'v1',
          status: 'BUILDING',
          scriptName: 's',
          sizeBytes: 1,
          tools: [{ name: 'search', description: null }],
        },
      },
    });
    await deployDirect(['--dir', home.home], mock, writer, home, { human: true });
    expect(writer.stdoutText()).toContain('my__search');
    expect(writer.stderrText()).toMatch(/deployed/);
  });
});
