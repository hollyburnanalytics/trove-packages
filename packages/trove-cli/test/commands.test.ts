import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { ExitCode } from '../src/errors.js';
import {
  type CapturedRequest,
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
  type TempHome,
  tempHome,
} from './helpers.js';

/** Run the CLI with a logged-in profile (TROVE_TOKEN) and a mock fetch. */
async function runCli(
  argv: string[],
  mock: MockFetch,
  writer: CaptureWriter,
  home: TempHome,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<number> {
  return run({
    argv,
    writer,
    fetchImpl: mock.fetch,
    isTTY: false, // force --json default so we can assert on stdout JSON
    configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok_test', ...extraEnv } },
  });
}

describe('command → GraphQL mapping', () => {
  let writer: CaptureWriter;
  let home: TempHome;

  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('search → query CliSearch with mapped variables', async () => {
    const mock = mockFetch({
      data: { search: { totalMatches: 1, queryTimeMs: 7, results: [] } },
    });
    const code = await runCli(
      [
        'search',
        'vector search',
        '--author',
        'Jane',
        '--limit',
        '25',
        '--tag',
        'ai',
        '--tag',
        'ml',
      ],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliSearch');
    expect(mock.calls[0]?.variables).toMatchObject({
      query: 'vector search',
      author: 'Jane',
      limit: 25,
      tags: ['ai', 'ml'],
    });
  });

  it('search resolves --source name → id via CliSources first', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return {
          data: {
            sources: [
              {
                id: 'c_99',
                name: 'arXiv Papers',
                sourceType: 'feed',
                status: 'ACTIVE',
                documentCount: 1,
                lastSyncedAt: null,
              },
            ],
          },
        };
      }
      return { data: { search: { totalMatches: 0, queryTimeMs: 1, results: [] } } };
    });
    await runCli(['search', 'x', '--source', 'arxiv'], mock, writer, home);
    expect(mock.calls[0]?.operationName).toBe('CliSources');
    expect(mock.calls[1]?.variables.sourceId).toBe('c_99');
  });

  it('search maps every scalar filter to its variable', async () => {
    const mock = mockFetch({
      data: { search: { totalMatches: 0, queryTimeMs: 1, results: [] } },
    });
    await runCli(
      [
        'search',
        'x',
        '--source-type',
        'feed',
        '--after',
        '2026-01-01',
        '--before',
        '2026-02-01',
        '--type',
        'transcript',
        '--feed',
        'f_1',
      ],
      mock,
      writer,
      home,
    );
    expect(mock.calls[0]?.variables).toMatchObject({
      sourceType: 'feed',
      after: '2026-01-01',
      before: '2026-02-01',
      contentType: 'TRANSCRIPT',
      feedId: 'f_1',
    });
  });

  it('search --sort maps to the SearchSortField variable (uppercased)', async () => {
    const mock = mockFetch({
      data: { search: { totalMatches: 0, queryTimeMs: 1, results: [] } },
    });
    await runCli(['search', 'x', '--sort', 'published'], mock, writer, home);
    expect(mock.calls[0]?.variables).toMatchObject({ sortBy: 'PUBLISHED' });
  });

  it('discover → query CliDiscover with its own filter subset', async () => {
    const mock = mockFetch({
      data: { discover: { totalMatches: 0, queryTimeMs: 1, results: [] } },
    });
    await runCli(
      ['discover', 'databases', '--source-type', 'feed', '--feed', 'f_1', '--limit', '7'],
      mock,
      writer,
      home,
    );
    expect(mock.calls[0]?.operationName).toBe('CliDiscover');
    expect(mock.calls[0]?.variables).toMatchObject({
      topic: 'databases',
      sourceType: 'feed',
      feedId: 'f_1',
      limit: 7,
    });
  });

  it('recent → query CliRecent with --since', async () => {
    const mock = mockFetch({ data: { recent: [] } });
    await runCli(['recent', '--since', '2026-01-01', '--limit', '5'], mock, writer, home);
    expect(mock.calls[0]?.operationName).toBe('CliRecent');
    expect(mock.calls[0]?.variables).toMatchObject({ since: '2026-01-01', limit: 5 });
  });

  it('get → query CliGetDocument once per id', async () => {
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
          indexedAt: 'now',
          contentDate: null,
          source: { id: 'c', name: 'n', sourceType: 't' },
          fullText: 'body',
        },
      },
    }));
    const code = await runCli(['get', 'd_1', 'd_2'], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls.map((c) => c.variables.id)).toEqual(['d_1', 'd_2']);
  });

  it('get → exit 5 when a document is null', async () => {
    const mock = mockFetch({ data: { document: null } });
    const code = await runCli(['get', 'missing'], mock, writer, home);
    expect(code).toBe(ExitCode.NotFound);
  });

  it('get --offset-words/--max-words slices the full text (JSON) with a next offset', async () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ');
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: 'T',
          author: null,
          url: null,
          contentType: 'TEXT',
          tags: [],
          wordCount: 10,
          previewText: 'p',
          indexedAt: 'now',
          contentDate: null,
          source: { id: 'c', name: 'n', sourceType: 't' },
          fullText: words,
        },
      },
    });
    const code = await runCli(
      ['get', 'd_1', '--offset-words', '2', '--max-words', '3'],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    const parsed = JSON.parse(writer.stdoutText());
    expect(parsed.text).toBe('w2 w3 w4');
    expect(parsed.returnedWords).toBe(3);
    expect(parsed.totalWords).toBe(10);
    expect(parsed.nextOffset).toBe(5);
  });

  it('get word paging rejects multiple ids', async () => {
    const mock = mockFetch({});
    const code = await runCli(['get', 'd_1', 'd_2', '--max-words', '5'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('get --offset-words only (no max) returns to the end with nextOffset null', async () => {
    const words = 'w0 w1 w2 w3 w4';
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: 'T',
          author: null,
          url: null,
          contentType: 'TEXT',
          tags: [],
          wordCount: 5,
          previewText: 'p',
          indexedAt: 'n',
          contentDate: null,
          source: { id: 'c', name: 'n', sourceType: 't' },
          fullText: words,
        },
      },
    });
    await runCli(['get', 'd_1', '--offset-words', '3'], mock, writer, home);
    const parsed = JSON.parse(writer.stdoutText());
    expect(parsed.text).toBe('w3 w4');
    expect(parsed.nextOffset).toBeNull();
    expect(parsed.maxWords).toBeUndefined();
  });

  it('get human view falls back to (untitled)/— for null fields', async () => {
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: null,
          author: null,
          url: null,
          contentType: 'TEXT',
          tags: [],
          wordCount: 1,
          previewText: 'preview',
          indexedAt: 'n',
          contentDate: null,
          source: { id: 'c', name: 'Blog', sourceType: 't' },
          fullText: null,
        },
      },
    });
    const w = captureWriter();
    await run({
      argv: ['get', 'd_1'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    expect(w.stdoutText()).toContain('(untitled)');
    expect(w.stdoutText()).toContain('preview');
    // Both date axes render; a missing publish date falls back to —.
    expect(w.stdoutText()).toContain('published');
    expect(w.stdoutText()).toContain('indexed');
  });

  it('get human view prints the stages the SERVER reports, not a fixed list', async () => {
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: 'Episode',
          author: 'Show',
          url: null,
          contentType: 'TRANSCRIPT',
          tags: [],
          wordCount: 1,
          previewText: 'p',
          indexedAt: '2026-06-20T00:00:00Z',
          contentDate: '2026-06-15',
          source: { id: 'c', name: 'Podcasts', sourceType: 't' },
          processing: {
            inFlight: false,
            degraded: false,
            stages: [
              { stage: 'ACQUIRE', status: 'DONE', updatedAt: '2026-06-19T00:00:00Z' },
              { stage: 'EXTRACT', status: 'DONE', updatedAt: '2026-06-19T01:00:00Z' },
              { stage: 'FORMAT', status: 'SKIPPED', skipReason: 'VERBATIM_SOURCE' },
              { stage: 'INDEX', status: 'DONE', updatedAt: '2026-06-19T02:00:00Z' },
            ],
          },
          lastProcessedAt: '2026-06-19T02:00:00Z',
          fullText: 'body',
        },
      },
    });
    const w = captureWriter();
    await run({
      argv: ['get', 'd_1'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    const out = w.stdoutText();
    // Exactly the four the server reported, named as it named them. The CLI
    // used to print a hard-coded list of five date fields, which meant it
    // decided what the pipeline's stages were — and printed a stale list the
    // moment the server's stage set changed.
    expect(out).toContain('acquire');
    expect(out).toContain('extract');
    expect(out).toContain('index');
    expect(out).toContain('last processed');
    // A SKIPPED stage is shown with its state rather than hidden: "not needed"
    // answers "why is there no formatted version of this", which a blank row
    // could not distinguish from "never ran".
    expect(out).toContain('format');
    expect(out).toContain('skipped');
    // A stage the document does not have is absent entirely.
    expect(out).not.toContain('enrich');
  });

  it('get word paging (human) prints the slice and a continuation hint', async () => {
    const words = Array.from({ length: 6 }, (_, i) => `w${i}`).join(' ');
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: 'T',
          author: null,
          url: null,
          contentType: 'TEXT',
          tags: [],
          wordCount: 6,
          previewText: 'p',
          indexedAt: 'now',
          contentDate: null,
          source: { id: 'c', name: 'n', sourceType: 't' },
          fullText: words,
        },
      },
    });
    const w = captureWriter();
    await run({
      argv: ['get', 'd_1', '--max-words', '2'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(w.stdoutText()).toBe('w0 w1');
    expect(w.stderrText()).toMatch(/--offset-words 2/);
  });

  it('list → query CliListDocuments with sort/order/offset', async () => {
    const mock = mockFetch({ data: { documents: { totalCount: 0, hasMore: false, nodes: [] } } });
    await runCli(
      ['list', '--sort', 'title', '--order', 'asc', '--offset', '10'],
      mock,
      writer,
      home,
    );
    expect(mock.calls[0]?.operationName).toBe('CliListDocuments');
    expect(mock.calls[0]?.variables).toMatchObject({
      sortBy: 'TITLE',
      sortOrder: 'ASC',
      offset: 10,
    });
  });

  it('list maps every filter (source/type/tag/search) to variables', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ id: 'c_7', name: 'Blog' }] } };
      }
      return { data: { documents: { totalCount: 0, hasMore: false, nodes: [] } } };
    });
    await runCli(
      ['list', '--source', 'Blog', '--type', 'text', '--tag', 'a', '--search', 'q', '--limit', '5'],
      mock,
      writer,
      home,
    );
    const listCall = mock.calls.find((c) => c.operationName === 'CliListDocuments');
    expect(listCall?.variables).toMatchObject({
      sourceId: 'c_7',
      contentType: 'TEXT',
      tags: ['a'],
      search: 'q',
      limit: 5,
    });
  });

  it('recent maps source + author filters', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliSources') {
        return { data: { sources: [{ id: 'c_3', name: 'Blog' }] } };
      }
      return { data: { recent: [] } };
    });
    await runCli(['recent', '--source', 'Blog', '--author', 'Jane'], mock, writer, home);
    const recentCall = mock.calls.find((c) => c.operationName === 'CliRecent');
    expect(recentCall?.variables).toMatchObject({ sourceId: 'c_3', author: 'Jane' });
  });

  it('sources → query CliSources with --type/--status', async () => {
    const mock = mockFetch({ data: { sources: [] } });
    await runCli(['sources', '--type', 'feed', '--status', 'active'], mock, writer, home);
    expect(mock.calls[0]?.variables).toMatchObject({ sourceType: 'feed', status: 'ACTIVE' });
  });

  it('sources human view renders a table', async () => {
    const mock = mockFetch({
      data: {
        sources: [
          { id: 'c_1', name: 'Blog', sourceType: 'rss', status: 'ACTIVE', documentCount: 4 },
        ],
      },
    });
    const w = captureWriter();
    await run({
      argv: ['sources'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    expect(w.stdoutText()).toContain('NAME');
  });

  it('search with no query is a usage error', async () => {
    const mock = mockFetch({});
    const code = await runCli(['search'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('discover with no topic is a usage error', async () => {
    const mock = mockFetch({});
    const code = await runCli(['discover'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });

  it('source resolution errors when no source matches a name', async () => {
    const mock = mockFetch({ data: { sources: [] } });
    const code = await runCli(['search', 'x', '--source', 'nope'], mock, writer, home);
    expect(code).toBe(ExitCode.NotFound);
  });

  it('search human view shows "No matches." for an empty result set', async () => {
    const mock = mockFetch({ data: { search: { totalMatches: 0, queryTimeMs: 1, results: [] } } });
    const w = captureWriter();
    await run({
      argv: ['search', 'x'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    expect(w.stdoutText()).toMatch(/No matches/);
  });

  it('recent human view renders a document table (and an untitled fallback)', async () => {
    const mock = mockFetch({
      data: {
        recent: [
          {
            id: 'd_1',
            title: null,
            author: null,
            url: null,
            contentType: 'TEXT',
            tags: [],
            wordCount: 1,
            previewText: 'p',
            indexedAt: 'n',
            contentDate: null,
            source: { id: 'c', name: 'Blog', sourceType: 't' },
          },
        ],
      },
    });
    const w = captureWriter();
    await run({
      argv: ['recent'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    expect(w.stdoutText()).toContain('(untitled)');
  });

  it('recent human view shows "No documents." when empty', async () => {
    const mock = mockFetch({ data: { recent: [] } });
    const w = captureWriter();
    await run({
      argv: ['recent'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    expect(w.stdoutText()).toMatch(/No documents/);
  });

  it('get human view prints a document record + full text', async () => {
    const mock = mockFetch({
      data: {
        document: {
          id: 'd_1',
          title: 'T',
          author: 'A',
          url: 'https://x',
          contentType: 'TEXT',
          tags: [],
          wordCount: 1,
          previewText: 'p',
          indexedAt: 'n',
          contentDate: null,
          source: { id: 'c', name: 'Blog', sourceType: 't' },
          fullText: 'the body',
        },
      },
    });
    const w = captureWriter();
    await run({
      argv: ['get', 'd_1'],
      writer: w,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    expect(w.stdoutText()).toContain('the body');
    expect(w.stdoutText()).toContain('[doc:d_1]');
  });

  it('source <id> → query CliSource (id passthrough for c_*)', async () => {
    const mock = mockFetch({
      data: { source: { name: 'N', sourceType: 't', status: 'ACTIVE', documentCount: 3 } },
    });
    await runCli(['source', 'c_42'], mock, writer, home);
    expect(mock.calls[0]?.operationName).toBe('CliSource');
    expect(mock.calls[0]?.variables.id).toBe('c_42');
  });

  it('stats → query CliStats', async () => {
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
    await runCli(['stats'], mock, writer, home);
    expect(mock.calls[0]?.operationName).toBe('CliStats');
  });

  it('save → mutation CliSaveDocument with input', async () => {
    const mock = mockFetch({
      data: {
        saveDocument: {
          id: 'd_1',
          title: 'T',
          url: null,
          tags: ['x'],
          contentType: 'TEXT',
          source: { id: 'c', name: 'manual' },
        },
      },
    });
    await runCli(['save', '--url', 'https://e.com', '--tag', 'x'], mock, writer, home);
    expect(mock.calls[0]?.operationName).toBe('CliSaveDocument');
    expect(mock.calls[0]?.variables.input).toMatchObject({ url: 'https://e.com', tags: ['x'] });
  });

  it('toolkit ls → query CliToolkits', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    await runCli(['toolkit', 'ls'], mock, writer, home);
    expect(mock.calls[0]?.operationName).toBe('CliToolkits');
  });

  it('toolkit pause → resolve then mutation CliPauseServer', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliToolkits') {
        return {
          data: {
            mcpServers: [
              {
                id: 's_1',
                name: 'srv',
                slug: 'srv',
                status: 'ACTIVE',
                visibility: 'PRIVATE',
                tools: [],
                activeDeployment: null,
                deployments: [],
              },
            ],
          },
        };
      }
      return { data: { pauseServer: { id: 's_1', name: 'srv', status: 'PAUSED' } } };
    });
    await runCli(['toolkit', 'pause', 'srv'], mock, writer, home);
    expect(mock.calls[1]?.operationName).toBe('CliPauseServer');
    expect(mock.calls[1]?.variables.id).toBe('s_1');
  });

  it('secret set → mutation CliSetServerSecret (value never in argv via --from-stdin path uses --value here)', async () => {
    const mock = mockFetch((req: CapturedRequest) => {
      if (req.operationName === 'CliToolkits') {
        return {
          data: {
            mcpServers: [
              {
                id: 's_1',
                name: 'srv',
                slug: 'srv',
                status: 'ACTIVE',
                visibility: 'PRIVATE',
                tools: [],
                activeDeployment: null,
                deployments: [],
              },
            ],
          },
        };
      }
      return { data: { setServerSecret: true } };
    });
    await runCli(['secret', 'set', 'srv', 'API_KEY', '--value', 'sk-123'], mock, writer, home);
    expect(mock.calls[1]?.operationName).toBe('CliSetServerSecret');
    expect(mock.calls[1]?.variables).toMatchObject({
      serverId: 's_1',
      name: 'API_KEY',
      value: 'sk-123',
    });
  });

  // `toolkit deploy` runs the real Bun bundler
  // (defaultBundleForDeploy), so their end-to-end path — the CliDeployServer
  // payload, the enriched manifest, and full-fidelity tool metadata — is covered
  // in the Bun smoke suite (test/toolchain.smoke.test.ts). Node tests cover the
  // deploy command's pure logic with an injected bundler (coverage-extra.test.ts).

  it('gql → runs a raw document and emits the envelope', async () => {
    writeFileSync(join(home.home, 'op.graphql'), '{ stats { totalDocuments } }');
    const mock = mockFetch({ data: { stats: { totalDocuments: 1 } } });
    const code = await runCli(['gql', join(home.home, 'op.graphql')], mock, writer, home);
    expect(code).toBe(ExitCode.Success);
    expect(writer.stdoutText()).toContain('totalDocuments');
  });
});
