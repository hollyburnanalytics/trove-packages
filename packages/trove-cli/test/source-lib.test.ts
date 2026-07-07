import type { SourceDocument, Watermark } from '@ontrove/sdk';
import { describe, expect, it } from 'vitest';
import { parseCursor, serializeCursor, toIngestInput } from '../src/lib/source.js';

describe('toIngestInput', () => {
  it('maps a full document onto the wire shape (id → externalId)', () => {
    const doc: SourceDocument = {
      id: 'ext-1',
      title: 't',
      text: 'body',
      url: 'https://x',
      author: 'a',
      date: '2026-01-01T00:00:00Z',
      tags: ['x'],
      metadata: { k: 1 },
      contentType: 'bookmark',
    };
    expect(toIngestInput(doc)).toEqual({
      externalId: 'ext-1',
      title: 't',
      text: 'body',
      url: 'https://x',
      author: 'a',
      date: '2026-01-01T00:00:00Z',
      tags: ['x'],
      metadata: { k: 1 },
      contentType: 'bookmark',
    });
  });

  it('omits undefined fields and supports audioUrl', () => {
    const out = toIngestInput({ id: 'a', audioUrl: 'https://a.mp3' });
    expect(out).toEqual({ externalId: 'a', audioUrl: 'https://a.mp3' });
  });
});

describe('serializeCursor', () => {
  it('serializes date/idSet watermarks and nulls a none watermark', () => {
    expect(serializeCursor({ type: 'none' })).toBeNull();
    expect(serializeCursor({ type: 'date', value: '2026-01-01' })).toBe(
      JSON.stringify({ type: 'date', value: '2026-01-01' }),
    );
    const idSet: Watermark = { type: 'idSet', values: ['1', '2'], max: '2' };
    expect(serializeCursor(idSet)).toBe(JSON.stringify(idSet));
  });
});

describe('parseCursor', () => {
  it('parses a JSON watermark', () => {
    expect(parseCursor(JSON.stringify({ type: 'date', value: 'd' }))).toEqual({
      type: 'date',
      value: 'd',
    });
  });

  it('treats null/empty as none', () => {
    expect(parseCursor(null)).toEqual({ type: 'none' });
    expect(parseCursor(undefined)).toEqual({ type: 'none' });
    expect(parseCursor('')).toEqual({ type: 'none' });
  });

  it('treats a bare non-JSON string as a date watermark', () => {
    expect(parseCursor('2026-06-14')).toEqual({ type: 'date', value: '2026-06-14' });
  });

  it('falls back to a date watermark for JSON without a known type', () => {
    expect(parseCursor('{"foo":1}')).toEqual({ type: 'date', value: '{"foo":1}' });
  });
});
