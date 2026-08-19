/**
 * `defineSource` — the single entry point for authoring a Trove source
 * (sources/sdk-reference). It is the symmetric sibling of `defineMcpServer`
 * in `@ontrove/mcp`.
 *
 * It is an identity function with light, eager validation: it confirms the value
 * is a source object with a `sync` method, so a typo (`snyc`, a missing
 * `sync`, a non-function) fails at authoring/deploy time with a clear message
 * rather than at the first scheduled run. It does **not** execute `sync` — that is
 * {@link runSource}'s job.
 *
 * @module
 */

import type { Document, SourceContext, SourceSyncResult, TroveSource } from './types.js';

/**
 * Validate and return a source definition unchanged.
 *
 * Using `defineSource(...)` (rather than a bare `satisfies TroveSource`)
 * gives an eager runtime check: the CLI calls this when loading a source
 * module so a malformed export is rejected before any sync runs. The returned
 * value is the same object, with full inferred types preserved.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 * @param source - The source object to validate.
 * @returns The same source object.
 * @throws {Error} If `source` is not an object with a `sync` function.
 *
 * @example
 * ```ts
 * export default defineSource({
 *   async sync(ctx) {
 *     const res = await ctx.fetch(ctx.config.feedUrl as string);
 *     return parseRss(await res.text());
 *   },
 * });
 * ```
 */
export function defineSource<C = Record<string, unknown>>(source: TroveSource<C>): TroveSource<C> {
  if (source === null || typeof source !== 'object') {
    throw new Error('defineSource: expected a source object with a `sync` method');
  }
  if (typeof (source as { sync?: unknown }).sync !== 'function') {
    throw new Error('defineSource: source must have a `sync(ctx)` function');
  }
  return source;
}

/**
 * A source authored inline as a single `sync` function, for the common case
 * where the source has no other members. Equivalent to
 * `defineSource({ sync })`.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 * @param sync - The source's `sync(ctx)` implementation.
 * @returns A validated {@link TroveSource} wrapping `sync`.
 */
export function defineSync<C = Record<string, unknown>>(
  sync: (ctx: SourceContext<C>) => Promise<SourceSyncResult | Document[]>,
): TroveSource<C> {
  return defineSource<C>({ sync });
}
