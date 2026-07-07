import { readFileSync } from 'node:fs';
import type { CommandContext } from '../context.js';
import { ExitCode, usageError } from '../errors.js';
import { flag, flagList, type ParsedArgs } from '../lib/args.js';
import * as ops from '../operations.js';
import { renderJson, renderRecord } from '../output.js';
import type { Document, IngestResult } from '../types.js';

/** Read stdin to a string (for `--text -` / `--documents -`). */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * `trove save` → `mutation saveDocument`. Manual capture of free text or a URL
 * into the manual source. `--text -` reads from stdin.
 *
 * @param ctx - The command context.
 * @param args - Parsed flags (`--text`/`--url`/`--title`/`--tag`/`--source`).
 * @returns The process exit code.
 */
export async function save(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const url = flag(args, 'url');
  let text = flag(args, 'text');
  if (text === '-') text = readStdin().trim();

  if (!url && !text) {
    throw usageError(
      'Usage: trove save (--text <text>|--text -|--url <url>) [--title ...] [--tag ...]',
    );
  }

  const input: Record<string, unknown> = {};
  if (text) input.text = text;
  if (url !== undefined) input.url = url;
  const title = flag(args, 'title');
  if (title !== undefined) input.title = title;
  const tags = flagList(args, 'tag');
  if (tags.length > 0) input.tags = tags;
  const source = flag(args, 'source');
  if (source !== undefined) input.source = source;

  const data = await ctx.client().request<{ saveDocument: Document }>({
    query: ops.SAVE_DOCUMENT,
    operationName: 'CliSaveDocument',
    variables: { input },
  });

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(data.saveDocument, ctx.output.format));
  } else {
    const d = data.saveDocument;
    ctx.writer.err(ctx.style.green(`✓ saved [doc:${d.id}]`));
    ctx.writer.out(
      renderRecord(
        [
          ['id', d.id],
          ['title', d.title ?? '(untitled)'],
          ['url', d.url ?? '—'],
          ['tags', d.tags.join(', ') || '—'],
        ],
        ctx.style,
      ),
    );
  }
  return ExitCode.Success;
}

/**
 * `trove ingest` → `mutation ingestDocuments`. The lower-level ingest boundary
 * for source authors and bulk scripts, honoring the cursor
 * compare-and-swap: `--cursor` (new watermark) + `--cursor-before` (expected
 * current). On CAS rejection the CLI exits {@link ExitCode.Conflict} (8) so a
 * script can re-read `IngestResult.cursor` and retry.
 *
 * @param ctx - The command context.
 * @param args - Parsed flags (`--source`, `--feed`, `--documents`, ...).
 * @returns The process exit code.
 */
export async function ingest(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const sourceId = flag(args, 'source');
  const feedId = flag(args, 'feed');
  const docsArg = flag(args, 'documents');
  if (!sourceId || !feedId || !docsArg) {
    throw usageError('Usage: trove ingest --source <id> --feed <id> --documents <file.jsonl|->');
  }

  const raw = docsArg === '-' ? readStdin() : readFileSync(docsArg, 'utf8');
  const documents = parseDocuments(raw);
  if (documents.length === 0) throw usageError('No documents to ingest (input was empty).');

  const variables: Record<string, unknown> = { sourceId, feedId, documents };
  const cursor = flag(args, 'cursor');
  if (cursor !== undefined) variables.cursor = cursor;
  const cursorBefore = flag(args, 'cursor-before');
  if (cursorBefore !== undefined) variables.cursorBefore = cursorBefore;

  // ingestDocuments is idempotent/CAS-guarded; classifyError maps a cursor
  // conflict to exit 8. We surface the effective cursor to stderr for retry.
  const data = await ctx.client().request<{ ingestDocuments: IngestResult }>({
    query: ops.INGEST_DOCUMENTS,
    operationName: 'CliIngestDocuments',
    variables,
  });
  const result = data.ingestDocuments;

  if (ctx.output.format === 'jsonl') {
    ctx.writer.out(renderJson(result.errors ?? [], 'jsonl'));
  } else if (ctx.output.format === 'json') {
    ctx.writer.out(renderJson(result, 'json'));
  } else {
    ctx.writer.out(
      renderRecord(
        [
          ['indexed', String(result.documentsIndexed)],
          ['skipped', String(result.documentsSkipped)],
          ['transcriptions queued', String(result.transcriptionsQueued)],
          ['cursor', result.cursor ?? '—'],
          ['errors', String(result.errors?.length ?? 0)],
        ],
        ctx.style,
      ),
    );
  }
  return ExitCode.Success;
}

/** Parse a JSONL stream or a JSON array into IngestDocumentInput objects. */
function parseDocuments(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw usageError('Documents JSON array is not valid JSON.');
    }
    if (!Array.isArray(parsed)) throw usageError('Documents JSON must be an array.');
    return parsed;
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw usageError(`Invalid JSON on documents line ${i + 1}.`);
      }
    });
}

/** Flag specs for the capture commands. */
export const flagSpecs = {
  save: { value: ['text', 'url', 'title', 'tag', 'source'] },
  ingest: { value: ['source', 'feed', 'documents', 'cursor', 'cursor-before'] },
};
