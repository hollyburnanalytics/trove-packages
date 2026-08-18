/**
 * The source vocabulary: the words a `manifest.json` may use, and which of them
 * are built today.
 *
 * Separated from the rules that validate a manifest because they answer
 * different questions and change at different times. This file says what the
 * words ARE — a new transport, a new watermark strategy, a schedule Trove will
 * honour — and is the list a client renders or a catalog tests against.
 * `manifest.ts` says what makes a manifest VALID, and imports these.
 *
 * @module
 */

/**
 * The sync cadences a manifest may name. A schedule is a human-readable phrase
 * rather than a cron expression because it is shown to the person enabling the
 * source; the scheduler maps each phrase to an interval.
 *
 * The list is closed on purpose. An unrecognised cadence used to be quietly
 * treated as daily, which meant a source asking for "hourly" ran 24× less often
 * than its author believed, and nothing said so.
 */
export const VALID_SCHEDULES = [
  'every 30 minutes',
  'every 1 hour',
  'every 2 hours',
  'every 4 hours',
  'every 6 hours',
  'every 12 hours',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'on demand',
] as const;

/** One of {@link VALID_SCHEDULES}. */
export type SourceSchedule = (typeof VALID_SCHEDULES)[number];

/**
 * Execution contract — which entrypoint the harness invokes.
 *
 * `scheduled-sync` is the batch contract this SDK is built around: a `sync(ctx)`
 * that returns documents to store. The on-demand kinds describe adapters that
 * answer a single question live rather than filling a library.
 */
export const SOURCE_KINDS = ['scheduled-sync', 'on-demand-fetch', 'on-demand-query'] as const;

/** One of {@link SOURCE_KINDS}. */
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * The mechanism by which a source reaches its data. This is what decides
 * whether the source can run anywhere but the user's own machine — see
 * {@link CLOUD_ELIGIBLE_TRANSPORTS}.
 */
export const TRANSPORTS = ['feed', 'scrape', 'api', 'browser', 'local'] as const;

/** One of {@link TRANSPORTS}. */
export type SourceTransport = (typeof TRANSPORTS)[number];

/**
 * Default executor for a source's sync. `cloud` = a Trove-hosted runtime;
 * `client` = the user's own device.
 *
 * The manifest value is both the *default* and the *eligibility bound*: a
 * `cloud` source may be flipped to `client` for a given user (their machine can
 * run anything), never the reverse — a source that needs a browser or a local
 * file cannot be hoisted into a runtime that has neither.
 */
export const LOCATIONS = ['cloud', 'client'] as const;

/** One of {@link LOCATIONS}. */
export type SourceLocation = (typeof LOCATIONS)[number];

/**
 * The transports whose sync is a pure HTTP pull — the necessary condition for a
 * source to run in the cloud at all. A `browser` source drives a real browser
 * and a `local` source reads the user's disk; neither exists in a hosted
 * runtime, so both are pinned to the client.
 */
export const CLOUD_ELIGIBLE_TRANSPORTS: readonly SourceTransport[] = ['feed', 'api', 'scrape'];

/**
 * The `config` field types a fan-out source may explode into one feed per entry
 * — a list of feed URLs, or a list of query strings. A scalar field cannot
 * fan out, so naming one in `fanOut` is rejected rather than silently producing
 * a single feed.
 */
export const FAN_OUT_FIELD_TYPES = ['url[]', 'text[]'] as const;

/** One of {@link FAN_OUT_FIELD_TYPES}. */
export type FanOutFieldType = (typeof FAN_OUT_FIELD_TYPES)[number];

/**
 * The affordances a directoried config field can ask a client to render:
 * `search` (type a name, pick from results) or `resolve` (paste something and
 * have it turned into the real address).
 */
export const DIRECTORY_MODES = ['search', 'resolve'] as const;

/** One of {@link DIRECTORY_MODES}. */
export type DirectoryMode = (typeof DIRECTORY_MODES)[number];

/**
 * The auth strategies Trove knows how to sign a directory lookup with. A
 * directory provider names one and the platform applies it, so no source author
 * ever handles the credential.
 *
 * Declared here as the closed vocabulary: a provider naming a strategy nothing
 * implements should fail when the catalog is built, not at a user's first
 * search — where it would look like "no results" rather than a bug.
 */
export const DIRECTORY_AUTH_STRATEGIES = ['podcast-index'] as const;

/** One of {@link DIRECTORY_AUTH_STRATEGIES}. */
export type DirectoryAuthStrategy = (typeof DIRECTORY_AUTH_STRATEGIES)[number];

/**
 * The resume strategy a source declares; the value itself lives in the feed's
 * cursor between runs. `date`, `idSet` and `none` are the three the SDK's
 * `Watermark` type carries today; the rest are declared shapes for feeds that
 * resume by token, by row, or by whole-snapshot comparison.
 */
export const WATERMARK_STRATEGIES = [
  'date',
  'idSet',
  'none',
  'highWaterId',
  'opaqueToken',
  'snapshot',
  'mtime',
  'rowid',
] as const;

/** One of {@link WATERMARK_STRATEGIES}. */
export type WatermarkStrategy = (typeof WATERMARK_STRATEGIES)[number];

/**
 * What ingest does with the documents a run returns. `append` adds what is new
 * and leaves what is stored alone; `upsert` lets a later run replace an earlier
 * document with the same id.
 */
export const DOCUMENT_SEMANTICS = ['append', 'upsert'] as const;

/** One of {@link DOCUMENT_SEMANTICS}. */
export type DocumentSemantics = (typeof DOCUMENT_SEMANTICS)[number];

/**
 * Whether Trove reformats a source's documents into clean Markdown on ingest,
 * or stores them exactly as received.
 *
 * `reformat` restructures the body — headings, paragraph breaks, lists — while
 * preserving the words verbatim, with a fidelity gate that falls back to the
 * original if the rewrite would alter them. `verbatim` leaves the body
 * untouched.
 *
 * The field is optional and defaults to `verbatim`, so a new or third-party
 * source never has its data altered unless its author opts in. That default is
 * why `formatting` is deliberately not one of the {@link SOURCE_TYPE_FIELDS},
 * which are the fields a source must declare.
 */
export const FORMATTING = ['reformat', 'verbatim'] as const;

/** One of {@link FORMATTING}. */
export type FormattingPolicy = (typeof FORMATTING)[number];

/**
 * The MVP cut: the subset of each vocabulary the runtimes actually build and
 * enforce today.
 *
 * A source that has code must stay inside these — declaring `upsert` when
 * nothing upserts yet buys a source nothing and costs a user a silent surprise.
 * A source that is still a stub may name a value outside the cut, which is how
 * a planned source records the shape it is headed for without pretending to
 * work.
 *
 * `transports` currently lists every transport: `local` graduated once it was
 * clear the runtime imposes nothing transport-specific, so an adapter reading
 * on-disk data needs no support beyond what feed and api sources already use.
 */
export const MVP: {
  readonly kinds: readonly SourceKind[];
  readonly transports: readonly SourceTransport[];
  readonly watermarks: readonly WatermarkStrategy[];
  readonly documentSemantics: readonly DocumentSemantics[];
} = {
  kinds: ['scheduled-sync'],
  transports: ['feed', 'scrape', 'api', 'browser', 'local'],
  watermarks: ['date', 'idSet', 'none'],
  documentSemantics: ['append'],
};

/**
 * The watermark strategies a `runtime: deployed` source may additionally use.
 *
 * The cut is not one list, because the two runtimes genuinely differ here and
 * pretending otherwise is what produced a shipped manifest declaring a strategy
 * that exists in no vocabulary.
 *
 * A DEPLOYED source's cursor is handed back byte-for-byte: Trove stores it as
 * opaque JSON and the invoke contract requires it reach the adapter unchanged.
 * So a source resuming from a monotonic id — the newest post it saw, and "give
 * me everything after this" — works today, and one does.
 *
 * A BUNDLED source's cursor is parsed before it is handed over, and a shape the
 * {@link Watermark} union does not name parses to nothing. The same source
 * compiled into the cloud runtime would silently start from the beginning on
 * every run, which is why `highWaterId` is NOT in {@link MVP} and a bundled
 * source declaring it is refused.
 *
 * The distinction is worth a second list rather than a footnote: it is the
 * difference between a source that resumes and one that re-reads a metered API
 * from the top, forever, without an error anywhere.
 */
export const MVP_DEPLOYED_WATERMARKS: readonly WatermarkStrategy[] = [
  ...MVP.watermarks,
  'highWaterId',
];

/**
 * The four type-system fields with their full vocabularies, keyed by field
 * name. Exported so a catalog can render the taxonomy — a picker, a docs table,
 * a test that asserts every source's declaration is in range — from the same
 * data the validator uses, rather than a copy that drifts.
 */
export const SOURCE_TYPE_FIELDS: {
  readonly kind: readonly SourceKind[];
  readonly transport: readonly SourceTransport[];
  readonly watermark: readonly WatermarkStrategy[];
  readonly documentSemantics: readonly DocumentSemantics[];
} = {
  kind: SOURCE_KINDS,
  transport: TRANSPORTS,
  watermark: WATERMARK_STRATEGIES,
  documentSemantics: DOCUMENT_SEMANTICS,
};
