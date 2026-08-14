/**
 * The redirect policy a deployed source's `fetch` runs under.
 *
 * Split out of {@link module:runtime/source-shim} because it is the one piece
 * of the shim that is about *security* rather than about adapting a call
 * shape, and it is worth reading (and testing) on its own.
 *
 * A deployed source reaches only the hosts its manifest declares, and that
 * allowlist is enforced per subrequest as the hosted runtime's traffic leaves. A
 * runtime that auto-follows redirects makes the later hops inside one
 * subrequest, so only the FIRST hop is checked — an allowed host could then
 * redirect the hosted runtime anywhere. Following each hop by hand keeps every hop a
 * fresh, individually-checked subrequest.
 *
 * Refusing redirects outright would be simpler and is not an option: feedburner,
 * apex-to-www and CDN hops are what ordinary feeds are made of.
 *
 * @module
 */

/** How many redirects one call follows before it gives up. */
const MAX_REDIRECT_HOPS = 5;

/** Headers that authenticate us, and so must not survive an origin change. */
const CREDENTIAL_HEADERS: readonly string[] = ['authorization', 'cookie', 'proxy-authorization'];

/** One step of a redirect chain: where we are going and how. */
interface Hop {
  /** The absolute URL of this hop. */
  url: string;
  /** The HTTP method to use for it. */
  method: string;
  /** The headers to send (credentials already stripped where required). */
  headers: Headers;
  /** The origin this hop belongs to, for the cross-origin credential check. */
  origin: string;
}

/**
 * Where a response redirects to, or `null` when it is not a redirect.
 *
 * @param response - The response just received.
 * @returns The `Location` header, when this is a redirect that names one.
 */
function redirectTarget(response: Response): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  return response.headers.get('location');
}

/**
 * Work out the next hop from a redirect response.
 *
 * @param hop - The hop that was redirected.
 * @param status - The redirect status code.
 * @param location - The `Location` header value (absolute or relative).
 * @returns The hop to try next.
 */
function nextHop(hop: Hop, status: number, location: string): Hop {
  const next = new URL(location, hop.url);
  const headers = new Headers(hop.headers);
  let origin = hop.origin;

  // A redirect is an instruction from the server we were talking to. Honouring
  // it with the credentials meant for THAT host hands them to whoever it names
  // — which, for a source, is the user's own API key.
  if (next.origin !== origin) {
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    origin = next.origin;
  }

  // 303, and 301/302 on a POST, become GET — per fetch semantics, and because
  // replaying a body across a redirect is how a write happens twice.
  const method = status === 303 || (hop.method === 'POST' && status < 303) ? 'GET' : hop.method;
  return { url: next.toString(), method, headers, origin };
}

/**
 * Build the request for one hop, carrying the body only where the method takes
 * one.
 *
 * @param hop - The hop to request.
 * @param body - The buffered request body, or `null` when there is none.
 * @returns The request to send.
 */
function requestFor(hop: Hop, body: ArrayBuffer | null): Request {
  const carriesBody = body !== null && hop.method !== 'GET' && hop.method !== 'HEAD';
  return new Request(hop.url, {
    method: hop.method,
    headers: hop.headers,
    ...(carriesBody ? { body } : {}),
    redirect: 'manual',
  });
}

/**
 * Wrap a `fetch` so it follows redirects one subrequest at a time.
 *
 * The wrapper is installed over the GLOBAL fetch rather than only handed to the
 * adapter as `ctx.fetch`, because helper libraries an adapter pulls in call
 * bare `fetch()` — a policy the adapter has to opt into is a policy the code
 * most adapters actually use would bypass.
 *
 * @param inner - The platform fetch to send each hop through.
 * @param maxHops - How many redirects to follow before failing.
 * @returns A fetch with the per-hop redirect policy applied.
 */
export function redirectFollowingFetch(
  inner: typeof globalThis.fetch,
  maxHops: number = MAX_REDIRECT_HOPS,
): typeof globalThis.fetch {
  return async function fetchFollowingRedirects(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const initial = new Request(input, { ...init, redirect: 'manual' });
    // Buffered, not streamed: sending a Request consumes its body, so a POST
    // that gets a 307 would re-send a stream that has already been read and
    // fail on the second hop. Source request bodies are API queries, so holding
    // one in memory costs nothing.
    const body =
      initial.method === 'GET' || initial.method === 'HEAD' ? null : await initial.arrayBuffer();

    let hop: Hop = {
      url: initial.url,
      method: initial.method,
      headers: new Headers(initial.headers),
      origin: new URL(initial.url).origin,
    };

    for (let i = 0; i < maxHops; i++) {
      const response = await inner(requestFor(hop, body));
      const location = redirectTarget(response);
      if (location === null) return response;
      hop = nextHop(hop, response.status, location);
    }

    // The last allowed attempt. Answering it with another redirect is one hop
    // too many, and is reported rather than followed — a redirect loop that
    // silently returned the 3xx would read to the adapter as an empty page.
    const final = await inner(requestFor(hop, body));
    if (redirectTarget(final) !== null) {
      throw new Error(`too many redirects (${String(maxHops)}) from ${hop.url}`);
    }
    return final;
  };
}
