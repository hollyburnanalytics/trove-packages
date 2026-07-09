import type { CommandContext } from '../context.js';
import { CliError, ExitCode, usageError } from '../errors.js';
import { type FlagSpec, flag, flagList, intFlag, type ParsedArgs } from '../lib/args.js';
import * as ops from '../operations.js';
import { renderJson, renderRecord, renderTable, truncate } from '../output.js';
import type {
  Document,
  DocumentConnection,
  SearchResults,
  SourceSummary,
  UserStats,
} from '../types.js';
import {
  emit,
  emitWordSlice,
  formatDocument,
  formatDocumentList,
  formatSearchResults,
} from './query-format.js';

export { sliceWords } from './query-format.js';

/** Shared flag spec for the search-family commands. */
const SEARCH_FLAGS = {
  value: ['source', 'source-type', 'author', 'after', 'before', 'type', 'tag', 'feed', 'limit'],
  alias: { l: 'limit' },
};

/**
 * Resolve a `--source` name to its id via `sources` (mirroring the core tools'
 * source-id resolution). A value already shaped like an id is returned as-is.
 *
 * @param ctx - The command context.
 * @param nameOrId - The user-supplied source name or id.
 * @returns The resolved source id.
 * @throws {@link CliError} (not found) when no source matches.
 */
async function resolveSourceId(ctx: CommandContext, nameOrId: string): Promise<string> {
  if (/^c_/.test(nameOrId)) return nameOrId;
  const data = await ctx
    .client()
    .request<{ sources: SourceSummary[] }>(
      { query: ops.SOURCES, operationName: 'CliSources' },
      true,
    );
  const lower = nameOrId.toLowerCase();
  const match =
    data.sources.find((c) => c.id === nameOrId) ??
    data.sources.find((c) => c.name.toLowerCase() === lower) ??
    data.sources.find((c) => c.name.toLowerCase().includes(lower));
  if (!match) throw new CliError(`No source matching '${nameOrId}'.`, ExitCode.NotFound);
  return match.id;
}

/** Build the common search/discover/recent filter variables from flags. */
async function searchVariables(
  ctx: CommandContext,
  args: ParsedArgs,
): Promise<Record<string, unknown>> {
  const vars: Record<string, unknown> = {};
  const source = flag(args, 'source');
  if (source !== undefined) vars.sourceId = await resolveSourceId(ctx, source);
  const sourceType = flag(args, 'source-type');
  if (sourceType !== undefined) vars.sourceType = sourceType;
  const author = flag(args, 'author');
  if (author !== undefined) vars.author = author;
  const after = flag(args, 'after');
  if (after !== undefined) vars.after = after;
  const before = flag(args, 'before');
  if (before !== undefined) vars.before = before;
  const contentType = flag(args, 'type');
  if (contentType !== undefined) vars.contentType = contentType.toUpperCase();
  const tags = flagList(args, 'tag');
  if (tags.length > 0) vars.tags = tags;
  const feed = flag(args, 'feed');
  if (feed !== undefined) vars.feedId = feed;
  const limit = intFlag(args, 'limit');
  if (limit !== undefined) vars.limit = limit;
  return vars;
}

/** `trove search <query>` → `query search`. */
export async function search(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const query = args.positionals.join(' ').trim();
  if (!query) throw usageError('Usage: trove search <query> [--source ...] [--limit N]');
  const vars = await searchVariables(ctx, args);
  vars.query = query;
  const data = await ctx
    .client()
    .request<{ search: SearchResults }>(
      { query: ops.SEARCH, operationName: 'CliSearch', variables: vars },
      true,
    );
  emit(ctx, data.search, data.search.results, formatSearchResults(ctx, data.search));
  return ExitCode.Success;
}

/** `trove discover <topic>` → `query discover`. */
export async function discover(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const topic = args.positionals.join(' ').trim();
  if (!topic) throw usageError('Usage: trove discover <topic>');
  // `discover` accepts only source/feed filters (schema.graphql); the
  // wider search filters do not apply.
  const base = await searchVariables(ctx, args);
  const vars: Record<string, unknown> = { topic };
  if (base.sourceId !== undefined) vars.sourceId = base.sourceId;
  if (base.sourceType !== undefined) vars.sourceType = base.sourceType;
  if (base.feedId !== undefined) vars.feedId = base.feedId;
  if (base.limit !== undefined) vars.limit = base.limit;
  const data = await ctx
    .client()
    .request<{ discover: SearchResults }>(
      { query: ops.DISCOVER, operationName: 'CliDiscover', variables: vars },
      true,
    );
  emit(ctx, data.discover, data.discover.results, formatSearchResults(ctx, data.discover));
  return ExitCode.Success;
}

/** `trove recent` → `query recent`. */
export async function recent(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const vars: Record<string, unknown> = {};
  const source = flag(args, 'source');
  if (source !== undefined) vars.sourceId = await resolveSourceId(ctx, source);
  const author = flag(args, 'author');
  if (author !== undefined) vars.author = author;
  const since = flag(args, 'since');
  if (since !== undefined) vars.since = since;
  const limit = intFlag(args, 'limit');
  if (limit !== undefined) vars.limit = limit;
  const data = await ctx
    .client()
    .request<{ recent: Document[] }>(
      { query: ops.RECENT, operationName: 'CliRecent', variables: vars },
      true,
    );
  emit(ctx, data.recent, data.recent, formatDocumentList(ctx, data.recent));
  return ExitCode.Success;
}

/** `trove get <doc-id…>` → `query document(id)` per id. */
export async function get(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length === 0) throw usageError('Usage: trove get <doc-id…>');
  const offsetWords = intFlag(args, 'offset-words');
  const maxWords = intFlag(args, 'max-words');
  const paged = offsetWords !== undefined || maxWords !== undefined;
  if (paged && args.positionals.length > 1) {
    throw usageError('Word paging (--offset-words/--max-words) supports a single document id.');
  }

  const client = ctx.client();
  const fetched: Document[] = [];
  for (const id of args.positionals) {
    const data = await client.request<{ document: Document | null }>(
      { query: ops.GET_DOCUMENT, operationName: 'CliGetDocument', variables: { id } },
      true,
    );
    if (data.document == null) {
      throw new CliError(`Document not found: ${id}`, ExitCode.NotFound);
    }
    fetched.push(data.document);
  }

  if (paged) {
    return emitWordSlice(ctx, fetched[0] as Document, offsetWords ?? 0, maxWords);
  }

  if (ctx.output.format === 'json') {
    ctx.writer.out(renderJson(fetched.length === 1 ? fetched[0] : fetched, 'json'));
  } else if (ctx.output.format === 'jsonl') {
    ctx.writer.out(renderJson(fetched, 'jsonl'));
  } else {
    ctx.writer.out(fetched.map((d) => formatDocument(ctx, d)).join('\n\n'));
  }
  return ExitCode.Success;
}

/** `trove list` → `query documents` (exhaustive, totalCount). */
export async function list(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const vars: Record<string, unknown> = {};
  const source = flag(args, 'source');
  if (source !== undefined) vars.sourceId = await resolveSourceId(ctx, source);
  const author = flag(args, 'author');
  if (author !== undefined) vars.author = author;
  const contentType = flag(args, 'type');
  if (contentType !== undefined) vars.contentType = contentType.toUpperCase();
  const tags = flagList(args, 'tag');
  if (tags.length > 0) vars.tags = tags;
  const searchText = flag(args, 'search');
  if (searchText !== undefined) vars.search = searchText;
  const sortBy = flag(args, 'sort');
  if (sortBy !== undefined) vars.sortBy = sortBy.toUpperCase();
  const order = flag(args, 'order');
  if (order !== undefined) vars.sortOrder = order.toUpperCase();
  const limit = intFlag(args, 'limit');
  if (limit !== undefined) vars.limit = limit;
  const offset = intFlag(args, 'offset');
  if (offset !== undefined) vars.offset = offset;

  const data = await ctx
    .client()
    .request<{ documents: DocumentConnection }>(
      { query: ops.LIST_DOCUMENTS, operationName: 'CliListDocuments', variables: vars },
      true,
    );
  const human = `${formatDocumentList(ctx, data.documents.nodes)}\n${ctx.style.dim(
    `${data.documents.totalCount} total${data.documents.hasMore ? ' (more available)' : ''}`,
  )}`;
  emit(ctx, data.documents, data.documents.nodes, human);
  return ExitCode.Success;
}

/** `trove sources` → `query sources`. */
export async function sources(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const vars: Record<string, unknown> = {};
  const type = flag(args, 'type');
  if (type !== undefined) vars.sourceType = type;
  const status = flag(args, 'status');
  if (status !== undefined) vars.status = status.toUpperCase();
  const data = await ctx
    .client()
    .request<{ sources: SourceSummary[] }>(
      { query: ops.SOURCES, operationName: 'CliSources', variables: vars },
      true,
    );
  const rows = data.sources.map((c) => [
    c.id,
    truncate(c.name, 40),
    c.sourceType,
    c.status,
    String(c.documentCount),
  ]);
  const human = renderTable(['ID', 'NAME', 'TYPE', 'STATUS', 'DOCS'], rows, ctx.style);
  emit(ctx, data.sources, data.sources, human);
  return ExitCode.Success;
}

/** `trove source <id|name>` → `query source(id)`. */
export async function source(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  if (!target) throw usageError('Usage: trove source <id|name>');
  const id = await resolveSourceId(ctx, target);
  const data = await ctx
    .client()
    .request<{ source: Record<string, unknown> | null }>(
      { query: ops.SOURCE, operationName: 'CliSource', variables: { id } },
      true,
    );
  if (data.source == null) {
    throw new CliError(`Source not found: ${target}`, ExitCode.NotFound);
  }
  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(data.source, ctx.output.format));
  } else {
    const c = data.source as {
      name: string;
      sourceType: string;
      status: string;
      documentCount: number;
    };
    ctx.writer.out(
      renderRecord(
        [
          ['name', c.name],
          ['type', c.sourceType],
          ['status', c.status],
          ['documents', String(c.documentCount)],
        ],
        ctx.style,
      ),
    );
  }
  return ExitCode.Success;
}

/** `trove stats` → `query stats`. */
export async function stats(ctx: CommandContext): Promise<number> {
  const data = await ctx
    .client()
    .request<{ stats: UserStats }>({ query: ops.STATS, operationName: 'CliStats' }, true);
  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(data.stats, ctx.output.format));
  } else {
    ctx.writer.out(
      renderRecord(
        [
          ['documents', String(data.stats.totalDocuments)],
          ['sources', String(data.stats.totalSources)],
          ['active sources', String(data.stats.activeSources)],
        ],
        ctx.style,
      ),
    );
  }
  return ExitCode.Success;
}

/** Flag spec exports so the dispatcher can declare value-flags per command. */
export const flagSpecs: Record<
  'search' | 'discover' | 'recent' | 'get' | 'list' | 'sources' | 'source',
  FlagSpec
> = {
  search: SEARCH_FLAGS,
  discover: SEARCH_FLAGS,
  recent: { value: ['source', 'author', 'since', 'limit'], alias: { l: 'limit' } },
  get: { value: ['offset-words', 'max-words'] },
  list: {
    value: ['source', 'type', 'tag', 'search', 'sort', 'order', 'limit', 'offset'],
    alias: { l: 'limit' },
  },
  sources: { value: ['type', 'status'] },
  source: { boolean: ['feeds', 'sync-runs'] },
};
