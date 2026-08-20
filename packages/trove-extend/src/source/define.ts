/**
 * `defineSource` — the single entry point for authoring a Trove source
 * (sources/sdk-reference). It is the symmetric sibling of `defineToolkit`
 * in `@ontrove/extend/toolkit`.
 *
 * ## The source declares itself
 *
 * A source is its metadata *and* its `sync`, in one value. There is no separate
 * `manifest.json` to keep in step, because the manifest is **generated** from
 * this call ({@link toSourceManifest}).
 *
 * That is not tidiness. A hand-written manifest is a declaration nothing
 * compiles, and every one of them here had drifted: the `sdk` field named
 * versions (`^0.1`, `^0.7`, `^0.10`) of a package that had reached 1.0.1,
 * because no validator, no backend and no client ever read it. Declaring the
 * same facts in TypeScript means the compiler is the thing that notices.
 *
 * Validation is eager: {@link validateSourceManifest} runs at definition time,
 * so a bad `runsIn`, an unrecognised cadence, or a credential smuggled into
 * `config` fails when the module is imported — at authoring and at deploy —
 * rather than on the first scheduled run.
 *
 * @module
 */

import type {
  Document,
  SourceContext,
  SourceManifest,
  SourceSyncResult,
  TroveSource,
} from '../types.js';
import { validateSourceManifest } from './manifest.js';

/**
 * A complete source: what it is, and what it does.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 */
export interface SourceExtension<C = Record<string, unknown>>
  extends SourceManifest,
    TroveSource<C> {}

/**
 * Validate and return a source definition unchanged.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 * @param source - The source to validate — its manifest fields plus `sync`.
 * @returns The same object, with full inferred types preserved.
 * @throws {Error} If `sync` is missing, or the manifest half is invalid.
 *
 * @example
 * ```ts
 * export default defineSource({
 *   id: 'hex-blog',
 *   name: 'Hex Blog',
 *   description: 'Data science and analytics engineering posts',
 *   icon: '⬡',
 *   version: '0.1.0',
 *   author: 'Hollyburn Analytics Inc.',
 *   kind: 'scheduled-sync',
 *   transport: 'scrape',
 *   cursor: 'idSet',
 *   ingest: 'append',
 *   runsIn: 'cloud',
 *   schedule: 'weekly',
 *   status: 'implemented',
 *   needsBrowser: false,
 *   egress: ['hex.tech'],
 *   async sync(ctx) {
 *     return scrapeListing(ctx, { listingUrl: 'https://hex.tech/blog' });
 *   },
 * });
 * ```
 */
export function defineSource<C = Record<string, unknown>>(
  source: SourceExtension<C>,
): SourceExtension<C> {
  if (source === null || typeof source !== 'object') {
    throw new Error('defineSource: expected a source object with a `sync` method');
  }
  if (typeof (source as { sync?: unknown }).sync !== 'function') {
    throw new Error('defineSource: source must have a `sync(ctx)` function');
  }
  // `implemented` because a source with code is held to the subset the runtimes
  // actually build; a stub may name a value outside it, but a stub has no
  // `sync` and so never reaches here.
  const result = validateSourceManifest(toSourceManifest<C>(source), { implemented: true });
  if (!result.valid) {
    throw new Error(
      `defineSource: ${source.id ?? '(no id)'} has an invalid manifest:\n  ${result.errors.join('\n  ')}`,
    );
  }
  return source;
}

/**
 * The manifest half of a source, as the JSON a catalog commits.
 *
 * Committed rather than computed on demand because the readers cannot execute
 * the source: Trove's catalog build and the Mac app both read `manifest.json`
 * off disk, and neither runs TypeScript to do it. `generated` marks the file as
 * an artifact so nobody edits it by hand and loses the change on the next build.
 *
 * @param source - The source definition.
 * @returns The manifest fields, plus the `generated` marker. `sync` is dropped.
 */
export function toSourceManifest<C = Record<string, unknown>>(
  source: SourceExtension<C>,
): Record<string, unknown> {
  const { sync: _sync, ...manifest } = source;
  return { ...manifest, generated: true };
}

/**
 * A source authored inline as a single `sync` function.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 * @param sync - The source's `sync(ctx)` implementation.
 * @returns A {@link TroveSource} wrapping `sync`. No manifest, so not deployable
 *   on its own — this is the shape a test or a local experiment uses.
 */
export function defineSync<C = Record<string, unknown>>(
  sync: (ctx: SourceContext<C>) => Promise<SourceSyncResult | Document[]>,
): TroveSource<C> {
  if (typeof sync !== 'function') {
    throw new Error('defineSync: expected a `sync(ctx)` function');
  }
  return { sync };
}
