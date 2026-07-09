import { mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { runSource, type SourceDocument, validateSourceManifest } from '@ontrove/sdk';
import type { CommandContext } from '../context.js';
import { ExitCode, usageError } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import { writeNew } from '../lib/bundle.js';
import {
  type IngestDocumentInput,
  parseCursor,
  serializeCursor,
  toIngestInput,
} from '../lib/source.js';
import * as ops from '../operations.js';
import { renderJson, renderRecord, renderTable, truncate } from '../output.js';
import {
  assertDocuments,
  fixtureFetch,
  loadSource,
  projectDir,
  readConfig,
  readFixtures,
  readManifest,
  resolveTarget,
  type SourceDevDeps,
} from './source-dev-project.js';

/**
 * The source dev toolchain: `source init/dev/test/validate/
 * sync`, all over `@ontrove/sdk`. `init` scaffolds a project; `dev`/`test` run the
 * source's `sync(ctx)` locally (transpiled and run by Bun) and inspect the
 * output; `validate` lints the manifest; `sync` runs locally then pushes via
 * `mutation ingestDocuments` with cursor compare-and-swap. Execution is
 * client-side — the source's fetch runs on the developer's machine,
 * never in the cloud.
 *
 * @module
 */

export type { SourceDevDeps } from './source-dev-project.js';

/**
 * `trove source init <name>` — scaffold `<name>/manifest.json` +
 * `<name>/index.ts` (a `defineSource({ sync })` stub). No GraphQL.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`<name>`).
 * @returns The process exit code.
 */
export async function init(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (!name) throw usageError('Usage: trove source init <name>');
  const dir = isAbsolute(name) ? name : resolve(process.cwd(), name);
  mkdirSync(dir, { recursive: true });

  const id = basename(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const manifest = {
    id: id || 'my-source',
    name: basename(name),
    version: '1.0.0',
    description: `The ${basename(name)} source.`,
    schedule: 'every 6 hours',
    kind: 'feed',
    transport: 'http',
    document_semantics: 'text',
    config: {
      feedUrl: { label: 'Feed URL', type: 'url', placeholder: 'https://example.com/feed.xml' },
    },
  };
  writeNew(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeNew(join(dir, 'index.ts'), SOURCE_STUB);

  ctx.writer.err(ctx.style.green(`✓ scaffolded source '${basename(name)}' in ${dir}`));
  ctx.writer.err(ctx.style.dim('Next: edit index.ts, then `trove source dev` to run it.'));
  return Promise.resolve(ExitCode.Success);
}

/** The scaffolded `index.ts` stub for `source init`. */
const SOURCE_STUB = `import { defineSource } from '@ontrove/sdk';

/**
 * A Trove source: \`sync(ctx)\` fetches new content and returns documents
 * to index. Runs client-side (the CLI dev loop / the Mac app), never in the
 * cloud. See the sources SDK reference.
 */
export default defineSource({
  async sync(ctx) {
    const feedUrl = ctx.config.feedUrl as string | undefined;
    if (!feedUrl) {
      ctx.log('no feedUrl configured; returning a sample document');
      return [
        {
          id: 'sample-1',
          title: 'Hello from your new source',
          text: 'Replace this with documents fetched from your feed.',
          contentType: 'text',
          date: ctx.now().toISOString(),
        },
      ];
    }
    const res = await ctx.fetch(feedUrl);
    const body = await res.text();
    // TODO: parse \`body\` into documents.
    return [
      {
        id: feedUrl,
        title: feedUrl,
        text: body.slice(0, 2000),
        url: feedUrl,
        contentType: 'bookmark',
        date: ctx.now().toISOString(),
      },
    ];
  },
});
`;

/**
 * `trove source dev [path]` — run `sync(ctx)` locally (Bun transpile →
 * `@ontrove/sdk` `runSource`) and print the produced documents. No upload.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`[path]`) + `--config`/`--cursor`.
 * @param deps - Injectable loader (tests).
 * @returns The process exit code.
 */
export async function dev(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: SourceDevDeps = {},
): Promise<number> {
  const dir = projectDir(args);
  const source = await loadSource(dir, deps);
  const config = readConfig(args);
  const cursor = parseCursor(flag(args, 'cursor'));

  const result = await runSource(source, {
    config,
    cursor,
    fetchImpl: (url: string | URL, reqInit?: RequestInit): Promise<Response> =>
      ctx.fetchImpl(url, reqInit),
    logSink: (line: unknown[]): void => {
      if (!ctx.output.quiet) ctx.writer.err(ctx.style.dim(`log: ${line.map(String).join(' ')}`));
    },
  });

  if (ctx.output.format === 'jsonl') {
    ctx.writer.out(renderJson(result.documents, 'jsonl'));
  } else if (ctx.output.format === 'json') {
    ctx.writer.out(renderJson(result.documents, 'json'));
  } else {
    ctx.writer.out(formatDocs(ctx, result.documents));
    ctx.writer.err(
      ctx.style.dim(
        `${String(result.documents.length)} document(s), ` +
          `${String(result.duplicatesSkipped)} duplicate(s) skipped, ` +
          `next cursor: ${serializeCursor(result.cursor) ?? '(unchanged)'}`,
      ),
    );
  }
  return ExitCode.Success;
}

/** Render a source-document preview table. */
function formatDocs(ctx: CommandContext, docs: SourceDocument[]): string {
  if (docs.length === 0) return ctx.style.dim('No documents.');
  const rows = docs.map((d) => [
    d.id,
    truncate(d.title ?? '(untitled)', 50),
    d.contentType ?? 'text',
    String(d.text?.length ?? 0),
  ]);
  return renderTable(['ID', 'TITLE', 'TYPE', 'CHARS'], rows, ctx.style);
}

/**
 * `trove source test [path]` — run `sync(ctx)` against a fixtures file and
 * assert the document shape. The fixtures file (`--fixtures`, default
 * `fixtures/responses.json`) maps request URLs to canned response bodies, so the
 * run is deterministic and offline. No GraphQL.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`[path]`) + `--fixtures`/`--config`.
 * @param deps - Injectable loader (tests).
 * @returns The process exit code (2 if assertions fail).
 */
export async function test(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: SourceDevDeps = {},
): Promise<number> {
  const dir = projectDir(args);
  const source = await loadSource(dir, deps);
  const config = readConfig(args);

  const fixturesPath = flag(args, 'fixtures') ?? join(dir, 'fixtures', 'responses.json');
  const fixtures = readFixtures(fixturesPath);
  const fetchImpl = fixtureFetch(fixtures);

  // `runSource` validates document shape and throws on the first problem;
  // surface that as an assertion failure rather than a crash. A clean run is
  // additionally checked by `assertDocuments` (empty-result detection).
  let documentCount = 0;
  let problems: string[];
  try {
    const result = await runSource(source, { config, fetchImpl });
    documentCount = result.documents.length;
    problems = assertDocuments(result.documents);
  } catch (err) {
    problems = [err instanceof Error ? err.message : String(err)];
  }

  if (ctx.output.format !== 'human') {
    ctx.writer.out(
      renderJson(
        { documents: documentCount, ok: problems.length === 0, problems },
        ctx.output.format,
      ),
    );
  } else if (problems.length === 0) {
    ctx.writer.err(ctx.style.green(`✓ ${String(documentCount)} document(s) passed shape checks`));
  } else {
    for (const p of problems) ctx.writer.err(ctx.style.yellow(`✗ ${p}`));
  }
  return problems.length === 0 ? ExitCode.Success : ExitCode.Usage;
}

/**
 * `trove source validate [path]` — validate `manifest.json` via
 * `@ontrove/sdk`'s `validateSourceManifest` (shape + credential-key lint). No
 * GraphQL.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`[path]`).
 * @returns The process exit code (2 on invalid manifest).
 */
export async function validate(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const dir = projectDir(args);
  const manifest = readManifest(dir);
  const result = validateSourceManifest(manifest);

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(result, ctx.output.format));
  } else if (result.valid) {
    ctx.writer.err(ctx.style.green('✓ manifest.json is valid'));
  } else {
    for (const e of result.errors) ctx.writer.err(ctx.style.yellow(`✗ ${e}`));
  }
  return result.valid ? ExitCode.Success : ExitCode.Usage;
}

/**
 * `trove source sync [path]` — run `sync(ctx)` locally then push the
 * documents via `mutation ingestDocuments` with cursor compare-and-swap. Reads
 * the feed's current cursor as `cursorBefore` and advances it with the
 * watermark `sync` returns.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`[path]`) + `--source`/`--feed`/`--create`/`--config`.
 * @param deps - Injectable loader (tests).
 * @returns The process exit code.
 */
export async function sync(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: SourceDevDeps = {},
): Promise<number> {
  const dir = projectDir(args);
  const manifest = readManifest(dir);
  const source = await loadSource(dir, deps);
  const config = readConfig(args);

  const { sourceId, feedId, cursor } = await resolveTarget(ctx, manifest, args);

  ctx.writer.err(ctx.style.dim('Running sync(ctx) locally…'));
  const result = await runSource(source, {
    config,
    cursor,
    fetchImpl: (url: string | URL, reqInit?: RequestInit): Promise<Response> =>
      ctx.fetchImpl(url, reqInit),
    logSink: (line: unknown[]): void => {
      if (!ctx.output.quiet) ctx.writer.err(ctx.style.dim(`log: ${line.map(String).join(' ')}`));
    },
  });

  const documents: IngestDocumentInput[] = result.documents.map(toIngestInput);
  const variables: Record<string, unknown> = { sourceId, feedId, documents };
  const cursorBefore = serializeCursor(cursor);
  if (cursorBefore !== null) variables.cursorBefore = cursorBefore;
  const cursorAfter = serializeCursor(result.cursor);
  if (cursorAfter !== null) variables.cursor = cursorAfter;

  const ingest = await ctx.client().request<{
    ingestDocuments: {
      documentsIndexed: number;
      documentsSkipped: number;
      transcriptionsQueued: number;
      cursor: string | null;
      errors: Array<{ externalId: string; message: string }> | null;
    };
  }>({ query: ops.INGEST_DOCUMENTS, operationName: 'CliIngestDocuments', variables });
  const out = ingest.ingestDocuments;

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(out, ctx.output.format));
  } else {
    ctx.writer.out(
      renderRecord(
        [
          ['indexed', String(out.documentsIndexed)],
          ['skipped', String(out.documentsSkipped)],
          ['transcriptions queued', String(out.transcriptionsQueued)],
          ['cursor', out.cursor ?? '—'],
          ['errors', String(out.errors?.length ?? 0)],
        ],
        ctx.style,
      ),
    );
  }
  return ExitCode.Success;
}

/** Flag specs for the source dev commands. */
export const flagSpecs = {
  init: {},
  dev: { value: ['config', 'cursor'] },
  test: { value: ['fixtures', 'config'] },
  validate: {},
  sync: { value: ['source', 'feed', 'config'], boolean: ['create'] },
};
