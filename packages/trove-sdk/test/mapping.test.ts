import { describe, expect, it } from 'vitest';
import { defineSource } from '../src/define.js';
import { runSource } from '../src/runtime.js';
import type { Document } from '../src/types.js';

/**
 * The `IngestDocumentInput` wire shape (schema.graphql). `externalId` is the only
 * required field; the rest are optional. This is what a `Document` maps
 * 1:1 onto when the Mac app pushes it via `ingestDocuments`.
 */
interface IngestDocumentInput {
  externalId: string;
  title?: string;
  text?: string;
  audioUrl?: string;
  url?: string;
  author?: string;
  date?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  contentType?: 'text' | 'transcript' | 'highlight' | 'bookmark';
}

/** The mapping the Mac app applies: `id` → `externalId`, everything else identical. */
function toIngestInput(doc: Document): IngestDocumentInput {
  const { id, ...rest } = doc;
  return { externalId: id, ...rest };
}

describe('Document → IngestDocumentInput mapping', () => {
  it('maps id to externalId and carries every other field 1:1', async () => {
    const source = defineSource({
      async sync() {
        return [
          {
            id: 'guid-123',
            title: 'A Story',
            text: 'body text',
            url: 'https://example.com/a',
            author: 'pg',
            date: '2026-06-14T09:00:00Z',
            tags: ['tech', 'startups'],
            metadata: { score: 42 },
            contentType: 'bookmark',
          },
        ];
      },
    });

    const { documents } = await runSource(source);
    const input = toIngestInput(documents[0] as Document);

    expect(input).toEqual({
      externalId: 'guid-123',
      title: 'A Story',
      text: 'body text',
      url: 'https://example.com/a',
      author: 'pg',
      date: '2026-06-14T09:00:00Z',
      tags: ['tech', 'startups'],
      metadata: { score: 42 },
      contentType: 'bookmark',
    });
    // No stray `id` key leaks through.
    expect('id' in input).toBe(false);
  });

  it('maps an audio document (audioUrl, no text) for transcription', async () => {
    const source = defineSource({
      async sync() {
        return [
          {
            id: 'ep-7',
            title: 'Show: Episode 7',
            audioUrl: 'https://cdn.example.com/ep7.mp3',
            author: 'The Show', // show name in author, per Trove convention
            date: '2026-06-13T00:00:00Z',
          },
        ];
      },
    });

    const { documents } = await runSource(source);
    const input = toIngestInput(documents[0] as Document);
    expect(input.externalId).toBe('ep-7');
    expect(input.audioUrl).toBe('https://cdn.example.com/ep7.mp3');
    expect(input.text).toBeUndefined();
    expect(input.author).toBe('The Show');
  });
});
