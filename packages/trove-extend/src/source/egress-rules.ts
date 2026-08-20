/**
 * The rules for `egress` — the hosts a source may reach.
 *
 * Its own module because the checks come in three distinct kinds (each entry's
 * shape, the `config:` sentinel, and the notes an unusual list owes a reader),
 * and because `manifest-rules.ts` was already at the length where one more
 * concern makes the file the thing you have to read rather than the rule.
 *
 * These rules lived on the server, in Trove's own manifest reader, so an author
 * met them at DEPLOY — having already written the source.
 *
 * @module
 */

import { isRecord } from './manifest-rules.js';

/**
 * A bare lowercase hostname: no scheme, port, path or wildcard.
 *
 * Host-exact because the allowlist enforced at run time is host-exact. A wildcard
 * the SDK accepts and the platform does not is worse than a rejection — the
 * source deploys and then cannot reach what it declared.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The `config:<field>` sentinel prefix — a host supplied by a user preference. */
const CONFIG_PREFIX = 'config:';

/** Which of the two host lists an entry came from. */
type HostList = 'egress' | 'egressNotFetched';

/**
 * Check one `config:` sentinel.
 *
 * @param entry - The full sentinel, e.g. `config:feedUrl`.
 * @param key - Which list it came from.
 * @param manifest - The manifest being validated.
 * @param errors - Accumulator for human-readable errors.
 */
function checkSentinel(
  entry: string,
  key: HostList,
  manifest: Record<string, unknown>,
  errors: string[],
): void {
  if (key === 'egressNotFetched') {
    errors.push(
      `manifest.egressNotFetched entry '${entry}' must be a hostname — a 'config:' sentinel names hosts the adapter DOES fetch`,
    );
    return;
  }
  const field = entry.slice(CONFIG_PREFIX.length);
  const config = manifest.config;
  if (!isRecord(config) || !(field in config)) {
    errors.push(
      `manifest.egress names 'config:${field}' but the config block has no '${field}' field`,
    );
  }
  if (manifest.runtime === 'deployed') {
    errors.push(
      "manifest.egress cannot use a 'config:' sentinel when runtime is 'deployed' — the allowlist is host-exact and fixed at deploy time",
    );
  }
}

/**
 * Check every entry in one of the two host lists.
 *
 * @param list - The entries.
 * @param key - Which list they came from.
 * @param manifest - The manifest being validated.
 * @param seen - Hosts already claimed, so a duplicate across lists is caught.
 * @param errors - Accumulator for human-readable errors.
 */
function checkEntries(
  list: readonly unknown[],
  key: HostList,
  manifest: Record<string, unknown>,
  seen: Set<string>,
  errors: string[],
): void {
  for (const entry of list) {
    if (typeof entry !== 'string') {
      errors.push(`manifest.${key} contains ${JSON.stringify(entry)}, which is not a string`);
      continue;
    }
    if (entry.startsWith(CONFIG_PREFIX)) {
      checkSentinel(entry, key, manifest, errors);
      continue;
    }
    if (!HOSTNAME.test(entry)) {
      errors.push(
        `manifest.${key} entry '${entry}' is not a bare lowercase hostname (no scheme, port, path or wildcard)`,
      );
      continue;
    }
    if (seen.has(entry)) {
      errors.push(`manifest: '${entry}' is declared twice across egress/egressNotFetched`);
    }
    seen.add(entry);
  }
}

/**
 * Check that an unusual reach is explained.
 *
 * @param egress - The declared hosts.
 * @param notFetched - Hosts that appear but are never fetched.
 * @param manifest - The manifest being validated.
 * @param errors - Accumulator for human-readable errors.
 */
function checkNotes(
  egress: readonly unknown[],
  notFetched: readonly unknown[],
  manifest: Record<string, unknown>,
  errors: string[],
): void {
  const note = typeof manifest.egressNote === 'string' ? manifest.egressNote.trim() : '';
  if (note !== '') return;
  if (egress.length === 0) {
    errors.push('manifest.egress is empty, so manifest.egressNote must say why it reaches nothing');
  }
  if (notFetched.length > 0) {
    errors.push(
      'manifest.egressNotFetched is non-empty, so manifest.egressNote must say where those hosts appear if not in a fetch',
    );
  }
}

/**
 * Check `egress`, `egressNotFetched` and the note they may owe.
 *
 * The list is required even when empty: a reach of nothing is a claim worth
 * writing down, and `egressNote` is where the reason goes.
 *
 * @param manifest - The manifest being validated.
 * @param required - Whether a missing `egress` is itself an error.
 * @param errors - Accumulator for human-readable errors.
 */
export function checkEgress(
  manifest: Record<string, unknown>,
  required: boolean,
  errors: string[],
): void {
  const egress = manifest.egress;
  if (egress === undefined) {
    if (required) {
      errors.push(
        "manifest.egress is required — a source's reach must be written down, even when it is nothing (`egress: []` plus an `egressNote`)",
      );
    }
    return;
  }
  if (!Array.isArray(egress)) {
    errors.push('manifest.egress must be an array of bare hostnames');
    return;
  }

  const notFetched = Array.isArray(manifest.egressNotFetched) ? manifest.egressNotFetched : [];
  const seen = new Set<string>();
  checkEntries(egress, 'egress', manifest, seen, errors);
  checkEntries(notFetched, 'egressNotFetched', manifest, seen, errors);
  checkNotes(egress, notFetched, manifest, errors);
}
