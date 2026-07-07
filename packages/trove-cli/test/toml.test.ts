import { describe, expect, it } from 'vitest';
import { parseToml, stringifyToml } from '../src/lib/toml.js';

describe('toml', () => {
  it('parses top-level keys and nested profile tables', () => {
    const text = `
default_profile = "prod"

[profiles.prod]
api_url = "https://api.ontrove.sh"
token = "tok_123"
email = "matt@example.com"

[profiles.dev]
api_url = "http://localhost:8787"
`;
    const parsed = parseToml(text);
    expect(parsed.default_profile).toBe('prod');
    const profiles = parsed.profiles as Record<string, Record<string, string>>;
    expect(profiles.prod?.api_url).toBe('https://api.ontrove.sh');
    expect(profiles.prod?.token).toBe('tok_123');
    expect(profiles.dev?.api_url).toBe('http://localhost:8787');
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseToml('# a comment\n\ndefault_profile = "x" # trailing\n');
    expect(parsed.default_profile).toBe('x');
  });

  it('keeps # inside quoted values', () => {
    const parsed = parseToml('key = "a#b"\n');
    expect(parsed.key).toBe('a#b');
  });

  it('round-trips through stringify', () => {
    const original = {
      default_profile: 'prod',
      profiles: {
        prod: { api_url: 'https://api.ontrove.sh', token: 'tok' },
      },
    };
    const text = stringifyToml(original);
    const parsed = parseToml(text);
    expect(parsed).toEqual(original);
  });

  it('escapes quotes and newlines on write', () => {
    const text = stringifyToml({ key: 'a"b\nc' });
    expect(text).toContain('\\"');
    expect(text).toContain('\\n');
    expect(parseToml(text).key).toBe('a"b\nc');
  });

  it('throws on an unparseable line', () => {
    expect(() => parseToml('this is not valid toml\n')).toThrow(/Invalid TOML/);
  });

  it('unquotes a quoted key and keeps a bare value as-is', () => {
    const parsed = parseToml('"my key" = value\n');
    expect(parsed['my key']).toBe('value');
  });

  it('decodes escaped backslashes and newlines in a quoted value', () => {
    const parsed = parseToml('key = "a\\\\b\\nc"\n');
    expect(parsed.key).toBe('a\\b\nc');
  });
});
