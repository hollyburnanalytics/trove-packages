import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandPaths, run } from '../src/cli.js';
import { ExitCode } from '../src/errors.js';
import {
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
  type TempHome,
  tempHome,
} from './helpers.js';

describe('dispatcher', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  const baseEnv = (mock: MockFetch) => ({
    writer,
    fetchImpl: mock.fetch,
    isTTY: false,
    configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } as NodeJS.ProcessEnv },
  });

  it('prints usage with no args and exits 0', async () => {
    const code = await run({ argv: [], writer });
    expect(code).toBe(ExitCode.Success);
    expect(writer.stdoutText()).toContain('Usage: trove');
  });

  it('prints usage with --help', async () => {
    const code = await run({ argv: ['--help'], writer });
    expect(code).toBe(ExitCode.Success);
    expect(writer.stdoutText()).toContain('Auth:');
  });

  it('prints the version with --version and -v', async () => {
    let code = await run({ argv: ['--version'], writer });
    expect(code).toBe(ExitCode.Success);
    expect(writer.stdoutText().trim()).toMatch(/^\d+\.\d+\.\d+/);

    const w2 = captureWriter();
    code = await run({ argv: ['-v'], writer: w2 });
    expect(code).toBe(ExitCode.Success);
    expect(w2.stdoutText().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('errors with exit 2 on an unknown command', async () => {
    const mock = mockFetch({});
    const code = await run({ argv: ['frobnicate'], ...baseEnv(mock) });
    expect(code).toBe(ExitCode.Usage);
    expect(writer.stderrText()).toContain('Unknown command');
  });

  it('an auth-less call exits 4', async () => {
    const mock = mockFetch({ data: { stats: {} } });
    const code = await run({
      argv: ['stats'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: false,
      configEnv: { home: home.home, env: {} },
    });
    expect(code).toBe(ExitCode.Auth);
  });

  it('matches a two-token command path (toolkit ls) over a one-token one', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    const code = await run({ argv: ['toolkit', 'ls'], ...baseEnv(mock) });
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliToolkits');
  });

  it('accepts a global value flag with = syntax (--endpoint=…)', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    const code = await run({
      argv: ['--endpoint=http://localhost:9', 'toolkit', 'ls'],
      ...baseEnv(mock),
    });
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.url).toContain('localhost:9');
  });

  it('errors when a global value flag is missing its value', async () => {
    const mock = mockFetch({});
    const code = await run({ argv: ['--endpoint'], ...baseEnv(mock) });
    expect(code).toBe(ExitCode.Usage);
    expect(writer.stderrText()).toMatch(/requires a value/);
  });

  it('passes tokens after -- through verbatim', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    // `--` enters passthrough; subsequent --json is NOT treated as a global flag.
    const code = await run({ argv: ['toolkit', 'ls', '--'], ...baseEnv(mock) });
    expect(code).toBe(ExitCode.Success);
  });

  it('honors a global --profile selector', async () => {
    const mock = mockFetch({ data: { mcpServers: [] } });
    const code = await run({ argv: ['--profile', 'prod', 'toolkit', 'ls'], ...baseEnv(mock) });
    expect(code).toBe(ExitCode.Success);
  });

  it('routes global --json before the command', async () => {
    const mock = mockFetch({
      data: {
        stats: {
          totalDocuments: 1,
          totalSources: 1,
          activeSources: 1,
          documentsBySourceType: [],
          documentsByContentType: [],
          recentSyncRuns: [],
        },
      },
    });
    const code = await run({ argv: ['--json', 'stats'], ...baseEnv(mock), isTTY: true });
    expect(code).toBe(ExitCode.Success);
    expect(() => JSON.parse(writer.stdoutText())).not.toThrow();
  });

  it('the registry covers every documented command path', () => {
    for (const path of [
      'login',
      'logout',
      'whoami',
      'search',
      'discover',
      'recent',
      'get',
      'list',
      'sources',
      'source',
      'stats',
      'save',
      'ingest',
      'toolkit ls',
      'toolkit deploy',
      'toolkit pause',
      'toolkit resume',
      'toolkit rollback',
      'toolkit rm',
      'secret set',
      'secret ls',
      'source init',
      'source dev',
      'source test',
      'source validate',
      'source sync',
      'source deploy',
      'toolkit init',
      'toolkit dev',
      'toolkit logs',
      'gql',
    ]) {
      expect(commandPaths).toContain(path);
    }
  });
});

describe('output shaping (human vs json)', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('renders a human table for search at a TTY', async () => {
    const mock = mockFetch({
      data: {
        search: {
          totalMatches: 1,
          queryTimeMs: 3,
          results: [
            {
              relevanceScore: 0.91,
              snippet: 's',
              document: {
                id: 'd_1',
                title: 'Indexing',
                author: 'A',
                url: null,
                contentType: 'TEXT',
                tags: [],
                wordCount: 1,
                previewText: 'p',
                indexedAt: 'now',
                contentDate: null,
                source: { id: 'c', name: 'Blog', sourceType: 't' },
              },
            },
          ],
        },
      },
    });
    await run({
      argv: ['search', 'indexing'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok', NO_COLOR: '1' } },
    });
    const out = writer.stdoutText();
    expect(out).toContain('SCORE');
    expect(out).toContain('[doc:d_1]');
    expect(out).toContain('Indexing');
  });

  it('emits jsonl (one result per line) for --jsonl search', async () => {
    const mock = mockFetch({
      data: {
        search: {
          totalMatches: 2,
          queryTimeMs: 1,
          results: [
            {
              relevanceScore: 1,
              snippet: 's',
              document: {
                id: 'd_1',
                title: 'A',
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
            },
            {
              relevanceScore: 0.5,
              snippet: 's',
              document: {
                id: 'd_2',
                title: 'B',
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
            },
          ],
        },
      },
    });
    await run({
      argv: ['search', 'x', '--jsonl'],
      writer,
      fetchImpl: mock.fetch,
      isTTY: true,
      configEnv: { home: home.home, env: { TROVE_TOKEN: 'tok' } },
    });
    const lines = writer.stdoutText().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).document.id).toBe('d_1');
  });
});
