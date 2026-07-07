import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultWriter,
  docHandle,
  renderJson,
  renderRecord,
  renderTable,
  resolveOutput,
  Style,
  truncate,
} from '../src/output.js';

describe('defaultWriter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes data to stdout and diagnostics to stderr with a trailing newline', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    defaultWriter.out('hello');
    defaultWriter.err('warn');
    expect(out).toHaveBeenCalledWith('hello\n');
    expect(err).toHaveBeenCalledWith('warn\n');
  });
});

describe('resolveOutput', () => {
  it('auto-selects json when stdout is not a TTY', () => {
    expect(resolveOutput({}, { isTTY: false, env: {} }).format).toBe('json');
  });

  it('selects human at a TTY by default', () => {
    expect(resolveOutput({}, { isTTY: true, env: {} }).format).toBe('human');
  });

  it('honors explicit --jsonl > --json > --human', () => {
    expect(resolveOutput({ jsonl: true, json: true }, { isTTY: true, env: {} }).format).toBe(
      'jsonl',
    );
    expect(resolveOutput({ json: true }, { isTTY: true, env: {} }).format).toBe('json');
    expect(resolveOutput({ human: true }, { isTTY: false, env: {} }).format).toBe('human');
  });

  it('disables color when NO_COLOR is set or --no-color given', () => {
    expect(resolveOutput({}, { isTTY: true, env: { NO_COLOR: '1' } }).color).toBe(false);
    expect(resolveOutput({ noColor: true }, { isTTY: true, env: {} }).color).toBe(false);
  });

  it('enables color only at a TTY in human mode', () => {
    expect(resolveOutput({}, { isTTY: true, env: {} }).color).toBe(true);
    expect(resolveOutput({ json: true }, { isTTY: true, env: {} }).color).toBe(false);
  });
});

describe('renderJson', () => {
  it('pretty-prints for json', () => {
    expect(renderJson({ a: 1 }, 'json')).toBe('{\n  "a": 1\n}');
  });
  it('emits one object per line for jsonl arrays', () => {
    expect(renderJson([{ a: 1 }, { b: 2 }], 'jsonl')).toBe('{"a":1}\n{"b":2}');
  });
  it('falls back to pretty for non-array jsonl', () => {
    expect(renderJson({ a: 1 }, 'jsonl')).toContain('"a": 1');
  });
});

describe('renderTable / renderRecord', () => {
  const plain = new Style(false);
  it('aligns columns', () => {
    const out = renderTable(
      ['A', 'BB'],
      [
        ['x', 'yyy'],
        ['zz', 'w'],
      ],
      plain,
    );
    expect(out.split('\n')[0]).toContain('A');
    expect(out).toContain('zz');
  });
  it('renders aligned key/value records', () => {
    const out = renderRecord(
      [
        ['key', 'value'],
        ['k', 'v'],
      ],
      plain,
    );
    expect(out).toContain('key:');
    expect(out).toContain('value');
  });
});

describe('Style', () => {
  it('adds ANSI codes when enabled, none when disabled', () => {
    expect(new Style(true).cyan('x')).toContain('[');
    expect(new Style(false).cyan('x')).toBe('x');
  });
});

describe('docHandle / truncate', () => {
  it('formats a doc handle', () => {
    expect(docHandle('d_1', new Style(false))).toBe('[doc:d_1]');
  });
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('ab', 4)).toBe('ab');
  });
});
