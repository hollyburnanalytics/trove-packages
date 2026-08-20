import { describe, expect, it } from 'vitest';
import { stringList } from '../../src/source/config.js';

/**
 * `stringList` narrows a config field a user filled in, so the cases that
 * matter are the malformed ones — a well-formed list is the one shape nobody
 * gets wrong. Both catalogs shipped a bug from the same field before this
 * moved here, and the shapes below are what those fields actually contained.
 */
describe('stringList', () => {
  it('returns a well-formed list unchanged', () => {
    expect(stringList(['https://a.example/feed', 'https://b.example/feed'])).toEqual([
      'https://a.example/feed',
      'https://b.example/feed',
    ]);
  });

  it('wraps a bare string, which is what a pasted single entry arrives as', () => {
    // The failure this exists for. `const [first] = config.x ?? []` does not
    // throw on a string — it takes its first CHARACTER, so a pasted show uuid
    // became "6" and the run failed against something the user never typed.
    expect(stringList('https://a.example/feed')).toEqual(['https://a.example/feed']);
    expect(stringList('6f3c2a1e')).toEqual(['6f3c2a1e']);
  });

  it('reads an unset field as empty rather than throwing', () => {
    expect(stringList(undefined)).toEqual([]);
    expect(stringList(null)).toEqual([]);
    expect(stringList([])).toEqual([]);
  });

  it('drops blanks and trims, so a trailing newline is not an empty entry', () => {
    expect(stringList(['  https://a.example/feed  ', '', '   ', '\n'])).toEqual([
      'https://a.example/feed',
    ]);
  });

  it('drops a blank bare string', () => {
    expect(stringList('   ')).toEqual([]);
    expect(stringList('')).toEqual([]);
  });

  it('coerces non-strings rather than dropping them silently', () => {
    // A number is what a `text[]` field holds when someone typed a bare id.
    // Coercing keeps it usable; dropping it would lose the entry with no
    // indication that anything went missing.
    expect(stringList([42, 'a'])).toEqual(['42', 'a']);
    expect(stringList(42)).toEqual(['42']);
  });

  it('drops the entries inside a list that are null or undefined', () => {
    // `String(null)` is "null" — a four-character entry that would be fetched
    // as a relative URL. These have to go, not be coerced.
    expect(stringList([null, 'a', undefined])).toEqual(['a']);
  });
});
