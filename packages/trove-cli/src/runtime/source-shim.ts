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
   * declares none. Refused rather than used: see {@link assertNoCredentials}.
   */
  credentials?: Record<string, string>;
  /**
   * Where the last run got to — the watermark this source itself returned — or
   * `null` on a first run.
   */
  cursor?: unknown;
  /**
   * How long the isolate has. Not surfaced: `SourceContext` has no deadline
   * field, so an SDK source has nowhere to read it and inventing one here would
   * be a capability that only exists in the cloud, which is the one thing this
   * shim is for avoiding.
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
 * Refuse an invoke that carries secrets.
 *
 * `SourceContext` has no `credentials` channel — the SDK deliberately leaves it
 * out, and `ctx.config` is preferences-only, so smuggling secrets in there
 * would write them into the source's plaintext config. Dropping them silently
 * would be worse than either: the source would run, fail its upstream auth, and
 * report a 401 that points at the API rather than at the missing capability.
 *
 * @param credentials - The credentials the runner resolved.
 * @throws {Error} When any credential was supplied.
 */
function assertNoCredentials(credentials: Record<string, string> | undefined): void {
  const names = Object.keys(credentials ?? {});
  if (names.length === 0) return;
  throw new Error(
    `this deployment was given credentials (${names.join(', ')}), but a source written against ` +
      '@ontrove/sdk has no way to read them: sync(ctx) exposes preferences (ctx.config) and ' +
      'nothing else. Deploy a source that needs no secrets, or run it from the Mac app.',
  );
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
    ...(doc.url !== undefined && { url: doc.url }),
    ...(doc.author !== undefined && { author: doc.author }),
    ...(doc.date !== undefined && { date: doc.date }),
    ...(doc.tags !== undefined && { tags: doc.tags }),
    ...(doc.metadata !== undefined && { metadata: doc.metadata }),
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
  assertNoCredentials(body.credentials);

  const result = await runSource(source, {
    config: body.config ?? {},
    cursor: toWatermark(body.cursor),
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
    logs,
  };
}

/**
 * Wrap a source as the isolate's fetch handler.
 *
 * @param source - The author's `defineSource(...)` default export.
 * @returns The worker the deployed module default-exports.
 */
export function createSourceWorker(source: TroveSource): SourceWorker {
  installRedirectPolicy();

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/sync')) {
        return new Response('not found', { status: 404 });
      }

      const logs: string[] = [];
      try {
        const body = (await request.json()) as SourceInvokeBody;
        return Response.json(await handleInvoke(source, body, logs));
      } catch (err) {
        // A 500 carrying the message and the logs so far. An isolate that
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
