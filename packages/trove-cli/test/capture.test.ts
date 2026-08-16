import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { ExitCode } from '../src/errors.js';
import { present } from './helpers';
import {
  type CaptureWriter,
  captureWriter,
  type MockFetch,
  mockFetch,
  type TempHome,
  tempHome,
} from './helpers.js';

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

describe('ingest (CAS)', () => {
  let writer: CaptureWriter;
  let home: TempHome;
  beforeEach(() => {
    writer = captureWriter();
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  it('ingests a JSONL file → mutation CliIngestDocuments with cursor args', async () => {
    const file = join(home.home, 'docs.jsonl');
    writeFileSync(file, '{"externalId":"a","title":"A"}\n{"externalId":"b","title":"B"}\n');
    const mock = mockFetch({
      data: {
        ingestDocuments: {
          documentsIndexed: 2,
          documentsSkipped: 0,
          transcriptionsQueued: 0,
          cursor: 'cur-2',
          errors: [],
        },
      },
    });
    const code = await runCli(
      [
        'ingest',
        '--source',
        'c_1',
        '--feed',
        's_1',
        '--documents',
        file,
        '--cursor',
        'cur-2',
        '--cursor-before',
        'cur-1',
      ],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Success);
    expect(mock.calls[0]?.operationName).toBe('CliIngestDocuments');
    expect(mock.calls[0]?.variables).toMatchObject({
      sourceId: 'c_1',
      feedId: 's_1',
      cursor: 'cur-2',
      cursorBefore: 'cur-1',
    });
    expect((present(mock.calls[0]).variables.documents as unknown[]).length).toBe(2);
  });

  it('accepts a JSON array as well as JSONL', async () => {
    const file = join(home.home, 'docs.json');
    writeFileSync(file, '[{"externalId":"a"}]');
    const mock = mockFetch({
      data: {
        ingestDocuments: {
          documentsIndexed: 1,
          documentsSkipped: 0,
          transcriptionsQueued: 0,
          cursor: null,
          errors: [],
        },
      },
    });
    await runCli(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect((present(mock.calls[0]).variables.documents as unknown[]).length).toBe(1);
  });

  it('maps a cursor CAS rejection to exit 8 (retryable)', async () => {
    const file = join(home.home, 'docs.jsonl');
    writeFileSync(file, '{"externalId":"a"}\n');
    const mock = mockFetch({ errors: [{ message: 'cursor CAS conflict: expected cur-1' }] });
    const code = await runCli(
      ['ingest', '--source', 'c', '--feed', 's', '--documents', file],
      mock,
      writer,
      home,
    );
    expect(code).toBe(ExitCode.Conflict);
  });

  it('errors with exit 2 when required flags are missing', async () => {
    const mock = mockFetch({});
    const code = await runCli(['ingest', '--source', 'c'], mock, writer, home);
    expect(code).toBe(ExitCode.Usage);
  });
});
