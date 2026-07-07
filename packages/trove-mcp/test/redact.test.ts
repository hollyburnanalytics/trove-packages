import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  const secrets = new Set(['sk-supersecret', 'hunter2']);

  it('redacts secret substrings in strings', () => {
    expect(redactSecrets('token is sk-supersecret here', secrets)).toBe('token is [redacted] here');
  });

  it('redacts inside arrays and nested objects', () => {
    const input = [
      'auth: hunter2',
      { url: 'https://x/?key=sk-supersecret', nested: { v: 'hunter2' } },
    ];
    expect(redactSecrets(input, secrets)).toEqual([
      'auth: [redacted]',
      { url: 'https://x/?key=[redacted]', nested: { v: '[redacted]' } },
    ]);
  });

  it('redacts an Error message/stack to a string', () => {
    const out = redactSecrets(new Error('failed with hunter2'), secrets);
    expect(typeof out).toBe('string');
    expect(out as string).not.toContain('hunter2');
    expect(out as string).toContain('[redacted]');
  });

  it('is a no-op when there are no secrets', () => {
    const input = { a: 'hunter2' };
    expect(redactSecrets(input, new Set())).toBe(input);
  });

  it('does not redact empty-string secrets', () => {
    expect(redactSecrets('anything', new Set(['']))).toBe('anything');
  });

  it('handles cycles without throwing', () => {
    const obj: Record<string, unknown> = { name: 'hunter2' };
    obj.self = obj;
    const out = redactSecrets(obj, secrets) as Record<string, unknown>;
    expect(out.name).toBe('[redacted]');
    expect(out.self).toBe('[circular]');
  });
});
