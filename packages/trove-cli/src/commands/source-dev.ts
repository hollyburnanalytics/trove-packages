import { mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { type Document, runSource, validateSourceManifest } from '@ontrove/extend/source';
import type { CommandContext } from '../context.js';
import { ExitCode, usageError } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import { bundleSource, writeNew } from '../lib/bundle.js';
import {
  type IngestDocumentInput,
  parseCursor,
  serializeCursor,
  toIngestInput,
} from '../lib/source.js';
import * as ops from '../operations.js';
import { renderJson, renderRecord, renderTable, truncate } from '../output.js';
import type { SourceDeployment } from '../types.js';
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
  sourceEntry,
} from './source-dev-project.js';

/**
 * The source dev toolchain: `source init/dev/test/validate/sync/deploy`, all
 * over `@ontrove/extend/source`. `init` scaffolds a project; `dev`/`test` run the
 * source's `sync(ctx)` locally (transpiled and run by Bun) and inspect the
 * output; `validate` lints the manifest; `sync` runs locally then pushes via
 * `mutation ingestDocuments` with cursor compare-and-swap.
 *
 * Everything except `deploy` is client-side — the source's fetch runs on the
 * developer's machine. `deploy` is the one verb that changes where the source
 * runs: it uploads the source itself, after which Trove syncs it on schedule
 * whether or not the author's machine is awake.
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
  // ONE declaration, used twice: it is written into `index.ts` as the argument
  // to `defineSource`, and emitted as `manifest.json` from that same object.
  // Two hand-written copies is what this scaffold used to be, and they drifted
  // — the manifest still said `watermark`, `documentSemantics`, `location` and
  // `needs_browser` long after those names were retired. Nothing objected,
  // because `source validate` in authoring mode requires almost none of them:
  // the author found out at deploy.
  const declaration = {
    id: id || 'my-source',
    name: basename(name),
    description: `The ${basename(name)} source.`,
    icon: '📄',
    version: '1.0.0',
    author: 'you',
    kind: 'scheduled-sync',
    transport: 'feed',
    cursor: 'date',
    ingest: 'append',
    runsIn: 'cloud',
    schedule: 'every 6 hours',
    status: 'implemented',
    needsBrowser: false,
    egress: ['config:feedUrl'],
    config: {
      feedUrl: { label: 'Feed URL', type: 'url', placeholder: 'https://example.com/feed.xml' },
    },
  };
  writeNew(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ ...declaration, generated: true }, null, 2)}\n`,
  );
  writeNew(join(dir, 'extension.ts'), sourceStub(declaration));

  ctx.writer.err(ctx.style.green(`✓ scaffolded source '${basename(name)}' in ${dir}`));
  ctx.writer.err(ctx.style.dim('Next: edit index.ts, then `trove source dev` to run it.'));
  return Promise.resolve(ExitCode.Success);
}

/**
 * The scaffolded `index.ts`, built from the same declaration the manifest is.
 *
 * @param declaration - The source's manifest fields.
 * @returns The `index.ts` contents.
 */
function sourceStub(declaration: Record<string, unknown>): string {
  const fields = JSON.stringify(declaration, null, 2).slice(2, -2);
  return `import { defineSource } from '@ontrove/extend/source';

/**
 * A Trove source: \`sync(ctx)\` fetches new content and returns documents
 * to index. Runs client-side (the CLI dev loop / the Mac app), never in the
 * cloud. See the sources SDK reference.
 */
export default defineSource({
${fields},
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
}

/**
 * `trove source dev [path]` — run `sync(ctx)` locally (Bun transpile →
 * `@ontrove/extend/source` `runSource`) and print the produced documents. No upload.
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
function formatDocs(ctx: CommandContext, docs: Document[]): string {
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
 * `@ontrove/extend/source`'s `validateSourceManifest` (shape + credential-key lint). No
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

/** Injection point for {@link deploy} (so tests run without the Bun bundler). */
export interface SourceDeployDeps {
  /** The source bundler. Defaults to {@link bundleSource}. */
  bundle?: (entry: string) => Promise<string>;
}

/**
 * Read the manifest's `egress` allowlist, refusing a manifest without one.
 *
 * The server refuses this too. Refusing it here as well is the point: the
 * allowlist is the deployed source's entire reach, so a deploy that omitted it
 * would upload code guaranteed to fail at runtime — and the failure would
 * appear as a network error hours later, on a machine the author cannot see,
 * rather than as a sentence naming the file they have open.
 *
 * @param manifest - The parsed manifest.
 * @param manifestPath - The file to name in the refusal.
 * @returns The declared hosts.
 * @throws {@link CliError} (usage) when `egress` is missing, empty, or not a list of hosts.
 */
function requireEgress(manifest: Record<string, unknown>, manifestPath: string): string[] {
  const declared = manifest.egress;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw usageError(
      `${manifestPath} declares no \`egress\` — a deployed source can reach only the hosts it ` +
        'lists, so a source without one can fetch nothing. Add e.g. "egress": ["example.com"].',
    );
  }
  const hosts = declared.filter((h): h is string => typeof h === 'string' && h !== '');
  if (hosts.length !== declared.length) {
    throw usageError(`${manifestPath}: every \`egress\` entry must be a non-empty hostname.`);
  }
  return hosts;
}

/**
 * `trove source deploy [path]` — bundle the adapter with the runtime shim and
 * hand it to `mutation deploySource`, so the source runs on Trove's schedule
 * instead of only while the author's machine is awake.
 *
 * The sibling of `trove toolkit deploy`. Unlike `source sync`, which runs the sync
 * here and pushes the documents, this uploads the source itself — after which
 * nothing local is involved in a sync.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`[path]`) + `--slug`.
 * @param deps - Injectable bundler (tests).
 * @returns The process exit code (non-zero when the deployment is not LIVE).
 */
export async function deploy(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: SourceDeployDeps = {},
): Promise<number> {
  const dir = projectDir(args);
  const manifest = readManifest(dir);
  const egress = requireEgress(manifest, join(dir, 'manifest.json'));
  const slug = flag(args, 'slug') ?? (typeof manifest.id === 'string' ? manifest.id : undefined);
  if (slug === undefined || slug === '') {
    throw usageError("manifest.json needs a string 'id' to name the deployment (or pass --slug).");
  }
  const entry = sourceEntry(dir);

  ctx.writer.err(ctx.style.dim(`Bundling ${entry}…`));
  const bundle = await (deps.bundle ?? bundleSource)(entry);

  const data = await ctx.client().request<{ deploySource: SourceDeployment }>({
    query: ops.DEPLOY_SOURCE,
    operationName: 'CliDeploySource',
    variables: { slug, manifest: { ...manifest, bundle } },
  });
  const deployment = data.deploySource;

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(deployment, ctx.output.format));
  } else {
    ctx.writer.out(
      renderRecord(
        [
          ['source type', deployment.sourceType],
          ['version', deployment.version],
          ['status', deployment.status],
          ['size', `${String(deployment.sizeBytes ?? 0)} bytes`],
          ['egress', egress.join(', ')],
        ],
        ctx.style,
      ),
    );
  }

  // Anything but LIVE means no sandbox is serving this source: it will not sync,
  // and reporting success would leave the author waiting for documents that
  // cannot arrive.
  if (deployment.status !== 'LIVE') {
    ctx.writer.err(
      ctx.style.yellow(
        `✗ ${slug} is ${deployment.status}, not LIVE — ` +
          (deployment.error ?? 'nothing is serving this source, so it will not sync.'),
      ),
    );
    return ExitCode.Transport;
  }
  ctx.writer.err(ctx.style.green(`✓ deployed ${slug} (version ${deployment.version})`));
  return ExitCode.Success;
}

/** Flag specs for the source dev commands. */
export const flagSpecs = {
  init: {},
  dev: { value: ['config', 'cursor'] },
  test: { value: ['fixtures', 'config'] },
  validate: {},
  sync: { value: ['source', 'feed', 'config'], boolean: ['create'] },
  deploy: { value: ['slug'] },
};
