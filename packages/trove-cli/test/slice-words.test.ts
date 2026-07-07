import { describe, expect, it } from 'vitest';
import { sliceWords } from '../src/commands/query.js';

describe('sliceWords', () => {
  const text = 'a b c d e';

  it('returns the whole text when maxWords is undefined', () => {
    const r = sliceWords(text, 0, undefined);
    expect(r.text).toBe('a b c d e');
    expect(r.totalWords).toBe(5);
    expect(r.nextOffset).toBeNull();
  });

  it('slices a window and reports the next offset', () => {
    const r = sliceWords(text, 1, 2);
    expect(r.text).toBe('b c');
    expect(r.returnedWords).toBe(2);
    expect(r.nextOffset).toBe(3);
  });

  it('clamps an offset past the end to an empty slice', () => {
    const r = sliceWords(text, 99, 5);
    expect(r.text).toBe('');
    expect(r.returnedWords).toBe(0);
    expect(r.nextOffset).toBeNull();
  });

  it('clamps a negative offset and max to zero', () => {
    expect(sliceWords(text, -3, undefined).text).toBe('a b c d e');
    expect(sliceWords(text, 0, -1).text).toBe('');
  });

  it('collapses runs of whitespace', () => {
    const r = sliceWords('  one   two\nthree ', 0, undefined);
    expect(r.totalWords).toBe(3);
    expect(r.text).toBe('one two three');
  });
});
