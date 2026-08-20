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
});
