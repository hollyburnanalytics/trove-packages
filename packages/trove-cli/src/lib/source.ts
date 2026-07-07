import type { SourceDocument, Watermark } from '@ontrove/sdk';

/**
 * Shared helpers for the source dev loop (`source dev/test/sync`): mapping
 * `@ontrove/sdk`'s `SourceDocument` onto the GraphQL `IngestDocumentInput`, and
 * (de)serializing the typed {@link Watermark} to/from the opaque
 * `Feed.cursor`/`ingestDocuments(cursor)` string.
 *
 * @module
 */

/** The `IngestDocumentInput` shape the GraphQL `ingestDocuments` mutation accepts. */
export interface IngestDocumentInput {
  /** The dedup key — maps from `SourceDocument.id`. */
  externalId: string;
  /** The document title. */
  title?: string;
  /** Full plain-text content. */
  text?: string;
  /** URL to an audio file (triggers transcription). */
  audioUrl?: string;
  /** Canonical link back to the original. */
  url?: string;
  /** Content author / podcast show name. */
  author?: string;
  /** ISO 8601 creation date. */
  date?: string;
  /** String tags. */
  tags?: string[];
  /** Arbitrary source-specific JSON. */
  metadata?: Record<string, unknown>;
  /** One of `text`/`transcript`/`highlight`/`bookmark` (upper-cased server-side). */
  contentType?: string;
}

/**
 * Map a source document to the `IngestDocumentInput` wire shape (the 1:1
 * mapping documented on `SourceDocument`: `id` → `externalId`, etc.). Only
 * defined fields are included so the JSON stays minimal.
 *
 * @param doc - The source document.
 * @returns The wire `IngestDocumentInput`.
 */
export function toIngestInput(doc: SourceDocument): IngestDocumentInput {
  const input: IngestDocumentInput = { externalId: doc.id };
  if (doc.title !== undefined) input.title = doc.title;
  if (doc.text !== undefined) input.text = doc.text;
  if (doc.audioUrl !== undefined) input.audioUrl = doc.audioUrl;
  if (doc.url !== undefined) input.url = doc.url;
  if (doc.author !== undefined) input.author = doc.author;
  if (doc.date !== undefined) input.date = doc.date;
  if (doc.tags !== undefined) input.tags = doc.tags;
  if (doc.metadata !== undefined) input.metadata = doc.metadata;
  if (doc.contentType !== undefined) input.contentType = doc.contentType;
  return input;
}

/**
 * Serialize a {@link Watermark} to the opaque cursor string stored on the feed.
 * A `none` watermark serializes to `null` (no cursor change).
 *
 * @param cursor - The watermark to serialize.
 * @returns The cursor string, or null for `{ type: 'none' }`.
 */
export function serializeCursor(cursor: Watermark): string | null {
  if (cursor.type === 'none') return null;
  return JSON.stringify(cursor);
}

/**
 * Parse the opaque feed cursor string back into a typed {@link Watermark}.
 * Anything malformed or absent resolves to `{ type: 'none' }` so a first run (or
 * a legacy cursor) is always safe.
 *
 * @param raw - The stored cursor string (or null/undefined).
 * @returns The parsed watermark.
 */
export function parseCursor(raw: string | null | undefined): Watermark {
  if (raw === null || raw === undefined || raw === '') return { type: 'none' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const t = (parsed as { type?: unknown }).type;
      if (t === 'date' || t === 'idSet' || t === 'none') return parsed as Watermark;
    }
  } catch {
    // Not JSON — fall through to a date watermark (a bare ISO string cursor).
  }
  return { type: 'date', value: raw };
}
