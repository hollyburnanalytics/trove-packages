import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Cursor, Document, TroveSource } from '@ontrove/extend/source';
import type { CommandContext } from '../context.js';
import { CliError, ExitCode, usageError } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import { type LoadModuleOptions, loadSourceModule } from '../lib/bundle.js';
import { parseCursor } from '../lib/source.js';
import * as ops from '../operations.js';

/**
 * The source dev commands' project plumbing: locate and load a local source
 * project (`index.ts` + `manifest.json` + `--config`), serve offline fixtures
 * to `source test`, and resolve the remote source/feed target for
 * `source sync`. The commands themselves live in `source-dev.ts`.
 *
 * @module
 */

/** Injection points so tests run without the Bun loader/fs/network. */
export interface SourceDevDeps {
  /** Module loader (transpile + import). Defaults to the Bun loader. */
  load?: <T>(entry: string, options?: LoadModuleOptions) => Promise<T>;
}

/** Resolve the source project directory from an optional path positional. */
export function projectDir(args: ParsedArgs): string {
  const p = args.positionals[0] ?? '.';
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Read and JSON-parse `manifest.json` from a project dir, or throw a usage error. */
export function readManifest(dir: string): Record<string, unknown> {
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

/**
 * The entry file of a source project.
 *
 * TypeScript wins when both exist, because that is what `source init`
 * scaffolds. `.mjs` is not a fallback for its own sake: a source is plain ESM
 * with no types of its own to speak of, and every source in the catalogue is
 * written that way — so a command that only knew `index.ts` could not open a
 * single real source, and said "run `trove source init` first" about a project
 * that was already complete.
 *
 * @param dir - The source project directory.
 * @returns Absolute path to the entry file.
 * @throws {@link CliError} (usage) when the directory holds neither.
 */
export function sourceEntry(dir: string): string {
  for (const name of ['index.ts', 'index.mjs']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw usageError(`No index.ts or index.mjs in '${dir}'. Run 'trove source init <name>' first.`);
}

/** Load the source from a project dir, in either shape an adapter may be written in. */
export async function loadSource(dir: string, deps: SourceDevDeps): Promise<TroveSource> {
  const entry = sourceEntry(dir);
  const load = deps.load ?? loadSourceModule;
  const source = await load<TroveSource>(entry);
  if (
    source === null ||
    typeof source !== 'object' ||
    typeof (source as { sync?: unknown }).sync !== 'function'
  ) {
    throw usageError(
      `${entry} is not a source: it must export a \`sync(ctx)\` function, ` +
        'either directly or as `export default defineSource({ sync })`.',
    );
  }
  return source;
}

/** Read a `--config <file.json>` flag into a config object (or `{}`). */
export function readConfig(args: ParsedArgs): Record<string, unknown> {
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

/** A fixtures map: request URL → canned response body. */
type Fixtures = Record<string, string>;

/** Read the fixtures file (a JSON object of url → body). Missing → empty map. */
export function readFixtures(path: string): Fixtures {
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
export function fixtureFetch(fixtures: Fixtures): typeof fetch {
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
export function assertDocuments(docs: Document[]): string[] {
  return docs.length === 0 ? ['sync returned no documents'] : [];
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
export async function resolveTarget(
  ctx: CommandContext,
  manifest: Record<string, unknown>,
  args: ParsedArgs,
): Promise<{ sourceId: string; feedId: string; cursor: Cursor }> {
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
