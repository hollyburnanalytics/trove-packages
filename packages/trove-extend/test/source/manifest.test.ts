import { describe, expect, it } from 'vitest';
import {
  CLOUD_ELIGIBLE_TRANSPORTS,
  CURSOR_STRATEGIES,
  DIRECTORY_MODES,
  FAN_OUT_FIELD_TYPES,
  FORMATTING,
  INGEST_MODES,
  isCredentialConfigKey,
  MVP,
  RUNS_IN,
  SOURCE_KINDS,
  SOURCE_TYPE_FIELDS,
  TRANSPORTS,
  VALID_SCHEDULES,
  validateSourceManifest,
} from '../../src/source/manifest.js';

/** A clean, fully-declared manifest fixture — what a shipping source looks like. */
function clean(): Record<string, unknown> {
  return {
    id: 'hacker-news',
    name: 'Hacker News Upvotes',
    description: 'Index stories you upvoted on HN.',
    icon: '🔶',
    version: '1.0.0',
    author: 'matt',
    schedule: 'every 6 hours',
    kind: 'scheduled-sync',
    transport: 'api',
    cursor: 'date',
    ingest: 'append',
    runsIn: 'cloud',
    config: {
      username: { label: 'HN Username', type: 'text', placeholder: 'pg' },
    },
    needsBrowser: false,
  };
}

/** Every error, joined, for substring assertions. */
function errorsOf(manifest: unknown, options?: { implemented?: boolean }): string {
  return validateSourceManifest(manifest, options).errors.join('\n');
}

describe('validateSourceManifest — accepts clean manifests', () => {
  it('accepts a full manifest', () => {
    expect(validateSourceManifest(clean())).toEqual({ valid: true, errors: [] });
  });

  it('accepts a full manifest as an implemented catalog entry', () => {
    expect(validateSourceManifest(clean(), { implemented: true })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts a minimal manifest while authoring', () => {
    const result = validateSourceManifest({ id: 'my-blog', name: 'My Blog', version: '1.0.0' });
    expect(result.valid).toBe(true);
  });

  it('accepts a live-only manifest with schedule: null', () => {
    const m = clean();
    m.schedule = null;
    m.runsIn = 'mac';
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
    expect(errorsOf(m)).toMatch(/\^\[a-z0-9-\]\+\$/);
  });

  it('rejects a non-semver version', () => {
    const m = clean();
    m.version = 'v1';
    expect(errorsOf(m)).toMatch(/must be a semver/);
  });

  it('rejects a non-object config', () => {
    const m = clean();
    m.config = 'nope';
    expect(errorsOf(m)).toMatch(/manifest.config must be an object/);
  });

  it('rejects a config field that is not a descriptor object', () => {
    const m = clean();
    m.config = { username: 'just-a-string' };
    expect(errorsOf(m)).toMatch(/manifest.config.username must be a field descriptor object/);
  });

  it('rejects a non-boolean needsBrowser', () => {
    const m = clean();
    m.needsBrowser = 'yes';
    expect(errorsOf(m)).toMatch(/needsBrowser must be a boolean/);
  });
});

describe('validateSourceManifest — the type-system fields', () => {
  it('names the field and the whole vocabulary on an unknown value', () => {
    const m = clean();
    m.transport = 'http';
    const message = errorsOf(m);
    expect(message).toMatch(/manifest.transport "http" is not a known transport/);
    for (const value of TRANSPORTS) expect(message).toContain(value);
  });

  it('rejects an unknown kind, cursor and ingest', () => {
    const m = clean();
    m.kind = 'feed';
    m.cursor = 'whenever';
    m.ingest = 'text';
    const message = errorsOf(m);
    expect(message).toMatch(/manifest.kind "feed" is not a known execution kind/);
    expect(message).toMatch(/manifest.cursor "whenever" is not a known cursor strategy/);
    expect(message).toMatch(/manifest.ingest "text" is not a known ingest behaviour/);
  });

  it('reports a non-string value as it appeared in the JSON', () => {
    const m = clean();
    m.kind = 3;
    expect(errorsOf(m)).toMatch(/manifest.kind 3 is not a known execution kind/);
  });

  it('lets a stub declare a reserved value it has not built yet', () => {
    const m = clean();
    m.cursor = 'opaqueToken';
    m.ingest = 'upsert';
    expect(validateSourceManifest(m, { implemented: false }).valid).toBe(true);
  });

  it('holds a source with code to the values that run today', () => {
    const m = clean();
    m.cursor = 'opaqueToken';
    const message = errorsOf(m, { implemented: true });
    expect(message).toMatch(
      /manifest.cursor "opaqueToken" is a reserved cursor strategy that nothing runs yet/,
    );
    for (const value of MVP.cursors) expect(message).toContain(value);
  });

  it('requires all four declarations plus location for a catalog entry', () => {
    const message = errorsOf({ id: 'x', name: 'X', version: '1.0.0' }, { implemented: false });
    for (const field of Object.keys(SOURCE_TYPE_FIELDS)) {
      expect(message).toContain(`manifest.${field} is required`);
    }
    expect(message).toContain('manifest.runsIn is required');
  });

  it('does not require them while authoring', () => {
    expect(validateSourceManifest({ id: 'x', name: 'X', version: '1.0.0' }).valid).toBe(true);
  });

  it('flags the former snake_case name so it is not silently ignored', () => {
    const m = clean();
    m.document_semantics = 'append';
    expect(errorsOf(m)).toMatch(
      /manifest.document_semantics is the former name of manifest.ingest/,
    );
  });
});

describe('validateSourceManifest — runsIn and cloud eligibility', () => {
  it('rejects an unknown runsIn', () => {
    const m = clean();
    m.runsIn = 'edge';
    expect(errorsOf(m)).toMatch(/manifest.runsIn "edge" is not a known place to run/);
  });

  it('rejects a cloud source whose transport cannot run there', () => {
    const cloudEligible: readonly string[] = CLOUD_ELIGIBLE_TRANSPORTS;
    for (const transport of TRANSPORTS.filter((t) => !cloudEligible.includes(t))) {
      const m = clean();
      m.transport = transport;
      expect(errorsOf(m)).toMatch(
        /manifest.runsIn "cloud" requires manifest.transport to be one of/,
      );
    }
  });

  it('accepts every cloud-eligible transport in the cloud', () => {
    for (const transport of CLOUD_ELIGIBLE_TRANSPORTS) {
      const m = clean();
      m.transport = transport;
      expect(validateSourceManifest(m).valid).toBe(true);
    }
  });

  it('rejects a cloud source that needs a browser', () => {
    const m = clean();
    m.needsBrowser = true;
    expect(errorsOf(m)).toMatch(/incompatible with manifest.needsBrowser: true/);
  });

  it('rejects a cloud source scheduled on demand', () => {
    const m = clean();
    m.schedule = 'on demand';
    expect(errorsOf(m)).toMatch(/incompatible with manifest.schedule "on demand"/);
  });

  it('lets a Mac run anything', () => {
    const m = clean();
    m.runsIn = 'mac';
    m.transport = 'browser';
    m.needsBrowser = true;
    m.schedule = 'on demand';
    expect(validateSourceManifest(m).valid).toBe(true);
  });
});

describe('validateSourceManifest — schedule', () => {
  it('accepts every documented cadence', () => {
    for (const schedule of VALID_SCHEDULES) {
      const m = clean();
      m.runsIn = 'mac';
      m.schedule = schedule;
      expect(validateSourceManifest(m).valid).toBe(true);
    }
  });

  it('rejects a cadence the scheduler cannot map', () => {
    const m = clean();
    m.schedule = 'hourly';
    const message = errorsOf(m);
    expect(message).toMatch(/manifest.schedule "hourly" is not a recognised cadence/);
    expect(message).toContain('every 1 hour');
  });
});

describe('validateSourceManifest — fanOut', () => {
  it('accepts a fanOut naming a list field', () => {
    for (const type of FAN_OUT_FIELD_TYPES) {
      const m = clean();
      m.config = { feeds: { label: 'Feeds', type } };
      m.fanOut = 'feeds';
      expect(validateSourceManifest(m).valid).toBe(true);
    }
  });

  it('rejects a fanOut that is not a string', () => {
    const m = clean();
    m.fanOut = ['feeds'];
    expect(errorsOf(m)).toMatch(/manifest.fanOut \["feeds"\] must be a non-empty string/);
  });

  it('rejects a fanOut naming a field that does not exist', () => {
    const m = clean();
    m.fanOut = 'feeds';
    expect(errorsOf(m)).toMatch(/manifest.fanOut "feeds" does not name a field in manifest.config/);
  });

  it('rejects a fanOut naming a scalar field', () => {
    const m = clean();
    m.config = { feedUrl: { label: 'Feed URL', type: 'url' } };
    m.fanOut = 'feedUrl';
    expect(errorsOf(m)).toMatch(/manifest.config.feedUrl.type is "url"/);
  });
});

describe('validateSourceManifest — formatting', () => {
  it('accepts both policies and treats absence as valid', () => {
    for (const formatting of FORMATTING) {
      const m = clean();
      m.formatting = formatting;
      expect(validateSourceManifest(m).valid).toBe(true);
    }
    expect(validateSourceManifest(clean()).valid).toBe(true);
  });

  it('rejects an unknown policy', () => {
    const m = clean();
    m.formatting = 'pretty';
    expect(errorsOf(m)).toMatch(/manifest.formatting "pretty" is not a known formatting policy/);
  });
});

describe('validateSourceManifest — directory descriptors', () => {
  /** A manifest whose one config field is backed by a directory. */
  function withDirectory(directory: unknown): Record<string, unknown> {
    const m = clean();
    m.config = { feeds: { label: 'Feeds', type: 'url[]', directory } };
    return m;
  }

  it('accepts a well-formed directory', () => {
    const m = withDirectory({ provider: 'feeds', mode: 'resolve', placeholder: 'Paste a URL' });
    expect(validateSourceManifest(m).valid).toBe(true);
  });

  it('accepts every mode a client can render', () => {
    for (const mode of DIRECTORY_MODES) {
      expect(validateSourceManifest(withDirectory({ provider: 'feeds', mode })).valid).toBe(true);
    }
  });

  it('rejects a directory that is not an object', () => {
    expect(errorsOf(withDirectory('feeds'))).toMatch(
      /manifest.config.feeds.directory must be an object/,
    );
  });

  it('rejects a missing or empty provider', () => {
    expect(errorsOf(withDirectory({ mode: 'search' }))).toMatch(
      /manifest.config.feeds.directory.provider must be a non-empty string/,
    );
    expect(errorsOf(withDirectory({ provider: '', mode: 'search' }))).toMatch(
      /directory.provider must be a non-empty string/,
    );
  });

  it('rejects a mode no client can render', () => {
    expect(errorsOf(withDirectory({ provider: 'feeds', mode: 'browse' }))).toMatch(
      /manifest.config.feeds.directory.mode must be one of: search, resolve \(got "browse"\)/,
    );
  });

  it('resolves the provider against the catalog when one is supplied', () => {
    const m = withDirectory({ provider: 'feds', mode: 'search' });
    const result = validateSourceManifest(m, {
      directoryProviderExists: (name) => name === 'feeds',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(
      /directory.provider "feds" is not a directory provider this catalog knows/,
    );
  });

  it('accepts any provider name when the caller cannot resolve them', () => {
    expect(validateSourceManifest(withDirectory({ provider: 'feds', mode: 'search' })).valid).toBe(
      true,
    );
  });
});

describe('validateSourceManifest — reports every problem at once', () => {
  it('collects independent errors rather than stopping at the first', () => {
    const result = validateSourceManifest(
      {
        id: 'Bad ID',
        name: 'X',
        version: 'v1',
        kind: 'feed',
        transport: 'browser',
        cursor: 'date',
        ingest: 'append',
        runsIn: 'cloud',
        schedule: 'hourly',
        formatting: 'pretty',
      },
      { implemented: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(6);
  });
});

describe('the exported vocabulary', () => {
  it('keeps the MVP cut a subset of each full vocabulary', () => {
    for (const value of MVP.kinds) expect(SOURCE_KINDS).toContain(value);
    for (const value of MVP.transports) expect(TRANSPORTS).toContain(value);
    for (const value of MVP.cursors) expect(CURSOR_STRATEGIES).toContain(value);
    for (const value of MVP.ingest) expect(INGEST_MODES).toContain(value);
  });

  it('keeps the cloud-eligible transports a subset of the transports', () => {
    for (const value of CLOUD_ELIGIBLE_TRANSPORTS) expect(TRANSPORTS).toContain(value);
  });

  it('exposes the four type-system fields with their vocabularies', () => {
    expect(Object.keys(SOURCE_TYPE_FIELDS)).toEqual(['kind', 'transport', 'cursor', 'ingest']);
    expect(SOURCE_TYPE_FIELDS.kind).toBe(SOURCE_KINDS);
    expect(SOURCE_TYPE_FIELDS.transport).toBe(TRANSPORTS);
    expect(SOURCE_TYPE_FIELDS.cursor).toBe(CURSOR_STRATEGIES);
    expect(SOURCE_TYPE_FIELDS.ingest).toBe(INGEST_MODES);
  });

  it('offers exactly two places to run, since the eligibility rule is one-way', () => {
    expect([...RUNS_IN]).toEqual(['cloud', 'mac']);
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

describe('the cut a deployed source is held to', () => {
  /** A manifest that is valid but for what a case changes. */
  const base = {
    id: 'x',
    name: 'X',
    version: '1.0.0',
    kind: 'scheduled-sync',
    transport: 'api',
    ingest: 'append',
    runsIn: 'cloud',
    schedule: 'daily',
  };

  it('lets a deployed source resume from a high-water id', () => {
    // Its cursor is handed back byte-for-byte, so the shape works — and one
    // shipped source has been using it, declaring a value in no vocabulary
    // because the cut had no way to say "deployed only".
    const result = validateSourceManifest(
      { ...base, cursor: 'highWaterId', runtime: 'deployed' },
      { implemented: true },
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('refuses the same strategy on the bundled runtime, and says why', () => {
    // The bundled runtime PARSES the cursor, and a shape the union does not
    // name parses to nothing: the source would start from the beginning every
    // run, silently. The message has to carry that, because "reserved" alone
    // reads as "coming soon" rather than "this would break".
    const result = validateSourceManifest(
      { ...base, cursor: 'highWaterId' },
      { implemented: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/bundled runtime, which PARSES the cursor/);
    expect(result.errors[0]).toMatch(/runtime.*deployed/);
  });

  it('still refuses a value from no vocabulary at all', () => {
    const result = validateSourceManifest(
      { ...base, cursor: 'id', runtime: 'deployed' },
      { implemented: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/is not a known cursor strategy/);
  });
});
