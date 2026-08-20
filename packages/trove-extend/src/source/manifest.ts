/**
 * Source manifest validation — the rules that decide whether a `manifest.json`
 * describes a source Trove can actually run.
 *
 * A manifest is a promise made to a scheduler that will call your `sync(ctx)`
 * unattended, on somebody else's machine or in Trove's cloud, for months. Every
 * rule here exists because breaking it fails *later* — at a user's first sync,
 * on a schedule, with nobody watching — rather than at your desk. So the whole
 * set runs in one call, {@link validateSourceManifest}, and every message names
 * the field it is about and what was expected instead.
 *
 * What gets checked:
 *
 * 1. **Shape** — required fields (`id`, `name`, `version`), the `id` pattern
 *    (`^[a-z0-9-]+$`), semver `version`, and well-formedness of `config`.
 * 2. **Credential lint** — a source's `config` holds **user preferences only,
 *    never credentials**. Trove rejects writes whose config contains
 *    credential-shaped keys, so the SDK lints the manifest locally to catch the
 *    mistake before deploy. Auth material is declared separately and resolved
 *    through `ctx.secret()`; it never travels in `config`.
 * 3. **The type system** — the four fields that describe a source's collection
 *    contract ({@link SOURCE_TYPE_FIELDS}), each checked against its vocabulary
 *    and, for a source that has code, against the subset built today
 *    ({@link MVP}).
 * 4. **Where it runs** — `location`, plus the cloud-eligibility predicate that
 *    a cloud source has to satisfy ({@link RUNS_IN}).
 * 5. **The optional declarations** — `schedule`, `fanOut`, `formatting`, and
 *    the per-field `directory` descriptors.
 *
 * @module
 */

import { checkEgress } from './egress-rules.js';
import {
  checkConfigBlock,
  checkFanOut,
  checkFormatting,
  checkHistoryReach,
  checkLocation,
  checkSchedule,
  checkTypeFields,
  isRecord,
  requireString,
} from './manifest-rules.js';
import { MVP } from './taxonomy.js';

/**
 * Credential-shaped key patterns that may NOT appear in a source's `config`.
 * Mirrors the deny-list Trove enforces server-side, so a config the SDK accepts
 * is one the platform will accept. Matched case-insensitively and
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

// ---------------------------------------------------------------------------
// The vocabulary
//
// Four orthogonal manifest fields describe a source's collection contract:
// `kind` (which entrypoint the harness calls), `transport` (how it reaches the
// data), `cursor` (how it resumes), and `ingest` (what ingest
// does with what it returns). Every value each may take is declared here, so
// the design is whole and forward-compatible — a source that is still a stub
// may name a value that is not built yet, to record where its shape is headed.
// Only the {@link MVP} subsets are enforced for a source that has code.
// ---------------------------------------------------------------------------

/**
 * Normalize a config key for credential-pattern matching: lowercase and strip
 * `_`/`-` separators so `api_key`, `apiKey`, and `api-key` collapse to one form.
 * Identical to the normalization Trove applies server-side, so the two verdicts
 * cannot disagree.
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
 * Whether a value is a plain JSON object — the shape every nested manifest
 * block (`config`, a field descriptor, a `directory`) has to be before any of
 * its keys mean anything.
 *
 * @param value - The candidate value.
 * @returns True for a non-null, non-array object.
 */
/**
 * Whether a single config key looks like a credential and must be rejected.
 * Exposed on its own so an authoring tool can warn on the field the moment it
 * is typed, instead of only when the whole manifest is validated.
 *
 * @param key - The config key to test.
 * @returns True if the key matches a credential pattern.
 */
export function isCredentialConfigKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return NORMALIZED_CREDENTIAL_PATTERNS.some((pattern) => normalized.includes(pattern));
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
 * How strictly to read a manifest, and what the caller knows that the manifest
 * cannot say for itself.
 */
export interface ManifestValidationOptions {
  /**
   * Whether the source has code.
   *
   * Passing this at all means the manifest is being **admitted to a catalog**,
   * where a source that has not declared its `kind`, `transport`, `cursor`,
   * `ingest` and `location` is incomplete — so those five become
   * required. Omitting it is authoring mode: whatever is declared is checked,
   * and what has not been written yet is not an error, so validation stays
   * useful while a source is being built.
   *
   * The value itself decides whether the {@link MVP} cut binds: `true` holds
   * the source to what runs today, `false` lets a stub name a reserved value to
   * record where it is headed.
   */
  implemented?: boolean;
  /**
   * Whether a directory provider of the given name exists.
   *
   * Only a catalog knows which providers it ships, so it supplies the resolver;
   * the default accepts any non-empty name, which is the right answer for an
   * author validating a manifest on their own machine.
   */
  directoryProviderExists?: (provider: string) => boolean;
}

/** The default provider resolver: accept any name the manifest offers. */
function anyProvider(): boolean {
  return true;
}

/**
 * Validate a source `manifest.json` in full — shape, credential lint, the four
 * type-system fields, `location` and its cloud-eligibility predicate, and the
 * optional `schedule`, `fanOut`, `formatting` and `directory` declarations.
 *
 * Returns every problem it finds rather than throwing on the first, so a tool
 * can print the whole list and an author fixes the manifest once.
 *
 * @param manifest - The parsed manifest object to validate.
 * @param options - What the caller knows that the manifest cannot say — whether
 *   the source has code (which also switches on catalog-strength requiredness)
 *   and which directory providers exist. Omit while authoring.
 * @returns `{ valid, errors }` — `valid: true` with an empty `errors` array on success.
 */
export function validateSourceManifest(
  manifest: unknown,
  options: ManifestValidationOptions = {},
): ManifestValidationResult {
  const errors: string[] = [];

  if (!isRecord(manifest)) {
    return { valid: false, errors: ['manifest must be a JSON object'] };
  }

  const required = options.implemented !== undefined;
  const implemented = options.implemented === true;
  const providerExists = options.directoryProviderExists ?? anyProvider;

  requireString(manifest.id, 'id', errors);
  if (typeof manifest.id === 'string' && manifest.id.length > 0 && !ID_RE.test(manifest.id)) {
    errors.push('manifest.id must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)');
  }

  requireString(manifest.name, 'name', errors);

  requireString(manifest.version, 'version', errors);
  if (
    typeof manifest.version === 'string' &&
    manifest.version.length > 0 &&
    !SEMVER_RE.test(manifest.version)
  ) {
    errors.push('manifest.version must be a semver string (e.g. "1.0.0")');
  }

  if (manifest.config !== undefined) {
    if (!isRecord(manifest.config)) {
      errors.push('manifest.config must be an object');
    } else {
      checkConfigBlock(manifest.config, providerExists, errors);
    }
  }

  if (manifest.needsBrowser !== undefined && typeof manifest.needsBrowser !== 'boolean') {
    errors.push('manifest.needsBrowser must be a boolean');
  }

  checkTypeFields(manifest, required, implemented, errors);
  checkLocation(manifest, required, errors);
  checkSchedule(manifest, errors);
  checkEgress(manifest, required, errors);
  checkFanOut(manifest, errors);
  checkHistoryReach(manifest, errors);
  checkFormatting(manifest, errors);

  return { valid: errors.length === 0, errors };
}

export {
  CLOUD_ELIGIBLE_TRANSPORTS,
  CURSOR_STRATEGIES,
  type CursorStrategy,
  DIRECTORY_AUTH_STRATEGIES,
  DIRECTORY_MODES,
  type DirectoryAuthStrategy,
  type DirectoryMode,
  FAN_OUT_FIELD_TYPES,
  type FanOutFieldType,
  FORMATTING,
  type FormattingPolicy,
  HISTORY_REACH_KINDS,
  type HistoryReachKind,
  INGEST_MODES,
  type IngestMode,
  MVP,
  MVP_DEPLOYED_CURSORS,
  RUNS_IN,
  type RunsIn,
  SOURCE_KINDS,
  SOURCE_TYPE_FIELDS,
  type SourceKind,
  type SourceSchedule,
  type SourceTransport,
  TRANSPORTS,
  VALID_SCHEDULES,
} from './taxonomy.js';
