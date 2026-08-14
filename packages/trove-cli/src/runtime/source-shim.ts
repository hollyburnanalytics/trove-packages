import type { SourceDocument, TroveSource, Watermark } from '@ontrove/sdk';
import { runSource } from '@ontrove/sdk';
import { redirectFollowingFetch } from './redirect-fetch.js';

/**
 * The deployed-source runtime shim: what `trove source deploy` bundles in front
 * of an author's `index.ts`.
 *
 * A deployed source is a pure function over HTTP — `POST /sync` with config,
 * credentials and cursor in; documents, cursor and logs out — and that is the
 * entire surface it has. It holds no Trove capability: it cannot search, cannot
 * read documents, cannot ingest. Trove ingests what the response *returns*.
 *
 * This module is the adapter between that wire shape and the one `sync(ctx)` an
 * author already wrote for `trove source dev`. It runs the sync through
 * `@ontrove/sdk`'s own {@link runSource} harness — the same validation, dedup
 * and cursor handling the local dev loop uses — so a source behaves in the
 * cloud the way it behaved on the author's machine.
 *
 * It is pre-bundled for the worker target by
 * `scripts/build-source-worker-runtime.mjs` and embedded in the CLI, because the
 * compiled single-binary has no on-disk `@ontrove/sdk` to bundle at deploy time.
 *
 * @module
 */

// Re-exported so this ONE bundled module can also stand in for `@ontrove/sdk`
// itself. The author's `index.ts` starts with `import { defineSource } from
// '@ontrove/sdk'`, and in the deployed bundle that specifier resolves here —
// otherwise the sandbox would carry two copies of the SDK, one for the shim and
// one for the source, and `defineSource` would not be the function `runSource`
// was written against.
export * from '@ontrove/sdk';

/** The body the runner POSTs to a deployed source. */
export interface SourceInvokeBody {
  /** The user's preference values, already validated. Never secrets. */
  config?: Record<string, unknown>;
  /**
   * Plaintext secrets the runner resolved from the vault, `{}` when the source
   * declares none. Reached through `ctx.secret(name)` — never as a bag the
   * source can enumerate, so a source cannot read a credential it did not name.
   */
  credentials?: Record<string, string>;
  /**
   * Where the last run got to — the watermark this source itself returned — or
   * `null` on a first run.
   */
  cursor?: unknown;
  /**
   * How long the run has, as a duration. Surfaced as `ctx.deadline`, an
   * absolute epoch-ms instant — the spine's shape, so a source that paces
   * itself does so identically here and on the Mac.
   *
   * A relative duration on the wire and an absolute instant in the context is
   * deliberate: the wire value is computed by a runner on a different machine,
   * and two clocks that disagree would hand the run a deadline already in
   * the past.
   */
  deadlineMs?: number;
}

/**
 * A document on the invoke wire. Snake-cased, and `title` is required — this is
 * the shape Trove's ingest door accepts, not the SDK's {@link SourceDocument}.
 */
export interface WireDocument {
  /** The stable upstream id — the dedup key, from `SourceDocument.id`. */
  id: string;
  /** The document title. Required here, optional in the SDK. */
  title: string;
  /** The indexable body. */
  text?: string;
  /** An audio enclosure Trove downloads and transcribes into the body. */
  audio_url?: string;
  file_url?: string;
  mime_type?: string;
  capture_only?: boolean;
  content_type?: string;
  /** The canonical link back to the original. */
  url?: string;
  /** The author (for podcasts, the show name). */
  author?: string;
  /** The ISO-8601 publication date. */
  date?: string;
  /** Tags to attach to the document. */
  tags?: string[];
  /** Arbitrary source-specific JSON. */
  metadata?: Record<string, unknown>;
}

/** What one invoke returns. */
export interface SourceInvokeResult {
  /** The documents this run produced (may be empty). */
  documents: WireDocument[];
  /**
   * The watermark to resume from. ABSENT means "keep the one you have" — a
   * `{ type: 'none' }` result is *not* an instruction to clear the cursor, and
   * sending one would make the next sync re-fetch the feed from the beginning.
   */
  cursor?: Watermark;
  /**
   * What the run did and what is left. `remaining > 0` asks the runner to drain
   * again rather than wait for the next scheduled tick, so a backfill finishes
   * in one sitting instead of one page per interval.
   */
  stats?: { fetched?: number; remaining?: number };
  /** What the feed calls itself, so it shows a name rather than a pasted URL. */
  feedName?: string;
  /** Where the feed permanently moved, so future runs stop paying the redirect. */
  feedUrl?: string;
  /** The adapter's `ctx.log(...)` lines, buffered — there is no live channel. */
  logs: string[];
}

/** The fetch handler a deployed source's module default-exports. */
export interface SourceWorker {
  /**
   * Serve one invoke.
   *
   * @param request - The runner's request.
   * @returns The invoke response.
   */
  fetch(request: Request): Promise<Response>;
}

/** Whether the global redirect policy has been installed. */
let redirectPolicyInstalled = false;

/**
 * Install the per-hop redirect policy over the global `fetch`, once.
 *
 * At module scope rather than per request, so that helper libraries calling
 * bare `fetch()` are covered too.
 */
function installRedirectPolicy(): void {
  if (redirectPolicyInstalled) return;
  globalThis.fetch = redirectFollowingFetch(globalThis.fetch.bind(globalThis));
  redirectPolicyInstalled = true;
}

/**
 * Read the cursor the runner sent back into a typed {@link Watermark}.
 *
 * Anything unrecognised resolves to `{ type: 'none' }`, which re-fetches and
 * relies on `(feed, id)` dedup — always correct, just less efficient. Throwing
 * instead would strand the feed: the bad cursor is already stored, so every
 * future run would fail on it too.
 *
 * @param raw - Whatever was stored as this feed's cursor.
 * @returns The watermark to hand the adapter.
 */
export function toWatermark(raw: unknown): Watermark {
  if (typeof raw === 'string' && raw !== '') return { type: 'date', value: raw };
  if (raw === null || typeof raw !== 'object') return { type: 'none' };
  const type = (raw as { type?: unknown }).type;
  if (type === 'date' || type === 'idSet' || type === 'none') return raw as Watermark;
  return { type: 'none' };
}

/**
 * Map one SDK document onto the invoke wire shape.
 *
 * `contentType` has no wire field and is dropped: the invoke contract types a
 * document the way Trove's ingest door does, where the type is derived (audio
 * becomes a transcript) rather than declared. Bundled sources cannot set it
 * either, so this is a property of the contract, not of deployment.
 *
 * @param doc - The document the source returned.
 * @returns The wire document.
 * @throws {Error} When the document has no title.
 */
export function toWireDocument(doc: SourceDocument): WireDocument {
  // The local harness accepts an untitled document; the ingest door does not.
  // Refused here, naming the document, so the author reads their own id rather
  // than a rejection of the whole batch from a service they cannot see.
  if (typeof doc.title !== 'string' || doc.title === '') {
    throw new Error(
      `document "${doc.id}" has no title — a deployed source must title every document`,
    );
  }
  return {
    id: doc.id,
    title: doc.title,
    ...(doc.text !== undefined && { text: doc.text }),
    ...(doc.audioUrl !== undefined && { audio_url: doc.audioUrl }),
    ...(doc.fileUrl !== undefined && { file_url: doc.fileUrl }),
    ...(doc.mimeType !== undefined && { mime_type: doc.mimeType }),
    ...(doc.captureOnly !== undefined && { capture_only: doc.captureOnly }),
    ...(doc.url !== undefined && { url: doc.url }),
    ...(doc.author !== undefined && { author: doc.author }),
    ...(doc.date !== undefined && { date: doc.date }),
    ...(doc.tags !== undefined && { tags: doc.tags }),
    ...(doc.metadata !== undefined && { metadata: doc.metadata }),
    // Carried, not dropped. This field survived the LOCAL path and vanished on
    // the deployed one, so the same source quietly indexed bookmarks as plain
    // text once it was deployed.
    ...(doc.contentType !== undefined && { content_type: doc.contentType }),
  };
}

/**
 * Run one invoke: build the SDK context from the body, run the source, and
 * return the wire result.
 *
 * @param source - The author's source.
 * @param body - The parsed invoke body.
 * @param logs - The buffer log lines accumulate into (shared with the error path).
 * @returns The invoke result.
 */
export async function handleInvoke(
  source: TroveSource,
  body: SourceInvokeBody,
  logs: string[],
): Promise<SourceInvokeResult> {
  const result = await runSource(source, {
    config: body.config ?? {},
    cursor: toWatermark(body.cursor),
    // Both of these used to be refusals. This shim was written when the SDK
    // spine had neither, and it said so in two error messages — one telling an
    // author with a credential to "run it from the Mac app", the other calling
    // a deadline a cloud-only capability. The spine grew `secret(name)` and
    // `deadline` and nobody came back, so the refusals outlived their reason
    // and were turning working sources away.
    //
    // `secrets` is a map in and `ctx.secret(name)` out: a source asks for a
    // credential by the name its manifest declares and cannot enumerate the
    // rest, which is the property that lets a refreshed OAuth token look
    // exactly like a pasted key to the code reading it.
    ...(body.credentials !== undefined && { secrets: body.credentials }),
    // Relative on the wire, absolute in the context. The runner computes the
    // budget on its own machine, so sending an instant would hand the run a
    // deadline from a clock it cannot check.
    ...(body.deadlineMs !== undefined && { deadline: Date.now() + body.deadlineMs }),
    // The global fetch, so the adapter gets the redirect policy whether it
    // reaches the network through `ctx.fetch` or through a helper.
    fetchImpl: (url: string | URL, init?: RequestInit): Promise<Response> =>
      globalThis.fetch(url, init),
    logSink: (args: unknown[]): void => {
      logs.push(args.map(String).join(' '));
    },
  });

  return {
    documents: result.documents.map(toWireDocument),
    ...(result.cursor.type !== 'none' && { cursor: result.cursor }),
    ...(result.stats === undefined ? {} : { stats: result.stats }),
    ...(result.feedName === undefined ? {} : { feedName: result.feedName }),
    ...(result.feedUrl === undefined ? {} : { feedUrl: result.feedUrl }),
    logs,
  };
}

/**
 * What a deployed module may default-export: a `defineSource(...)` result, or
 * the bare `sync` function that Trove's own bundled adapters have always
 * exported.
 *
 * Two shapes rather than one because the alternative was rewriting every
 * existing adapter to become deployable, which is a migration charged to
 * authors for a refactor's convenience. `defineSource` is what a new source
 * should use — it is where manifest typing and future capability live — but a
 * module that exports `sync` directly is not wrong, and refusing it would make
 * "can this run in the cloud" depend on which year it was written.
 */
export type DeployableSource = TroveSource | TroveSource['sync'];

/**
 * Normalise either accepted shape to the one `runSource` takes.
 *
 * @param source - Whatever the deployed module default-exported.
 * @returns A `TroveSource`.
 */
function asSource(source: DeployableSource): TroveSource {
  return typeof source === 'function' ? { sync: source } : source;
}

/**
 * Wrap a source as the hosted runtime's fetch handler.
 *
 * @param source - The author's default export: a `defineSource(...)` result or a bare `sync`.
 * @returns The worker the deployed module default-exports.
 */
export function createSourceWorker(source: DeployableSource): SourceWorker {
  const normalized = asSource(source);
  installRedirectPolicy();

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/sync')) {
        return new Response('not found', { status: 404 });
      }

      const logs: string[] = [];
      try {
        const body = (await request.json()) as SourceInvokeBody;
        return Response.json(await handleInvoke(normalized, body, logs));
      } catch (err) {
        // A 500 carrying the message and the logs so far. A run that
        // swallowed its error and answered `{documents: []}` would read to the
        // runner as a successful empty sync, and the cursor would advance past
        // whatever it failed to fetch.
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message, logs }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
  };
}
