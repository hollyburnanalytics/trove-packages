import type { CommandContext } from '../context.js';
import { ExitCode } from '../errors.js';
import { docHandle, renderJson, renderRecord, renderTable, truncate } from '../output.js';
import type { Document, SearchResults } from '../types.js';

/**
 * Presentation for the query-family commands: table/record rendering for
 * search results and documents, the JSON/JSONL/human emit switch, and the
 * word-window pagination used by `trove get`. The commands themselves live in
 * `query.ts`.
 *
 * @module
 */

/** Format a `SearchResults` payload for a human (table of score + handle). */
export function formatSearchResults(ctx: CommandContext, results: SearchResults): string {
  if (results.results.length === 0) return ctx.style.dim('No matches.');
  const rows = results.results.map((r) => [
    r.relevanceScore.toFixed(3),
    truncate(r.document.title ?? '(untitled)', 60),
    r.document.source.name,
    docHandle(r.document.id, ctx.style),
  ]);
  const table = renderTable(['SCORE', 'TITLE', 'SOURCE', 'HANDLE'], rows, ctx.style);
  const footer = ctx.style.dim(`\n${results.totalMatches} match(es) in ${results.queryTimeMs}ms`);
  return table + footer;
}

/** Format a list of documents as a table. */
export function formatDocumentList(ctx: CommandContext, docs: Document[]): string {
  if (docs.length === 0) return ctx.style.dim('No documents.');
  const rows = docs.map((d) => [
    truncate(d.title ?? '(untitled)', 60),
    d.author ?? '',
    d.source.name,
    docHandle(d.id, ctx.style),
  ]);
  return renderTable(['TITLE', 'AUTHOR', 'SOURCE', 'HANDLE'], rows, ctx.style);
}

/** Emit either JSON/JSONL or a human-formatted view. */
export function emit(ctx: CommandContext, data: unknown, jsonlList: unknown, human: string): void {
  if (ctx.output.format === 'jsonl') {
    ctx.writer.out(renderJson(jsonlList, 'jsonl'));
  } else if (ctx.output.format === 'json') {
    ctx.writer.out(renderJson(data, 'json'));
  } else {
    ctx.writer.out(human);
  }
}

/**
 * Slice a document's full text by words, echoing the
 * `trove_get_document` continuation contract: returns the requested word window
 * plus the next offset (or null when the slice reaches the end).
 *
 * @param fullText - The document's full text.
 * @param offsetWords - The starting word offset (0-based).
 * @param maxWords - The maximum number of words to return (undefined = to end).
 * @returns The sliced text, the word counts, and the next offset (or null).
 */
export function sliceWords(
  fullText: string,
  offsetWords: number,
  maxWords: number | undefined,
): { text: string; totalWords: number; returnedWords: number; nextOffset: number | null } {
  const words = fullText.split(/\s+/).filter((w) => w.length > 0);
  const total = words.length;
  const start = Math.min(Math.max(offsetWords, 0), total);
  const end = maxWords === undefined ? total : Math.min(start + Math.max(maxWords, 0), total);
  const slice = words.slice(start, end);
  return {
    text: slice.join(' '),
    totalWords: total,
    returnedWords: slice.length,
    nextOffset: end < total ? end : null,
  };
}

/** Emit a word-sliced view of one document (human or JSON), with a next-offset hint. */
export function emitWordSlice(
  ctx: CommandContext,
  doc: Document,
  offsetWords: number,
  maxWords: number | undefined,
): number {
  const fullText = doc.fullText ?? doc.previewText ?? '';
  const sliced = sliceWords(fullText, offsetWords, maxWords);
  if (ctx.output.format !== 'human') {
    ctx.writer.out(
      renderJson(
        {
          id: doc.id,
          title: doc.title,
          offsetWords,
          ...(maxWords !== undefined ? { maxWords } : {}),
          returnedWords: sliced.returnedWords,
          totalWords: sliced.totalWords,
          nextOffset: sliced.nextOffset,
          text: sliced.text,
        },
        ctx.output.format,
      ),
    );
  } else {
    ctx.writer.out(sliced.text);
    if (sliced.nextOffset !== null) {
      ctx.writer.err(
        ctx.style.dim(
          `… ${String(sliced.returnedWords)}/${String(sliced.totalWords)} words. ` +
            `Continue: trove get ${doc.id} --offset-words ${String(sliced.nextOffset)}`,
        ),
      );
    }
  }
  return ExitCode.Success;
}

/** Format one full document for human reading (record header + full text). */
export function formatDocument(ctx: CommandContext, doc: Document): string {
  const header = renderRecord(
    [
      ['title', doc.title ?? '(untitled)'],
      ['author', doc.author ?? '—'],
      ['source', doc.source.name],
      ['url', doc.url ?? '—'],
      ['handle', `[doc:${doc.id}]`],
    ],
    ctx.style,
  );
  const text = doc.fullText ?? doc.previewText ?? '';
  return `${header}\n\n${text}`;
}
