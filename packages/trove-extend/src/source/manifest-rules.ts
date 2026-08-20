/**
 * The per-field rules a manifest is checked against.
 *
 * One function per declaration — the type fields, where it runs, its schedule,
 * fan-out, formatting, the directory descriptors — each appending to a shared
 * error list rather than throwing, so a single call can report everything wrong
 * with a manifest instead of the first thing.
 *
 * Split from `manifest.ts` so the entry point reads as the list of checks it
 * runs, and a new declaration is a new function here rather than another branch
 * in a growing one.
 *
 * @module
 */

import { isCredentialConfigKey } from './manifest.js';
import {
  CLOUD_ELIGIBLE_TRANSPORTS,
  CURSOR_STRATEGIES,
  DIRECTORY_MODES,
  FAN_OUT_FIELD_TYPES,
  FORMATTING,
  HISTORY_REACH_KINDS,
  INGEST_MODES,
  MVP,
  MVP_DEPLOYED_CURSORS,
  RUNS_IN,
  SOURCE_KINDS,
  TRANSPORTS,
  VALID_SCHEDULES,
} from './taxonomy.js';

/**
 * One type-system field's rule: its full vocabulary, the subset built today,
 * and the noun used when talking about it in an error message.
 */
interface TypeFieldRule {
  /** The manifest field name. */
  readonly field: 'kind' | 'transport' | 'cursor' | 'ingest';
  /** Every value the field may take. */
  readonly allowed: readonly string[];
  /** The subset a source with code must stay inside. */
  readonly built: readonly string[];
  /** How the field is described in prose, e.g. "execution kind". */
  readonly noun: string;
}

/** The four rules, in the order their errors should read. */
const TYPE_FIELD_RULES: readonly TypeFieldRule[] = [
  { field: 'kind', allowed: SOURCE_KINDS, built: MVP.kinds, noun: 'execution kind' },
  { field: 'transport', allowed: TRANSPORTS, built: MVP.transports, noun: 'transport' },
  {
    field: 'cursor',
    allowed: CURSOR_STRATEGIES,
    built: MVP.cursors,
    noun: 'cursor strategy',
  },
  {
    field: 'ingest',
    allowed: INGEST_MODES,
    built: MVP.ingest,
    noun: 'ingest behaviour',
  },
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a manifest value is a string drawn from a closed vocabulary. Written
 * once so every vocabulary check reads the same and none of them has to widen a
 * literal tuple at the call site.
 *
 * @param allowed - The vocabulary.
 * @param value - The raw manifest value.
 * @returns True when the value is one of `allowed`.
 */
function isOneOf(allowed: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

/**
 * Render a value the way it appeared in the JSON, so an error about a number
 * or a null is not indistinguishable from one about a string.
 *
 * @param value - The offending value.
 * @returns Its JSON rendering, or `undefined` spelled out.
 */
function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * Push an error if a required string field is missing or empty.
 *
 * @param value - The candidate field value.
 * @param field - The field name, for the message.
 * @param errors - The accumulator to append to.
 */
export function requireString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`manifest.${field} is required and must be a non-empty string`);
  }
}

/**
 * Why a value that exists in the vocabulary is still refused for this source.
 *
 * Split out because the two reasons are genuinely different and a reader needs
 * to know which one they hit: a strategy nothing runs anywhere is "come back
 * later", while one that runs on the OTHER runtime is "you are one manifest
 * line from it working".
 *
 * @param refusal - The field, its value, and which runtime the source declares.
 * @returns The message to append.
 */
function reservedValueError(refusal: {
  field: string;
  value: string;
  noun: string;
  built: readonly string[];
  isDeployed: boolean;
}): string {
  const { field, value, noun, built, isDeployed } = refusal;
  const runsWhenDeployed =
    field === 'cursor' &&
    !isDeployed &&
    (MVP_DEPLOYED_CURSORS as readonly string[]).includes(value);
  if (runsWhenDeployed) {
    return (
      `manifest.${field} "${value}" is a reserved ${noun} on the bundled runtime, which PARSES ` +
      `the cursor — a shape it does not name parses to nothing and the source starts from the ` +
      `beginning every run. Use one of: ${built.join(', ')}, or declare "runtime": "deployed", ` +
      'where the cursor is returned unchanged.'
    );
  }
  return (
    `manifest.${field} "${value}" is a reserved ${noun} that nothing runs yet; ` +
    `a source with code must use one of: ${built.join(', ')}`
  );
}

/**
 * Check the four type-system fields against their vocabularies, and — for a
 * source that has code — against the subset built today.
 *
 * @param manifest - The manifest, as a plain record.
 * @param required - Whether a missing declaration is itself an error (true when
 *   the manifest is being admitted to a catalog, false while it is being
 *   written).
 * @param implemented - Whether the source has code, which is what makes the MVP
 *   cut binding.
 * @param errors - The accumulator to append to.
 */
export function checkTypeFields(
  manifest: Record<string, unknown>,
  required: boolean,
  implemented: boolean,
  errors: string[],
): void {
  // A deployed source's cursor is handed back byte-for-byte, so it may resume
  // from a monotonic id; a bundled one's is parsed, and a shape the union does
  // not name parses to nothing. Same field, two answers — see
  // MVP_DEPLOYED_CURSORS.
  const isDeployed = manifest.runtime === 'deployed';
  for (const { field, allowed, built: cut, noun } of TYPE_FIELD_RULES) {
    const built = field === 'cursor' && isDeployed ? MVP_DEPLOYED_CURSORS : cut;
    const value = manifest[field];
    if (value === undefined) {
      if (required) {
        errors.push(`manifest.${field} is required — the ${noun}, one of: ${allowed.join(', ')}`);
      }
      continue;
    }
    if (!isOneOf(allowed, value)) {
      errors.push(
        `manifest.${field} ${show(value)} is not a known ${noun} (expected one of: ${allowed.join(', ')})`,
      );
      continue;
    }
    if (implemented && !built.includes(value)) {
      errors.push(reservedValueError({ field, value, noun, built, isDeployed }));
    }
  }
  if (manifest.document_semantics !== undefined) {
    errors.push(
      `manifest.document_semantics is the former name of manifest.ingest; rename it (one of: ${INGEST_MODES.join(', ')})`,
    );
  }
}

/**
 * Check `runsIn`, and for `cloud` the eligibility predicate that has to hold
 * for a hosted runtime to be able to run the source at all:
 *
 * ```text
 * runsIn: cloud  ⇒  transport ∈ {feed, api, scrape}
 *                  ∧  needs_browser ≠ true
 *                  ∧  schedule ≠ "on demand"
 * ```
 *
 * `client` is always permitted — the user's own machine runs anything. The
 * predicate is checked here rather than at deploy time because a source that
 * declares `cloud` and cannot run there fails on a schedule, in a runtime the
 * author is not watching.
 *
 * @param manifest - The manifest, as a plain record.
 * @param required - Whether a missing `runsIn` is itself an error.
 * @param errors - The accumulator to append to.
 */
export function checkLocation(
  manifest: Record<string, unknown>,
  required: boolean,
  errors: string[],
): void {
  const runsIn = manifest.runsIn;
  if (runsIn === undefined) {
    if (required) {
      errors.push(
        `manifest.runsIn is required — where the source runs by default, one of: ${RUNS_IN.join(', ')}`,
      );
    }
    return;
  }
  if (!isOneOf(RUNS_IN, runsIn)) {
    errors.push(
      `manifest.runsIn ${show(runsIn)} is not a known place to run (expected one of: ${RUNS_IN.join(', ')})`,
    );
    return;
  }
  if (runsIn !== 'cloud') return;

  const transport = manifest.transport;
  if (!isOneOf(CLOUD_ELIGIBLE_TRANSPORTS, transport)) {
    errors.push(
      `manifest.runsIn "cloud" requires manifest.transport to be one of: ${CLOUD_ELIGIBLE_TRANSPORTS.join(', ')} (got ${show(transport)})`,
    );
  }
  if (manifest.needsBrowser === true) {
    errors.push(
      'manifest.runsIn "cloud" is incompatible with manifest.needsBrowser: true — there is no browser in a hosted runtime; use "mac"',
    );
  }
  if (manifest.schedule === 'on demand') {
    errors.push(
      'manifest.runsIn "cloud" is incompatible with manifest.schedule "on demand" — nothing in the cloud triggers an on-demand source; use "mac" or name a cadence',
    );
  }
}

/**
 * Check the optional `schedule`. Absent means the source has no cadence of its
 * own; `null` means it is live-only and never synced on a timer.
 *
 * @param manifest - The manifest, as a plain record.
 * @param errors - The accumulator to append to.
 */
export function checkSchedule(manifest: Record<string, unknown>, errors: string[]): void {
  const schedule = manifest.schedule;
  if (schedule === undefined || schedule === null) return;
  if (!isOneOf(VALID_SCHEDULES, schedule)) {
    errors.push(
      `manifest.schedule ${show(schedule)} is not a recognised cadence (expected one of: ${VALID_SCHEDULES.join(', ')}, or null for a live-only source)`,
    );
  }
}

/**
 * Check the optional `fanOut`. When present it must name a key in `config`
 * whose declared type is a list the runner can explode into one feed per entry.
 *
 * A `fanOut` pointing at a field that does not exist, or at a scalar, would
 * produce exactly one feed and look like it worked — which is why the reference
 * is resolved here rather than at run time.
 *
 * @param manifest - The manifest, as a plain record.
 * @param errors - The accumulator to append to.
 */
/**
 * `historyReach`, when declared, must be `{ kind, note }` with a known kind.
 *
 * Typed as a bare `string` until 3.3.0 and checked by nothing, while all 24
 * declarations in the catalogs were objects — so the field said one thing to
 * the compiler, another to every author, and nothing to the validator.
 *
 * @param manifest - The manifest to check.
 * @param errors - Collector; appended to in place.
 */
export function checkHistoryReach(manifest: Record<string, unknown>, errors: string[]): void {
  const reach = manifest.historyReach;
  if (reach === undefined) return;
  if (!isRecord(reach)) {
    errors.push(`manifest.historyReach ${show(reach)} must be an object with { kind, note }`);
    return;
  }
  if (!isOneOf(HISTORY_REACH_KINDS, reach.kind)) {
    errors.push(
      `manifest.historyReach.kind ${show(reach.kind)} must be one of: ${HISTORY_REACH_KINDS.join(', ')}`,
    );
  }
  if (typeof reach.note !== 'string' || reach.note.length === 0) {
    errors.push(
      'manifest.historyReach.note must be a non-empty string saying why the bound exists',
    );
  }
}

export function checkFanOut(manifest: Record<string, unknown>, errors: string[]): void {
  const fanOut = manifest.fanOut;
  if (fanOut === undefined) return;
  if (typeof fanOut !== 'string' || fanOut.length === 0) {
    errors.push(
      `manifest.fanOut ${show(fanOut)} must be a non-empty string naming a field in manifest.config`,
    );
    return;
  }
  const config = manifest.config;
  const field = isRecord(config) ? config[fanOut] : undefined;
  if (!isRecord(field)) {
    errors.push(`manifest.fanOut "${fanOut}" does not name a field in manifest.config`);
    return;
  }
  const type = field.type;
  if (!isOneOf(FAN_OUT_FIELD_TYPES, type)) {
    errors.push(
      `manifest.fanOut "${fanOut}" must name a config field whose type is one of: ${FAN_OUT_FIELD_TYPES.join(', ')} (manifest.config.${fanOut}.type is ${show(type)})`,
    );
  }
}

/**
 * Check the optional `formatting`. Absence is valid and means `verbatim`.
 *
 * @param manifest - The manifest, as a plain record.
 * @param errors - The accumulator to append to.
 */
export function checkFormatting(manifest: Record<string, unknown>, errors: string[]): void {
  const formatting = manifest.formatting;
  if (formatting === undefined) return;
  if (!isOneOf(FORMATTING, formatting)) {
    errors.push(
      `manifest.formatting ${show(formatting)} is not a known formatting policy (expected one of: ${FORMATTING.join(', ')}, or omit it for ${FORMATTING[1]})`,
    );
  }
}

/**
 * Check one config field's optional `directory` descriptor — the block that
 * turns a plain input into a picker backed by a lookup service.
 *
 * A directory is a property of a *field*, not of the source, so this is called
 * per field. Both the provider name and the mode are resolved here because a
 * typo that reaches a user surfaces as "no results", which is
 * indistinguishable from a genuinely empty search.
 *
 * @param name - The config field's name, for the message.
 * @param directory - The raw `directory` value.
 * @param providerExists - Whether a directory provider of that name exists.
 *   Only the catalog knows its own providers, so it supplies this; the default
 *   accepts any non-empty name.
 * @param errors - The accumulator to append to.
 */
function checkDirectory(
  name: string,
  directory: unknown,
  providerExists: (provider: string) => boolean,
  errors: string[],
): void {
  if (!isRecord(directory)) {
    errors.push(`manifest.config.${name}.directory must be an object (got ${show(directory)})`);
    return;
  }
  const { provider, mode } = directory;
  if (typeof provider !== 'string' || provider.length === 0) {
    errors.push(
      `manifest.config.${name}.directory.provider must be a non-empty string naming a directory provider (got ${show(provider)})`,
    );
  } else if (!providerExists(provider)) {
    errors.push(
      `manifest.config.${name}.directory.provider "${provider}" is not a directory provider this catalog knows`,
    );
  }
  if (!isOneOf(DIRECTORY_MODES, mode)) {
    errors.push(
      `manifest.config.${name}.directory.mode must be one of: ${DIRECTORY_MODES.join(', ')} (got ${show(mode)})`,
    );
  }
}

/**
 * Walk the `config` block once: every value must be a field descriptor object,
 * no key may be credential-shaped, and any `directory` descriptor must resolve.
 *
 * @param config - The manifest `config` object.
 * @param providerExists - Whether a directory provider of that name exists.
 * @param errors - The accumulator to append to.
 */
export function checkConfigBlock(
  config: Record<string, unknown>,
  providerExists: (provider: string) => boolean,
  errors: string[],
): void {
  const offending: string[] = [];
  for (const [key, descriptor] of Object.entries(config)) {
    if (isCredentialConfigKey(key)) offending.push(key);
    if (!isRecord(descriptor)) {
      errors.push(`manifest.config.${key} must be a field descriptor object`);
      continue;
    }
    if (descriptor.directory !== undefined) {
      checkDirectory(key, descriptor.directory, providerExists, errors);
    }
  }
  if (offending.length > 0) {
    const unique = [...new Set(offending)];
    errors.push(
      `manifest.config must not contain credential-shaped key(s): ${unique.join(', ')}. ` +
        'Source credentials are declared separately and read with ctx.secret(); they never travel in `config`.',
    );
  }
}
