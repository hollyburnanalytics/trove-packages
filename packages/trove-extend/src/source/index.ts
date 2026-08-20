/**
 * `@ontrove/extend/source` — the shared vocabulary for **Trove sources**: scheduled
 * adapters that fetch content into a knowledge base. A source exports a
 * `sync(ctx)` that returns documents; this package owns the shapes both ends of
 * that call agree on.
 *
 * ## What it owns today
 *
 * - **The invoke contract** (`@ontrove/extend/contract`) — the request/response
 *   envelope every runtime speaks. Three of them execute it: Trove's deployed
 *   shim, the CLI's local shim, and the Mac harness. This is the load-bearing
 *   part, and the reason the same `sync(ctx)` runs unchanged in all three.
 * - **The types** — {@link Document}, {@link SourceContext},
 *   {@link Cursor}, {@link SourceManifest}. Trove imports several of them
 *   directly rather than re-declaring them.
 * - **`runSource`** — the local-run harness the CLI drives, with the same
 *   validation and dedup the cloud applies.
 * - **`validateSourceManifest`** — what a manifest must say to be installable,
 *   including the vocabulary itself: which `kind`, `transport`, `cursor` and
 *   `ingest` values exist, and which subset is buildable today.
 * - **The cursor writer** — {@link dateCursor}, {@link idSetCursor} and
 *   their readers. The type and the code that produces it are now in one place,
 *   so the contract test asserts against the writer rather than fixtures.
 * - **The guarded fetch seam** — {@link fetchPage} / {@link fetchBytes}, with the
 *   host guard, timeout and size caps a source should never re-implement. It
 *   takes the `fetch` it is given, so a source called with a capability-bearing
 *   `ctx.fetch` uses that one.
 *
 * ## What it does not own yet
 *
 * Feed and HTML parsing — the RSS/Atom reader, HTML to text, the scrape loop —
 * still live alongside the sources themselves. Those are the next candidates;
 * the pieces every source needs in order to be *correct* rather than merely
 * convenient now live here.
 *
 * It is the symmetric sibling of `@ontrove/extend/toolkit`, the toolkit-authoring library
 * (every toolkit runs as a full MCP server on Trove's cloud): a source returns
 * documents to be _stored_ (`defineSource` + `sync`); a toolkit's tools return
 * results to be _read live_ (`defineToolkit`). The two are at different
 * stages — a toolkit is written *in* `@ontrove/extend/toolkit`, while a source is written
 * against a contract this package defines and helpers it does not yet provide.
 *
 * @example
 * ```ts
 * import { defineSource } from '@ontrove/extend/source';
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

export {
  assertPublicHttpUrl,
  FETCH_TIMEOUT_MS,
  type FetchedPage,
  fetchBytes,
  fetchPage,
  fetchPageWithMeta,
  type GuardedFetchOptions,
  HttpStatusError,
  isTooLargeError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  TROVE_USER_AGENT,
} from '../http.js';
export type {
  Cursor,
  Document,
  ExtensionContext,
  FetchLike,
  LogChannel,
  ManifestConfigField,
  SourceContentType,
  SourceContext,
  SourceManifest,
  SourceSyncResult,
  TroveSource,
} from '../types.js';
export { stringList } from './config.js';
export {
  advanceDateCursor,
  DEFAULT_ID_SET_MAX,
  dateCursor,
  idSetCursor,
  MAX_ID_SET_BYTES,
  readDateCursor,
  readIdSet,
} from './cursor.js';
export { defineSource, defineSync } from './define.js';
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
  INGEST_MODES,
  type IngestMode,
  isCredentialConfigKey,
  type ManifestValidationOptions,
  type ManifestValidationResult,
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
  validateSourceManifest,
} from './manifest.js';
export {
  type RunOptions,
  type RunResult,
  runSource,
} from './runtime.js';
