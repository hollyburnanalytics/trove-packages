import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  runSource,
  type SourceDocument,
  type TroveSource,
  validateSourceManifest,
  type Watermark,
} from '@ontrove/sdk';
import type { CommandContext } from '../context.js';
import { CliError, ExitCode, usageError } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import { type LoadModuleOptions, loadModule, writeNew } from '../lib/bundle.js';
import {
  type IngestDocumentInput,
  parseCursor,
  serializeCursor,
  toIngestInput,
} from '../lib/source.js';
import * as ops from '../operations.js';
import { renderJson, renderRecord, renderTable, truncate } from '../output.js';

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

/** Injection points so tests run without the Bun loader/fs/network. */
export interface SourceDevDeps {
  /** Module loader (transpile + import). Defaults to the Bun loader. */
  load?: <T>(entry: string, options?: LoadModuleOptions) => Promise<T>;
}

/** Resolve the source project directory from an optional path positional. */
function projectDir(args: ParsedArgs): string {
  const p = args.positionals[0] ?? '.';
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Read and JSON-parse `manifest.json` from a project dir, or throw a usage error. */
function readManifest(dir: string): Record<string, unknown> {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw usageError(`No manifest.json in '${dir}'. Run 'trove source init <name>' first.`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    throw usageError(`manifest.json in '${dir}' is not valid JSON.`);
  }
}

/** Load the source's default export from `index.ts` in a project dir. */
async function loadSource(dir: string, deps: SourceDevDeps): Promise<TroveSource> {
  const entry = join(dir, 'index.ts');
  if (!existsSync(entry)) {
    throw usageError(`No index.ts in '${dir}'. Run 'trove source init <name>' first.`);
  }
  const load = deps.load ?? loadModule;
  const source = await load<TroveSource>(entry);
  if (
    source === null ||
    typeof source !== 'object' ||
    typeof (source as { sync?: unknown }).sync !== 'function'
  ) {
    throw usageError(`${entry} default export is not a source (expected defineSource(...)).`);
  }
  return source;
}

/** Read a `--config <file.json>` flag into a config object (or `{}`). */
function readConfig(args: ParsedArgs): Record<string, unknown> {
  const path = flag(args, 'config');
  if (path === undefined) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw usageError('--config file must contain a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usageError(`Could not read --config file: ${path}`);
  }
}

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
    fetchImpl: (url, reqInit) => ctx.fetchImpl(url, reqInit),
    logSink: (line) => {
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

/** A fixtures map: request URL → canned response body. */
type Fixtures = Record<string, string>;

/** Read the fixtures file (a JSON object of url → body). Missing → empty map. */
function readFixtures(path: string): Fixtures {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw usageError('Fixtures file must be a JSON object of { url: body }.');
    }
    const out: Fixtures = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usageError(`Could not read fixtures file: ${path}`);
  }
}

/** Build a `fetch` that serves fixtures by URL, 404-ing unknown URLs. */
function fixtureFetch(fixtures: Fixtures): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const body = fixtures[url];
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * Assert the result is usable. Per-document shape (non-empty `id`, `text` or
 * `audioUrl`, valid `contentType`) is already validated by `runSource`, which
 * throws a clear, indexed error the caller surfaces; this only adds the
 * empty-result check on top.
 *
 * @param docs - The validated documents from `runSource`.
 * @returns The list of problems (empty when the run is usable).
 */
function assertDocuments(docs: SourceDocument[]): string[] {
  return docs.length === 0 ? ['sync returned no documents'] : [];
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

/** A feed row from `source(id) { feeds }` (the cursor-bearing slice). */
interface FeedRow {
  id: string;
  name: string;
  externalKey: string;
  cursor: string | null;
}

/**
 * Resolve (or, with `--create`, create) the target source + feed for
 * `source sync`, returning their ids and the feed's current cursor.
 *
 * @param ctx - The command context.
 * @param manifest - The local manifest (for `--create` defaults).
 * @param args - Parsed flags (`--source`/`--feed`/`--create`).
 * @returns The resolved `{ sourceId, feedId, cursor }`.
 */
async function resolveTarget(
  ctx: CommandContext,
  manifest: Record<string, unknown>,
  args: ParsedArgs,
): Promise<{ sourceId: string; feedId: string; cursor: Watermark }> {
  const client = ctx.client();
  const sourceName =
    flag(args, 'source') ?? (typeof manifest.name === 'string' ? manifest.name : undefined);
  const feedKey = flag(args, 'feed') ?? 'default';
  if (!sourceName) throw usageError('Provide --source <name|id> (or a manifest name).');
  const create = args.bools.has('create');

  // Find an existing source by id or name via `sources`.
  const listed = await client.request<{
    sources: Array<{ id: string; name: string }>;
  }>({ query: ops.SOURCES, operationName: 'CliSources' }, true);
  let sourceId = (
    listed.sources.find((c) => c.id === sourceName) ??
    listed.sources.find((c) => c.name.toLowerCase() === sourceName.toLowerCase())
  )?.id;

  if (sourceId === undefined) {
    if (!create) {
      throw new CliError(
        `No source matching '${sourceName}'. Pass --create to create it.`,
        ExitCode.NotFound,
      );
    }
    if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
      throw usageError(
        "manifest.json needs a string 'id' to create the source — run 'trove source validate'.",
      );
    }
    const created = await client.request<{ createSource: { id: string } }>({
      query: ops.CREATE_SOURCE,
      operationName: 'CliCreateSource',
      variables: {
        input: {
          name: sourceName,
          sourceType: manifest.id,
          config: {},
        },
      },
    });
    sourceId = created.createSource.id;
  }

  // Read the source's feeds (with cursor) to find/create the target feed.
  const detail = await client.request<{
    source: { feeds: FeedRow[] } | null;
  }>(
    {
      query: ops.SOURCE_FEEDS,
      operationName: 'CliSourceFeeds',
      variables: { id: sourceId },
    },
    true,
  );
  const feeds = detail.source?.feeds ?? [];
  let feed = feeds.find((s) => s.id === feedKey || s.externalKey === feedKey);

  if (feed === undefined) {
    if (!create) {
      throw new CliError(
        `No feed '${feedKey}' on the source. Pass --create to create it.`,
        ExitCode.NotFound,
      );
    }
    const added = await client.request<{ addFeed: FeedRow }>({
      query: ops.ADD_FEED,
      operationName: 'CliAddFeed',
      variables: { sourceId, name: feedKey, externalKey: feedKey, config: {} },
    });
    feed = added.addFeed;
  }

  return { sourceId, feedId: feed.id, cursor: parseCursor(feed.cursor) };
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
    fetchImpl: (url, reqInit) => ctx.fetchImpl(url, reqInit),
    logSink: (line) => {
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
