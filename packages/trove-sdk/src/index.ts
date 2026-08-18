/**
 * `@ontrove/sdk` — the shared vocabulary for **Trove sources**: scheduled
 * adapters that fetch content into a knowledge base. A source exports a
 * `sync(ctx)` that returns documents; this package owns the shapes both ends of
 * that call agree on.
 *
 * ## What it owns today
 *
 * - **The invoke contract** (`@ontrove/sdk/contract`) — the request/response
 *   envelope every runtime speaks. Three of them execute it: Trove's deployed
 *   shim, the CLI's local shim, and the Mac harness. This is the load-bearing
 *   part, and the reason the same `sync(ctx)` runs unchanged in all three.
 * - **The types** — {@link SourceDocument}, {@link SourceContext},
 *   {@link Watermark}, {@link SourceManifest}. Trove imports several of them
 *   directly rather than re-declaring them.
 * - **`runSource`** — the local-run harness the CLI drives, with the same
 *   validation and dedup the cloud applies.
 * - **`validateSourceManifest`** — what a manifest must say to be installable.
 *
 * ## What it does not own yet
 *
 * The helpers a source is mostly written against — feed parsing, HTML to text,
 * the scrape loop, and the code that WRITES a watermark — are not here. Each
 * catalog of sources carries its own, which means the shapes below are agreed
 * by convention at the boundary rather than by a shared implementation behind
 * it. {@link Watermark} shows the cost: the type had to be reconciled after the
 * fact against the writers that move the value, and the contract test pins the
 * agreed bytes as fixtures because there is no writer here to test.
 *
 * The direction is for this package to own those helpers, so that a source
 * imports the behaviour rather than copying it. Until then, a change to the
 * shapes below has to be carried into every catalog deliberately.
 *
 * It is the symmetric sibling of `@ontrove/mcp`, the toolkit-authoring library
 * (every toolkit runs as a full MCP server on Trove's cloud): a source returns
 * documents to be _stored_ (`defineSource` + `sync`); a toolkit's tools return
 * results to be _read live_ (`defineMcpServer`). The two are at different
 * stages — a toolkit is written *in* `@ontrove/mcp`, while a source is written
 * against a contract this package defines and helpers it does not yet provide.
 *
 * @example
 * ```ts
 * import { defineSource } from '@ontrove/sdk';
 *
 * export default defineSource({
 *   async sync(ctx) {
 *     const res = await ctx.fetch('https://hn.algolia.com/api/v1/search?tags=front_page');
 *     const { hits } = await res.json();
 *     return hits.map((hit) => ({
 *       id: hit.objectID,
 *       title: hit.title,
 *       text: hit.story_text ?? hit.title,
 *       url: hit.url,
 *       author: hit.author,
 *       date: new Date(hit.created_at_i * 1000).toISOString(),
 *       contentType: 'bookmark',
 *     }));
 *   },
 * });
 * ```
 *
 * @module
 */

export { defineSource, defineSync } from './define.js';
export {
  isCredentialConfigKey,
  type ManifestValidationResult,
  validateSourceManifest,
} from './manifest.js';
export {
  type RunOptions,
  type RunResult,
  runSource,
} from './runtime.js';
export type {
  ExtensionContext,
  FetchLike,
  LogChannel,
  ManifestConfigField,
  SourceContentType,
  SourceContext,
  SourceDocument,
  SourceManifest,
  SourceSyncResult,
  TroveSource,
  Watermark,
} from './types.js';
