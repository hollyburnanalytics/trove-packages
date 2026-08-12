/**
 * `@ontrove/sdk` — the thin standard library for authoring **Trove sources**.
 * You write a `sync(ctx)` that fetches new content and returns documents; the
 * SDK owns the document shape (which maps 1:1 onto `IngestDocumentInput`), the
 * typed `ctx` capability object, the watermark/cursor model, the local-run
 * harness the CLI drives, and manifest validation.
 *
 * It is the symmetric sibling of `@ontrove/mcp`, the toolkit-authoring library
 * (every toolkit runs as a full MCP server on Trove's cloud): a source returns
 * documents to be _stored_ (`defineSource` + `sync`); a toolkit's tools return
 * results to be _read live_ (`defineMcpServer`).
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
