import { describe, expect, it } from 'vitest';
import { boolFlag, flag, flagList, intFlag, parseArgs } from '../src/lib/args.js';

describe('parseArgs', () => {
  const spec = {
    value: ['limit', 'tag', 'source'],
    boolean: ['create'],
    alias: { l: 'limit' },
  };

  it('separates positionals from flags', () => {
    const p = parseArgs(['hello', 'world', '--limit', '5'], spec);
    expect(p.positionals).toEqual(['hello', 'world']);
    expect(flag(p, 'limit')).toBe('5');
  });

  it('supports --flag=value form', () => {
    const p = parseArgs(['--source=arXiv'], spec);
    expect(flag(p, 'source')).toBe('arXiv');
  });

  it('collects repeatable flags', () => {
    const p = parseArgs(['--tag', 'a', '--tag', 'b'], spec);
    expect(flagList(p, 'tag')).toEqual(['a', 'b']);
  });

  it('resolves aliases', () => {
    const p = parseArgs(['-l', '9'], spec);
    expect(intFlag(p, 'limit')).toBe(9);
  });

  it('treats declared booleans as flags', () => {
    const p = parseArgs(['--create'], spec);
    expect(boolFlag(p, 'create')).toBe(true);
  });

  it('treats `-` as a positional', () => {
    const p = parseArgs(['--limit', '1', '-'], spec);
    expect(p.positionals).toContain('-');
  });

  it('passes through after --', () => {
    const p = parseArgs(['--', '--not-a-flag'], spec);
    expect(p.positionals).toEqual(['--not-a-flag']);
  });

  it('throws when a value flag is missing its value', () => {
    expect(() => parseArgs(['--limit'], spec)).toThrow(/requires a value/);
  });

  it('intFlag rejects non-numeric', () => {
    const p = parseArgs(['--limit', 'abc'], spec);
    expect(() => intFlag(p, 'limit')).toThrow(/must be an integer/);
  });

  it('intFlag returns undefined when absent', () => {
    expect(intFlag(parseArgs([], spec), 'limit')).toBeUndefined();
  });
});
