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
  /**
   * Document title. Maps to `IngestDocumentInput.title`.
   *
   * REQUIRED, because every path that ingests one requires it — a titleless
   * document is refused at the seam with "has no title". Optional here until
   * the two were lined up, which meant the type accepted something the
   * platform would always reject, and you found out at run time on a schedule
   * rather than at your desk.
   */
  title: string;
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
  /**
   * URL to a file Trove should fetch and extract — a PDF, an EPUB, a document.
   * The platform downloads it, retains the artifact, and derives the text.
   *
   * Use instead of `text` when the upstream's real content is a file rather
   * than a string. Pair with {@link mimeType} when the URL does not reveal the
   * type.
   */
  fileUrl?: string;
  /**
   * The MIME type of {@link fileUrl}, when the URL alone does not say.
   * Ignored without one.
   */
  mimeType?: string;
  /**
   * Retain the artifact WITHOUT transcribing or extracting it.
   *
   * For an explicit "save this, do not spend on processing it" — the platform
   * keeps the file and the metadata, and no speech-to-text or extraction runs.
   */
  captureOnly?: boolean;
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
 *   cursor. Set `inclusive` when the boundary item itself must be re-emitted
 *   next run (a `>=` comparison) rather than skipped (the default strict `>`).
 * - `idSet` — the feed has no reliable date filter, so resuming means
 *   remembering which ids were already seen. `values` is that set (oldest
 *   first) and `max` is the **cap on how many ids are retained** — a count, not
 *   an id. Past the cap the oldest ids are evicted, which at worst re-fetches
 *   those items once and lets `(feed, id)` dedup absorb them.
 * - `none` — re-fetch everything each run and rely purely on `(feed, id)`
 *   dedup. Always correct, just less efficient.
 */
export type Watermark =
  // `idSet.max` was declared `string` here until it was reconciled against the
  // two implementations that actually move this value, both of which say
  // number: the writer bounds the set with `idSetWatermark(values, max)` and
  // emits the numeric cap it applied, and Trove's reader projects the same
  // field as the set's capacity (`values.length >= max` is what surfaces "this
  // feed is now evicting"). Trove also hands its parsed cursor straight back as
  // `ctx.cursor`, so this type is not just documentation of the wire value —
  // it is the type of a value the platform constructs. A `string` here was a
  // lie at that boundary, and a source that took the old type at its word and
  // wrote `max: '10000'` would have had the field silently dropped, because the
  // reader keeps `max` only when `typeof max === 'number'`.
  // `date.inclusive` was likewise missing here while the writer emits it.
  | { readonly type: 'date'; readonly value: string; readonly inclusive?: true }
  | { readonly type: 'idSet'; readonly values: readonly string[]; readonly max?: number }
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
 * A log channel: callable for the common case, with levels when severity
 * matters.
 *
 * Callable and levelled at once because both already existed. Sources written
 * against this SDK call `ctx.log(...)`; every adapter running in Trove's cloud
 * calls `ctx.log.info(...)`. Supporting one meant rewriting the other set, for
 * no gain to anybody — so the type admits both and the runtimes supply both.
 */
export interface LogChannel {
  (...args: unknown[]): void;
  /** Ordinary progress. The default level for a bare `log(...)` call. */
  info(...args: unknown[]): void;
  /** Something surprising that did not stop the run. */
  warn(...args: unknown[]): void;
  /** Something that did stop it, or is about to. */
  error(...args: unknown[]): void;
}

/**
 * What EVERY extension is handed, whichever kind it is.
 *
 * This is the shared spine of the two contexts — a source's {@link
 * SourceContext} and a toolkit's `ToolContext` in `@ontrove/mcp`. Both are this
 * plus what only their kind needs, so the things an author uses constantly
 * (a credential, a guarded fetch, a log line, the clock) are learned once and
 * are identical on both sides.
 *
 * `@ontrove/mcp` does not import this type — it has no dependency on this
 * package and should not gain one for a shape. Instead the convergence is
 * asserted at the type level where both are already visible, so the two cannot
 * drift apart without something going red.
 *
 * Everything here is a capability. There is no ambient authority: an extension
 * reaches the outside world only through what it was handed.
 */
export interface ExtensionContext {
  /**
   * A credential the manifest declared, by name.
   *
   * Resolves whether the value was pasted by the user or is a token Trove
   * refreshed a moment ago — the extension cannot tell, and must not need to.
   * That is what keeps delegated authorization out of every author's code.
   *
   * Async because resolving may involve a vault read or a token refresh.
   * Rejects when the name was never declared in the manifest, which is a
   * programming error rather than a runtime condition.
   */
  secret(name: string): Promise<string>;
  /**
   * {@link secret}, but stating plainly that the extension cannot proceed
   * without it. Behaves identically; the name is the documentation.
   */
  requireSecret(name: string): Promise<string>;
  /**
   * Behaves like the standard `fetch`, and is the ONLY way out.
   *
   * In Trove's cloud every request is routed through an egress worker that
   * permits https alone, matches the manifest's declared hosts exactly, and
   * refuses private and link-local addresses even when allowlisted. On the Mac
   * it adds per-source timeouts, retry and rate-limit handling. Prefer it over
   * global `fetch` everywhere: the global one is unguarded where it exists at
   * all, and absent where it does not.
   */
  fetch: FetchLike;
  /** Where an extension says what it is doing. Surfaced in the run transcript. */
  log: LogChannel;
  /**
   * The current wall-clock time.
   *
   * Injected rather than read from a global so a run is deterministic under
   * test, and so a replayed fixture means the same thing tomorrow.
   */
  now(): Date;
}

/**
 * The single argument to `sync` — {@link ExtensionContext} plus what a
 * scheduled, resumable, fan-out-capable source needs on top of it.
 */
export interface SourceContext<C = Record<string, unknown>> extends ExtensionContext {
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
   * When this round must be finished, as epoch milliseconds.
   *
   * A sync is given a budget, not unlimited time — in the cloud because the
   * isolate has a CPU ceiling, on the Mac because a user is waiting. A source
   * that may run long should check this between units of work and return what
   * it has, advancing the cursor honestly, rather than being cut off mid-item.
   *
   * `Infinity` where the host imposes no deadline.
   */
  readonly deadline: number;
  /**
   * Report progress through a long run: how many items are done, and
   * optionally a line for a person watching.
   *
   * A no-op where there is no channel back — a deployed source is one request
   * and one response, with nowhere to send an update mid-flight. Call it
   * anyway; a source should not have to know which host it is on.
   */
  progress(done: number, message?: string): void;
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
