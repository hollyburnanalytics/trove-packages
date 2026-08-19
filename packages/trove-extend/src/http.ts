/**
 * The guarded HTTP seam a source should fetch through: an honest bot
 * User-Agent, a hard per-request timeout, a response-size cap enforced both on
 * the declared length and while the body streams, and an SSRF guard that
 * refuses non-public hosts — on the URL given AND on every redirect hop.
 *
 * A source does not choose most of what it fetches. The address comes from a
 * feed's link, a page's href, or a `Location` header, so every target is
 * treated as untrusted: a hostile or merely compromised publisher must not be
 * able to aim a sync run at loopback, a private range, or a cloud metadata
 * endpoint.
 *
 * Each helper takes the `fetch` to use and defaults to the global one, so a
 * source running inside a host that hands it a guarded `fetch` keeps using
 * that one, while the same code still runs on a laptop.
 *
 * @module
 */

import type { FetchLike } from './types.js';

/**
 * Descriptive, attributable User-Agent. A site operator who wants to identify
 * or rate-limit this traffic can, which is the difference between a bot that
 * is welcome and one that gets blocked.
 */
export const TROVE_USER_AGENT = 'TroveBot/1.0 (+https://ontrove.sh)';

/** Default response-size cap: large enough for a long article, small enough that one page cannot exhaust a run. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Per-request ceiling. Without it a single slow or hung host stalls an entire
 * sync run for minutes. A bounded request fails fast and is retried next run.
 */
export const FETCH_TIMEOUT_MS = 20_000;

/** Redirect hops followed before giving up. Feeds need far fewer than a browser. */
export const MAX_REDIRECTS = 5;

const HEADERS: Record<string, string> = {
  'User-Agent': TROVE_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** Statuses that mean "this resource has permanently moved". */
const PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);

/** Statuses that are a redirect at all. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Whether an IPv4/IPv6 host sits in a private, loopback, or link-local range.
 *
 * @param host - The hostname, lowercased and with any IPv6 brackets stripped.
 * @returns True when it must not be fetched.
 */
function isPrivateHost(host: string): boolean {
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  // Every IPv6 address beginning `::` is special: the unspecified address, and
  // the IPv4-mapped and IPv4-compatible forms that smuggle a private v4 address
  // past the dotted-quad test below — `[::ffff:127.0.0.1]` normalizes to
  // `::ffff:7f00:1`, which has no dots left to check. Global unicast is
  // 2000::/3, so nothing reachable on the public web starts this way.
  if (host.startsWith('::')) return true;
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 255)) return false;
  // Defaults that match nothing below: the length check above already
  // guarantees four octets, and destructuring cannot see that.
  const [first = -1, second = -1] = numbers;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) || // link-local, incl. the 169.254.169.254 metadata IP
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) // CGNAT
  );
}

/**
 * Guard an address before fetching it. Only public web pages are ever wanted,
 * so require http(s) and reject private, loopback, and link-local hosts.
 *
 * Exported because a source that accepts an address from its own configuration
 * should refuse a bad one when it is entered, not on the first sync.
 *
 * @param target - The address about to be fetched.
 * @returns Nothing; it throws when the target is not a public web page.
 */
export function assertPublicHttpUrl(target: string): void {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`Invalid URL: ${target}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing non-HTTP(S) URL: ${target}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateHost(host)
  ) {
    throw new Error(`Refusing to fetch private or loopback host: ${host}`);
  }
}

/**
 * Marker for a response rejected by the size cap. Kept as a plain string code
 * rather than only a class so that an error crossing a runtime boundary — a
 * sandboxed source, a serialized result — still classifies correctly, where an
 * `instanceof` check would silently say "no".
 */
const TOO_LARGE_CODE = 'ERESPONSETOOLARGE';

/**
 * A response rejected by the size cap: a permanent condition (the resource is
 * simply too big), unlike a timeout or connection error that may succeed on
 * retry. Callers branch on {@link isTooLargeError} rather than on this class.
 */
export class ResponseTooLargeError extends Error {
  /** The stable marker {@link isTooLargeError} tests for. */
  readonly code: string = TOO_LARGE_CODE;

  /**
   * @param message - What was too large, and by which of the two caps.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * A response that arrived intact but was not OK. Carries the status so retry
 * logic can tell a transient 503 from a permanent 404 without parsing prose.
 */
export class HttpStatusError extends Error {
  /** The HTTP status the server returned. */
  readonly status: number;

  /**
   * @param status - The HTTP status the server returned.
   * @param url - The address that returned it, so the message names the target.
   */
  constructor(status: number, url: string) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * Whether an error from these helpers was a size-cap rejection — the one
 * failure worth treating as permanent (skip the document) rather than
 * transient (retry next run).
 *
 * @param error - Whatever was thrown; anything else answers false.
 * @returns True for the permanent "too large" condition.
 */
export function isTooLargeError(error?: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === TOO_LARGE_CODE;
}

/** Options shared by every helper here. */
export interface GuardedFetchOptions {
  /**
   * Raise the size cap for a document class that is legitimately larger than
   * an article — a podcast feed carries every episode ever published, and the
   * busiest run past 17 MB against the 10 MB default.
   */
  maxBytes?: number;
  /** Extra request headers, merged OVER the defaults rather than replacing them. */
  headers?: Record<string, string>;
  /**
   * The `fetch` to call. Pass the one the host handed the source, so its own
   * egress rules still apply; omit it and the global one is read at call time
   * (not at import time, so a host that installs its own afterwards still wins).
   */
  fetch?: FetchLike;
  /** Override the per-request ceiling for a host known to be slow. */
  timeoutMs?: number;
}

/** What a fetch learned about the address itself, alongside the body. */
export interface FetchedPage {
  /** The decoded body. */
  text: string;
  /**
   * Where the resource says it now lives — set only when the chain began with
   * 301/308. A caller that tracks where a subscription points reads this.
   */
  movedPermanentlyTo?: string;
}

/**
 * Follow redirects by hand, so a **permanent** move can be told from a routine
 * one, and so every hop is re-checked against the SSRF guard.
 *
 * `fetch` follows redirects transparently and reports only the final URL, which
 * cannot distinguish 301 (the resource moved; update your records) from 302 (a
 * CDN routing you somewhere today). Treating the latter as a move would corrupt
 * healthy subscriptions, so the distinction has to be made here.
 *
 * The permanent target is the URL reached by the **leading run** of permanent
 * hops. A 301 followed by a 302 has permanently moved once — to the 302's
 * origin, not past it.
 *
 * @param url - The starting address, already guarded.
 * @param signal - Aborts the whole chain when the request deadline passes.
 * @param call - The fetch implementation to use for every hop.
 * @param extraHeaders - Merged over the defaults.
 * @returns The first non-redirect response, the URL that produced it, and the
 *   permanent target when there was one.
 */
async function fetchFollowing(
  url: string,
  signal: AbortSignal,
  call: FetchLike,
  extraHeaders?: Record<string, string>,
): Promise<{ response: Response; url: string; movedPermanentlyTo?: string }> {
  // Merged over the defaults rather than replacing them, so a caller adding one
  // header does not silently drop the honest User-Agent or Accept.
  const headers = extraHeaders ? { ...HEADERS, ...extraHeaders } : HEADERS;
  let current = url;
  let isPermanentSoFar = true;
  let movedPermanentlyTo: string | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await call(current, { headers, signal, redirect: 'manual' });
    if (!REDIRECTS.has(response.status)) {
      return { response, url: current, ...(movedPermanentlyTo && { movedPermanentlyTo }) };
    }

    const location = response.headers.get('location');
    if (!location) throw new Error(`HTTP ${response.status} with no Location fetching ${current}`);

    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      throw new Error(`HTTP ${response.status} with an unusable Location fetching ${current}`);
    }
    // Every hop is a fresh fetch target chosen by the upstream, so every hop is
    // re-checked. A redirect chain is the classic way past a guard applied only
    // to the URL a caller supplied.
    assertPublicHttpUrl(next);

    if (isPermanentSoFar && PERMANENT_REDIRECTS.has(response.status)) movedPermanentlyTo = next;
    else isPermanentSoFar = false;

    current = next;
  }
  throw new Error(`Too many redirects (${MAX_REDIRECTS}) fetching ${url}`);
}

/**
 * Join the streamed chunks. Written by hand rather than with a Node buffer so
 * the same code runs in a browser-shaped runtime, where there is no Buffer.
 *
 * @param chunks - The pieces, in arrival order.
 * @param totalBytes - Their combined length, already counted by the caller.
 * @returns One contiguous view of the body.
 */
function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * Fetch and return the raw response bytes, enforcing `maxBytes` twice: on the
 * declared Content-Length, and again while reading — a server is free to
 * declare nothing, or to declare a lie.
 *
 * @param url - The address, already guarded.
 * @param maxBytes - The ceiling both checks enforce.
 * @param signal - The request deadline.
 * @param call - The fetch implementation to use.
 * @param headers - Extra headers, merged over the defaults.
 * @returns The body bytes, and the permanent target when there was one.
 */
async function fetchCappedBytes(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  call: FetchLike,
  headers?: Record<string, string>,
): Promise<{ bytes: Uint8Array; movedPermanentlyTo?: string }> {
  const { response, movedPermanentlyTo } = await fetchFollowing(url, signal, call, headers);
  if (!response.ok) throw new HttpStatusError(response.status, url);

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new ResponseTooLargeError(`Response too large (${contentLength} bytes) for ${url}`);
  }

  // A 200 with no body at all is not something to stream: `getReader()` on it
  // throws a bare "cannot read properties of null", naming neither the URL nor
  // the condition.
  if (!response.body) throw new Error(`HTTP ${response.status} with no body fetching ${url}`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      // Cancelling frees the connection; its own failure is irrelevant and must
      // not replace the reason we are here.
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(`Response exceeded ${maxBytes} bytes for ${url}`);
    }
    chunks.push(value);
  }
  return {
    bytes: concatChunks(chunks, totalBytes),
    ...(movedPermanentlyTo && { movedPermanentlyTo }),
  };
}

/**
 * Read at call time, never at import time: a host that installs its own guarded
 * global after this module loads must still be the one that gets called.
 *
 * @param options - Where a caller-supplied fetch would be.
 * @returns The fetch to use.
 */
function resolveFetch(options: GuardedFetchOptions): FetchLike {
  const supplied = options.fetch;
  if (supplied) return supplied;
  return (url: string | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init);
}

/**
 * Run one guarded request under a deadline, then always clear the timer — an
 * uncleared one keeps a runtime alive after the work is done.
 *
 * @param url - The address to fetch.
 * @param options - Cap, headers, fetch, and timeout overrides.
 * @returns The body bytes, and the permanent target when there was one.
 */
async function guardedRequest(
  url: string,
  options: GuardedFetchOptions,
): Promise<{ bytes: Uint8Array; movedPermanentlyTo?: string }> {
  assertPublicHttpUrl(url);
  const { maxBytes = MAX_RESPONSE_BYTES, timeoutMs = FETCH_TIMEOUT_MS, headers } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchCappedBytes(url, maxBytes, controller.signal, resolveFetch(options), headers);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a page and return its text, with the honest bot User-Agent, the SSRF
 * guard, the deadline, and the size cap. Throws on a non-200.
 *
 * A cap rejection throws an error {@link isTooLargeError} recognizes, so a
 * caller can treat it as permanent rather than retry it forever.
 *
 * @param url - The address to fetch.
 * @param options - Cap, headers, fetch, and timeout overrides.
 * @returns The decoded body.
 */
export async function fetchPage(url: string, options: GuardedFetchOptions = {}): Promise<string> {
  const { text } = await fetchPageWithMeta(url, options);
  return text;
}

/**
 * {@link fetchPage} plus what the fetch learned about the address itself.
 *
 * `movedPermanentlyTo` is set only when the chain began with 301/308 — the
 * resource announcing a new home, as opposed to a 302 routing this request
 * somewhere today. Callers that track where a subscription lives read this;
 * everyone else uses {@link fetchPage} and never sees it.
 *
 * @param url - The address to fetch.
 * @param options - Cap, headers, fetch, and timeout overrides.
 * @returns The decoded body and, when the resource moved, its new home.
 */
export async function fetchPageWithMeta(
  url: string,
  options: GuardedFetchOptions = {},
): Promise<FetchedPage> {
  const { bytes, movedPermanentlyTo } = await guardedRequest(url, options);
  return {
    text: new TextDecoder().decode(bytes),
    ...(movedPermanentlyTo && { movedPermanentlyTo }),
  };
}

/**
 * Binary twin of {@link fetchPage}: same guard, User-Agent, deadline, and
 * streamed size cap, but returns the raw bytes — for document downloads (PDFs,
 * images, audio) where decoding to text would corrupt the payload.
 *
 * @param url - The address to fetch.
 * @param options - Cap, headers, fetch, and timeout overrides.
 * @returns The body bytes, exactly as received.
 */
export async function fetchBytes(
  url: string,
  options: GuardedFetchOptions = {},
): Promise<Uint8Array> {
  const { bytes } = await guardedRequest(url, options);
  return bytes;
}
