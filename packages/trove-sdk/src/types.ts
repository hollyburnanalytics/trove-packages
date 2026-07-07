/**
 * Public type surface for the `@ontrove/sdk` source authoring library.
 *
 * These types describe the source contract (see the sources SDK reference
 * and the cursors guide on the docs site): a source is
 * an object with a `sync(ctx)` method that fetches new content from the
 * upstream system and returns documents to index. The SDK owns the document shape (which maps 1:1 onto the
 * `IngestDocumentInput` wire type), the typed `ctx` capability object, the
 * watermark/cursor model, and the local-run harness the CLI drives.
 *
 * It is the symmetric sibling of `@ontrove/mcp` (the toolkit-authoring library —
 * every toolkit runs as a full MCP server on Trove's cloud): a source returns
 * documents to be _stored_ (batch `sync`); a toolkit's tools return results to
 * be _read live_.
 *
 * @module
 */

/**
 * The default content type Trove assigns a document when it omits `contentType`.
 * Mirrors the GraphQL `ContentType` enum surfaced on `IngestDocumentInput`.
 */
export type SourceContentType = 'text' | 'transcript' | 'highlight' | 'bookmark';

/**
 * A single document a source returns from `sync`. The fields map **1:1** onto
 * the GraphQL `IngestDocumentInput` the Mac app pushes via `ingestDocuments`:
 *
 * | SDK field     | `IngestDocumentInput` field |
 * |---------------|-----------------------------|
 * | `id`          | `externalId` (required)     |
 * | `title`       | `title`                     |
 * | `text`        | `text`                      |
 * | `audioUrl`    | `audioUrl`                  |
 * | `url`         | `url`                       |
 * | `author`      | `author`                    |
 * | `date`        | `date` (ISO 8601 DateTime)  |
 * | `tags`        | `tags`                      |
 * | `metadata`    | `metadata` (JSON)           |
 * | `contentType` | `contentType` (ContentType) |
 *
 * Dedup is keyed on `(feed, id)`: returning the same `id` twice is safe and is
 * skipped on the server, so `sync` can be idempotent and retried freely. At least
 * one of `text` or `audioUrl` must be present — an audio-only document triggers
 * transcription (Whisper), and the transcript becomes the document text.
 */
export interface SourceDocument {
  /**
   * The stable external identifier from the upstream system — the dedup key
   * within the feed. Maps to `IngestDocumentInput.externalId`. Use the native id (HN
   * `objectID`, RSS `guid`, Notion page id), never a value that changes between
   * runs.
   */
  id: string;
  /** Document title. Maps to `IngestDocumentInput.title`. */
  title?: string;
  /**
   * Full plain-text content. Maps to `IngestDocumentInput.text`. Strip HTML/markup
   * for best search quality. Required unless `audioUrl` is set.
   */
  text?: string;
  /**
   * URL to an audio file. Maps to `IngestDocumentInput.audioUrl`. Trove downloads
   * and transcribes it; the transcript becomes the document text and the document
   * is indexed as `contentType: transcript`. Provide instead of (or alongside)
   * `text`.
   */
  audioUrl?: string;
  /** Canonical link back to the original. Maps to `IngestDocumentInput.url`. */
  url?: string;
  /**
   * Content author. Maps to `IngestDocumentInput.author`. For podcasts, set this
   * to the show name (Trove convention).
   */
  author?: string;
  /**
   * Original creation date as an ISO 8601 string (e.g. `"2026-06-14T09:00:00Z"`).
   * Maps to the `DateTime` `IngestDocumentInput.date`. Used for recency ranking
   * and the "published" display.
   */
  date?: string;
  /** Array of string tags. Maps to `IngestDocumentInput.tags`. */
  tags?: string[];
  /**
   * Arbitrary source-specific JSON. Maps to `IngestDocumentInput.metadata`.
   * **Never** put credentials or auth headers here.
   */
  metadata?: Record<string, unknown>;
  /**
   * One of `text`, `transcript`, `highlight`, `bookmark`. Maps to
   * `IngestDocumentInput.contentType`. Defaults to `text` (transcribed audio
   * becomes `transcript` automatically).
   */
  contentType?: SourceContentType;
}

/**
 * A typed watermark describing how a feed resumes between syncs. The opaque
 * `Feed.cursor` string is parsed into one of these (see the cursors guide,
 * watermark types).
 *
 * - `date` — the feed is time-ordered and supports "since &lt;date&gt;"
 *   filtering (RSS, most APIs); the newest `value` you push becomes the next
 *   cursor.
 * - `idSet` — the feed has monotonic ids but no reliable date filter; advance
 *   to the highest id seen (`max`), optionally tracking a recent id set.
 * - `none` — re-fetch everything each run and rely purely on `(feed, id)`
 *   dedup. Always correct, just less efficient.
 */
export type Watermark =
  | { readonly type: 'date'; readonly value: string }
  | { readonly type: 'idSet'; readonly values: readonly string[]; readonly max?: string }
  | { readonly type: 'none' };

/**
 * The result of a source `sync`: the documents fetched this run and, optionally,
 * the watermark the feed should advance to. A source may also return a bare
 * `SourceDocument[]` for convenience — {@link runSource} normalizes that to
 * `{ documents }` with no cursor change.
 */
export interface SourceSyncResult {
  /** The documents fetched this run, mapping 1:1 onto `IngestDocumentInput`. */
  documents: SourceDocument[];
  /**
   * The watermark to advance the feed's cursor to. Omit (or return `{ type: 'none' }`)
   * to leave the cursor unchanged. The cloud only advances if the new value is
   * monotonically ahead (compare-and-swap).
   */
  cursor?: Watermark;
}

/**
 * The standard `fetch` signature the SDK exposes on {@link SourceContext.fetch}.
 * Matches the platform `fetch` so existing code ports unchanged.
 */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The single argument to `sync` — a capability object: everything a source
 * reaches the outside world through is on `ctx`. There is no ambient authority.
 *
 * `ctx.credentials` (Keychain-resolved auth material) and `ctx.browser` (a
 * Playwright browser for `needs_browser` sources) are **PROPOSED**, not part
 * of the shipped contract, and so are intentionally absent here.
 */
export interface SourceContext<C = Record<string, unknown>> {
  /**
   * The user's preference values, keyed by the field names declared in
   * `manifest.json` `config`. **Preferences only — never credentials.** Feed
   * URLs, usernames, section lists, and filters live here; auth material lives in
   * the macOS Keychain, surfaced (PROPOSED) via `ctx.credentials`, never here.
   */
  readonly config: C;
  /**
   * The feed's current watermark (the position from the previous run), or
   * `{ type: 'none' }` on the first sync. Read-only — advance the cursor by
   * returning a new {@link Watermark} from `sync`, not by mutating this.
   */
  readonly cursor: Watermark;
  /**
   * Behaves like the standard `fetch`. Prefer `ctx.fetch` over global `fetch` —
   * in the Mac app it routes through per-source timeouts, retry, and
   * rate-limit handling, surfacing failures in the source's error log.
   */
  fetch: FetchLike;
  /**
   * Structured log entry, surfaced in the Mac app's source logs and the
   * `createSyncRun` audit record. Useful for reporting counts and progress.
   */
  log(...args: unknown[]): void;
  /**
   * The current wall-clock time as a `Date`. Injected (rather than read from a
   * global) so syncs are deterministic under test and the local-run harness.
   */
  now(): Date;
}

/**
 * The type a source's default export satisfies. A source is an object with
 * a `sync` method that fetches new content and returns documents to index.
 *
 * @typeParam C - The shape of the source's typed `ctx.config` preferences.
 *
 * @example
 * ```ts
 * import { defineSource } from '@ontrove/sdk';
 *
 * export default defineSource({
 *   async sync(ctx) {
 *     const res = await ctx.fetch(ctx.config.feedUrl as string);
 *     return parse(await res.text());
 *   },
 * });
 * ```
 */
export interface TroveSource<C = Record<string, unknown>> {
  /**
   * The batch entry point. Fetches new content and returns documents to
   * index, optionally with a new cursor. May return a bare `SourceDocument[]`
   * for convenience. Throw a plain `Error` to fail the run (the Mac app records
   * the error and retries next tick).
   */
  sync(ctx: SourceContext<C>): Promise<SourceSyncResult | SourceDocument[]>;
}

/**
 * A single field descriptor inside a manifest `config` object — describes one
 * preference input shown in the source's setup wizard.
 */
export interface ManifestConfigField {
  /** Display label in the setup UI. */
  label?: string;
  /** Input type — `text`, `text[]`, `url`, `url[]`, `path`, `number`, `boolean`. */
  type?: string;
  /** Optional example text shown in the input. */
  placeholder?: string;
}

/**
 * A source `manifest.json` — declares what the source is, how often it runs,
 * and which preference fields the user fills in during setup
 * (sources/manifest reference).
 */
export interface SourceManifest {
  /** Stable source-type id; pattern `^[a-z0-9-]+$`. Required. */
  id: string;
  /** Human-readable display name. Required. */
  name: string;
  /** One-line directory description. */
  description?: string;
  /** A single emoji or an HTTPS URL to a square icon. */
  icon?: string;
  /** Semver version string. Required. */
  version: string;
  /** Who wrote the source. */
  author?: string;
  /** Directory grouping — `reading`, `social`, `finance`, `dev`, `media`, etc. */
  category?: string;
  /**
   * Human-readable sync cadence — `"every 6 hours"`, `"daily"`, `"on demand"`, or
   * `null` for a live-only source. Optional (default: on demand).
   */
  schedule?: string | null;
  /** The preference fields shown in the setup wizard. Preferences only — no credentials. */
  config?: Record<string, ManifestConfigField>;
  /** Whether the source requires a Playwright browser. Default `false`. */
  needs_browser?: boolean;
  /** What kind of source this is — `feed`, `account`, `files`, `api`. */
  kind?: string;
  /** How the source reaches the upstream system — `http`, `browser`, `fs`. */
  transport?: string;
  /** Default content type for documents this source produces. */
  document_semantics?: SourceContentType;
}
