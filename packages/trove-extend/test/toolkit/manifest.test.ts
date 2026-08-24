import { describe, expect, it } from 'vitest';
import { defineToolkit, toToolkitManifest } from '../../src/toolkit/define.js';
import { z } from '../../src/toolkit/index.js';
import type { ToolkitConfig } from '../../src/toolkit/types.js';
import { TOOLKIT_META } from './meta.js';

/** One trivial tool, so the config is complete enough to compile. */
const TOOLS: ToolkitConfig['tools'] = [
  {
    name: 'ping',
    description: 'Ping.',
    input: z.object({}),
    handler: async () => ({ text: 'pong' }),
  },
];

/** A complete toolkit declaration, with overrides for the case under test. */
function config(overrides: Partial<ToolkitConfig> = {}): ToolkitConfig {
  return { ...TOOLKIT_META, tools: TOOLS, ...overrides };
}

describe('defineToolkit — the toolkit declares itself', () => {
  it('accepts a complete declaration', () => {
    expect(() => defineToolkit(config())).not.toThrow();
  });

  it('rejects an id that is not a slug', () => {
    expect(() => defineToolkit(config({ id: 'Not A Slug' }))).toThrow(/must match/);
  });

  it('rejects a missing name, description, icon or version', () => {
    for (const field of ['name', 'description', 'icon', 'version'] as const) {
      expect(() => defineToolkit(config({ [field]: '' }))).toThrow(new RegExp(field));
    }
  });

  it('rejects a version that is not semver', () => {
    expect(() => defineToolkit(config({ version: 'v1' }))).toThrow(/semver/);
  });

  it('rejects an unknown visibility', () => {
    expect(() => defineToolkit(config({ visibility: 'secret' as never }))).toThrow(/visibility/);
  });

  it('spells the shared value the way the schema stores it', () => {
    // `shared`, not `public`. The value is persisted as the GraphQL
    // `McpServerVisibility` enum, whose members are PRIVATE and SHARED, and
    // nothing translated between the two spellings — so the field went out to
    // three places under two names and could not be checked end to end.
    expect(() => defineToolkit(config({ visibility: 'shared' }))).not.toThrow();
    expect(() => defineToolkit(config({ visibility: 'public' as never }))).toThrow(
      /must be "shared" or "private"/,
    );
  });

  it('rejects a secret that looks like a value rather than a name', () => {
    // A manifest is committed. A secret in it is a secret in the repo, so the
    // field takes NAMES and the shape is the only thing standing between the
    // two.
    expect(() => defineToolkit(config({ secrets: ['sk-live-abc123'] }))).toThrow(/must be a NAME/);
  });

  it('rejects an egress entry that is not a bare host', () => {
    expect(() => defineToolkit(config({ egress: ['https://example.com'] }))).toThrow(
      /bare hostname/,
    );
  });

  it('accepts a host:port, which a toolkit may legitimately need', () => {
    expect(() => defineToolkit(config({ egress: ['example.com:8443'] }))).not.toThrow();
  });

  it('reports every problem at once, not just the first', () => {
    let message = '';
    try {
      defineToolkit(config({ id: 'Bad Id', version: 'v1' }));
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/must match/);
    expect(message).toMatch(/semver/);
  });

  it('names the toolkit in the error', () => {
    expect(() => defineToolkit(config({ id: 'x', version: 'v1' }))).toThrow(/^defineToolkit: x /m);
  });
});

describe('toToolkitManifest', () => {
  it('keeps the declaration and drops the implementation', () => {
    const manifest = toToolkitManifest(
      config({ secrets: ['API_KEY'], egress: ['example.com'], visibility: 'private' }),
    );
    expect(manifest.tools).toBeUndefined();
    expect(manifest.auth).toBeUndefined();
    expect(manifest.generated).toBe(true);
    expect(manifest.id).toBe('example-toolkit');
    expect(manifest.secrets).toEqual(['API_KEY']);
    expect(manifest.egress).toEqual(['example.com']);
    expect(manifest.visibility).toBe('private');
  });

  it('travels on the compiled server, so a catalog can check its committed copy', () => {
    // Until this existed, `toToolkitManifest` had no way to be called on a
    // real toolkit: `defineToolkit` returned only `tools` and `handle`, so the
    // declaration was unreachable the moment the module finished loading.
    // `defineSource` returns the source object itself, which is why sources
    // had a contract test pinning manifest to code and toolkits did not.
    //
    // It is not cosmetic. Deploy reads `egress`, `scopes` and `secrets` off
    // the committed file, so a manifest that drifts from the code ships the
    // permissions the code no longer asks for.
    const declaration = config({ secrets: ['API_KEY'], egress: ['example.com'] });
    const definition = defineToolkit(declaration);

    expect(definition.manifest).toEqual(toToolkitManifest(declaration));
    expect(definition.manifest).not.toHaveProperty('tools');
    expect(definition.manifest).not.toHaveProperty('auth');
    expect(definition.manifest.generated).toBe(true);
    expect(definition.manifest.egress).toEqual(['example.com']);
  });
});
