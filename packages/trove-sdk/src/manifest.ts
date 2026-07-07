/**
 * Source manifest validation for `trove source validate`
 * (see the sources manifest reference).
 *
 * Two checks live here:
 *
 * 1. **Shape validation** — required fields (`id`, `name`, `version`), the
 *    `id` pattern (`^[a-z0-9-]+$`), and well-formedness of `config`.
 * 2. **Credential-key lint** — the same spirit as the server-side
 *    `validateConfig` (`src/graphql/validate-config.ts`, invariant #6): a
 *    source's `config` holds **user preferences only, never credentials**.
 *    The cloud rejects writes whose config contains credential-shaped keys, so
 *    the SDK lints the manifest locally to catch the mistake before deploy. Auth
 *    material belongs in the (PROPOSED) `auth` block — surfaced from the macOS
 *    Keychain — not in `config`.
 *
 * The deny-list below is kept deliberately identical in spirit to the
 * authoritative cloud list so the two cannot meaningfully drift.
 *
 * @module
 */

import type { ManifestConfigField, SourceManifest } from './types.js';

/**
 * Credential-shaped key patterns that may NOT appear in a source's `config`
 * (invariant #6). Mirrors the authoritative cloud deny-list in
 * `src/graphql/validate-config.ts`. Matched case-insensitively and
 * separator-insensitively as substrings, so `apiKey`, `api_key`, `access_token`,
 * and `refreshToken` all match.
 */
const CREDENTIAL_KEY_PATTERNS: readonly string[] = [
  'session',
  'cookie',
  'token',
  'api_key',
  'apikey',
  'password',
  'secret',
  'auth',
  'credential',
  'bearer',
  'access_key',
  'private_key',
];

/** The `id` pattern: lowercase letters, digits, and hyphens. */
const ID_RE = /^[a-z0-9-]+$/;

/** A permissive semver check — `MAJOR.MINOR.PATCH` with optional pre-release/build. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * Normalize a config key for credential-pattern matching: lowercase and strip
 * `_`/`-` separators so `api_key`, `apiKey`, and `api-key` collapse to one form.
 * Identical to the cloud's `normalizeKey`.
 *
 * @param key - The config key to normalize.
 * @returns The normalized comparable form.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

/** Pre-normalized credential patterns, computed once. */
const NORMALIZED_CREDENTIAL_PATTERNS: readonly string[] = CREDENTIAL_KEY_PATTERNS.map(normalizeKey);

/**
 * Whether a single config key looks like a credential and must be rejected.
 * Mirrors the cloud's `isSensitiveConfigKey`.
 *
 * @param key - The config key to test.
 * @returns True if the key matches a credential pattern.
 */
export function isCredentialConfigKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return NORMALIZED_CREDENTIAL_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Push an error if a required string field is missing or empty.
 *
 * @param value - The candidate field value.
 * @param field - The field name, for the message.
 * @param errors - The accumulator to append to.
 */
function requireString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`manifest.${field} is required and must be a non-empty string`);
  }
}

/**
 * Validate the `config` block: each value must be an object descriptor, and no
 * key may be credential-shaped.
 *
 * @param config - The manifest `config` object.
 * @param errors - The accumulator to append to.
 */
function validateConfigBlock(config: Record<string, ManifestConfigField>, errors: string[]): void {
  const offending: string[] = [];
  for (const [key, descriptor] of Object.entries(config)) {
    if (isCredentialConfigKey(key)) offending.push(key);
    if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      errors.push(`manifest.config.${key} must be a field descriptor object`);
    }
  }
  if (offending.length > 0) {
    const unique = [...new Set(offending)];
    errors.push(
      `manifest.config must not contain credential-shaped key(s): ${unique.join(', ')}. ` +
        'Source credentials belong in the macOS Keychain (declared as `auth`), not in `config`.',
    );
  }
}

/**
 * The outcome of {@link validateSourceManifest}.
 */
export interface ManifestValidationResult {
  /** True when no errors were found. */
  valid: boolean;
  /** Human-readable error messages; empty when `valid` is true. */
  errors: string[];
}

/**
 * Validate a source `manifest.json` for `trove source validate`.
 *
 * Checks required fields and the `id`/`version` patterns, validates the `config`
 * descriptors, and runs the credential-key lint (rejecting credential-shaped
 * `config` keys — same spirit as the server-side `validateConfig`). Returns a
 * structured result rather than throwing, so the CLI can print all errors at
 * once.
 *
 * @param manifest - The parsed manifest object to validate.
 * @returns `{ valid, errors }` — `valid: true` with an empty `errors` array on success.
 */
export function validateSourceManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be a JSON object'] };
  }

  const m = manifest as Partial<SourceManifest>;

  requireString(m.id, 'id', errors);
  if (typeof m.id === 'string' && m.id.length > 0 && !ID_RE.test(m.id)) {
    errors.push('manifest.id must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)');
  }

  requireString(m.name, 'name', errors);

  requireString(m.version, 'version', errors);
  if (typeof m.version === 'string' && m.version.length > 0 && !SEMVER_RE.test(m.version)) {
    errors.push('manifest.version must be a semver string (e.g. "1.0.0")');
  }

  if (m.config !== undefined) {
    if (m.config === null || typeof m.config !== 'object' || Array.isArray(m.config)) {
      errors.push('manifest.config must be an object');
    } else {
      validateConfigBlock(m.config, errors);
    }
  }

  if (m.needs_browser !== undefined && typeof m.needs_browser !== 'boolean') {
    errors.push('manifest.needs_browser must be a boolean');
  }

  return { valid: errors.length === 0, errors };
}
