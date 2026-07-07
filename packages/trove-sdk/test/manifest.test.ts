import { describe, expect, it } from 'vitest';
import { isCredentialConfigKey, validateSourceManifest } from '../src/manifest.js';

/** A clean, minimal manifest fixture. */
function clean(): Record<string, unknown> {
  return {
    id: 'hacker-news',
    name: 'Hacker News Upvotes',
    description: 'Index stories you upvoted on HN.',
    icon: '🔶',
    version: '1.0.0',
    author: 'matt',
    category: 'reading',
    schedule: 'every 6 hours',
    config: {
      username: { label: 'HN Username', type: 'text', placeholder: 'pg' },
    },
    needs_browser: false,
    kind: 'feed',
    transport: 'http',
    document_semantics: 'bookmark',
  };
}

describe('validateSourceManifest — accepts clean manifests', () => {
  it('accepts a full manifest', () => {
    const result = validateSourceManifest(clean());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a minimal manifest', () => {
    const result = validateSourceManifest({
      id: 'my-blog',
      name: 'My Blog',
      version: '1.0.0',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a live-only manifest with schedule: null', () => {
    const m = clean();
    m.schedule = null;
    expect(validateSourceManifest(m).valid).toBe(true);
  });

  it('accepts a pre-release semver', () => {
    const m = clean();
    m.version = '2.1.0-beta.1';
    expect(validateSourceManifest(m).valid).toBe(true);
  });
});

describe('validateSourceManifest — rejects credential-shaped config keys', () => {
  it('rejects a config key named api_key', () => {
    const m = clean();
    m.config = { api_key: { label: 'API key' } };
    const result = validateSourceManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/credential-shaped key\(s\): api_key/);
  });

  it('rejects camelCase and compound credential keys', () => {
    const m = clean();
    m.config = {
      accessToken: { label: 'token' },
      sessionCookie: { label: 'cookie' },
      feedUrl: { label: 'ok' },
    };
    const result = validateSourceManifest(m);
    expect(result.valid).toBe(false);
    // Only the credential keys are flagged, not feedUrl.
    expect(result.errors.join('\n')).toMatch(/accessToken/);
    expect(result.errors.join('\n')).toMatch(/sessionCookie/);
    expect(result.errors.join('\n')).not.toMatch(/feedUrl/);
  });
});

describe('validateSourceManifest — shape errors', () => {
  it('rejects a non-object manifest', () => {
    expect(validateSourceManifest(null).errors).toEqual(['manifest must be a JSON object']);
    expect(validateSourceManifest([]).valid).toBe(false);
    expect(validateSourceManifest('x').valid).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = validateSourceManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/manifest.id is required/);
    expect(result.errors.join('\n')).toMatch(/manifest.name is required/);
    expect(result.errors.join('\n')).toMatch(/manifest.version is required/);
  });

  it('rejects a bad id pattern', () => {
    const m = clean();
    m.id = 'Bad ID!';
    expect(validateSourceManifest(m).errors.join('\n')).toMatch(/\^\[a-z0-9-\]\+\$/);
  });

  it('rejects a non-semver version', () => {
    const m = clean();
    m.version = 'v1';
    expect(validateSourceManifest(m).errors.join('\n')).toMatch(/must be a semver/);
  });

  it('rejects a non-object config', () => {
    const m = clean();
    m.config = 'nope';
    expect(validateSourceManifest(m).errors.join('\n')).toMatch(
      /manifest.config must be an object/,
    );
  });

  it('rejects a config field that is not a descriptor object', () => {
    const m = clean();
    m.config = { username: 'just-a-string' };
    expect(validateSourceManifest(m).errors.join('\n')).toMatch(
      /must be a field descriptor object/,
    );
  });

  it('rejects a non-boolean needs_browser', () => {
    const m = clean();
    m.needs_browser = 'yes';
    expect(validateSourceManifest(m).errors.join('\n')).toMatch(/needs_browser must be a boolean/);
  });
});

describe('isCredentialConfigKey', () => {
  it('flags credential-shaped keys, separator/case-insensitively', () => {
    for (const key of [
      'token',
      'API_KEY',
      'apiKey',
      'access-token',
      'refreshToken',
      'cookie',
      'password',
      'secret',
      'bearer',
    ]) {
      expect(isCredentialConfigKey(key)).toBe(true);
    }
  });

  it('allows ordinary preference keys', () => {
    for (const key of ['username', 'feedUrl', 'feeds', 'sections', 'limit']) {
      expect(isCredentialConfigKey(key)).toBe(false);
    }
  });
});
