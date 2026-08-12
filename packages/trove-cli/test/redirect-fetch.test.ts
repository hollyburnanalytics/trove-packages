import { describe, expect, it } from 'vitest';
import { redirectFollowingFetch } from '../src/runtime/redirect-fetch.js';

/**
 * The redirect policy a deployed source's fetch runs under. Every hop must be a
 * separate call to the inner fetch — that is what keeps each one an individually
 * allowlist-checked subrequest — so these tests assert on the *sequence* of
 * inner calls, not just the final response.
 */

/** A scripted inner fetch: URL → response, recording every request it saw. */
function scriptedFetch(routes: Record<string, () => Response>): {
  fetch: typeof globalThis.fetch;
  seen: Request[];
} {
  const seen: Request[] = [];
  const fetchImpl = (async (input: Request): Promise<Response> => {
    seen.push(input);
    const route = routes[input.url];
    if (route === undefined) return new Response('unrouted', { status: 404 });
    return route();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, seen };
}

/** A redirect response pointing at `location`. */
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('redirectFollowingFetch', () => {
  it('returns a non-redirect response untouched, in one hop', async () => {
    const inner = scriptedFetch({ 'https://a.test/feed': () => new Response('ok') });
    const fetchImpl = redirectFollowingFetch(inner.fetch);
    const res = await fetchImpl('https://a.test/feed');
    expect(await res.text()).toBe('ok');
    expect(inner.seen).toHaveLength(1);
  });

  it('follows a relative redirect as a separate subrequest', async () => {
    const inner = scriptedFetch({
      'https://a.test/feed': () => redirect('/moved'),
      'https://a.test/moved': () => new Response('arrived'),
    });
    const res = await redirectFollowingFetch(inner.fetch)('https://a.test/feed');
    expect(await res.text()).toBe('arrived');
    expect(inner.seen.map((r) => r.url)).toEqual(['https://a.test/feed', 'https://a.test/moved']);
  });

  it('keeps credentials on a same-origin hop', async () => {
    const inner = scriptedFetch({
      'https://a.test/one': () => redirect('https://a.test/two'),
      'https://a.test/two': () => new Response('ok'),
    });
    await redirectFollowingFetch(inner.fetch)('https://a.test/one', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(inner.seen[1]?.headers.get('authorization')).toBe('Bearer secret');
  });

  it('strips credentials when the origin changes', async () => {
    const inner = scriptedFetch({
      'https://a.test/one': () => redirect('https://b.test/two'),
      'https://b.test/two': () => new Response('ok'),
    });
    await redirectFollowingFetch(inner.fetch)('https://a.test/one', {
      headers: { authorization: 'Bearer secret', cookie: 'session=1', accept: 'text/html' },
    });
    expect(inner.seen[1]?.headers.get('authorization')).toBeNull();
    expect(inner.seen[1]?.headers.get('cookie')).toBeNull();
    // Everything that does not authenticate us survives the hop.
    expect(inner.seen[1]?.headers.get('accept')).toBe('text/html');
  });

  it('turns a 303 into a GET and drops the body', async () => {
    const inner = scriptedFetch({
      'https://a.test/submit': () => redirect('https://a.test/result', 303),
      'https://a.test/result': () => new Response('ok'),
    });
    await redirectFollowingFetch(inner.fetch)('https://a.test/submit', {
      method: 'POST',
      body: 'x=1',
    });
    expect(inner.seen[1]?.method).toBe('GET');
    expect(inner.seen[1]?.body).toBeNull();
  });

  it('replays a buffered body across a 307 (the stream is already consumed)', async () => {
    const inner = scriptedFetch({
      'https://a.test/submit': () => redirect('https://a.test/elsewhere', 307),
      'https://a.test/elsewhere': () => new Response('ok'),
    });
    await redirectFollowingFetch(inner.fetch)('https://a.test/submit', {
      method: 'POST',
      body: 'x=1',
    });
    expect(inner.seen[1]?.method).toBe('POST');
    expect(await (inner.seen[1] as Request).text()).toBe('x=1');
  });

  it('treats a redirect with no Location header as the final response', async () => {
    const inner = scriptedFetch({
      'https://a.test/x': () => new Response('body', { status: 302 }),
    });
    const res = await redirectFollowingFetch(inner.fetch)('https://a.test/x');
    expect(res.status).toBe(302);
    expect(inner.seen).toHaveLength(1);
  });

  it('accepts a chain that ends on the last allowed hop', async () => {
    const inner = scriptedFetch({
      'https://a.test/one': () => redirect('/two'),
      'https://a.test/two': () => new Response('arrived'),
    });
    const res = await redirectFollowingFetch(inner.fetch, 1)('https://a.test/one');
    expect(await res.text()).toBe('arrived');
  });

  it('gives up rather than looping forever', async () => {
    const inner = scriptedFetch({ 'https://a.test/loop': () => redirect('/loop') });
    await expect(redirectFollowingFetch(inner.fetch, 2)('https://a.test/loop')).rejects.toThrow(
      /too many redirects \(2\)/,
    );
    // maxHops hops plus the final attempt that proved it was still redirecting.
    expect(inner.seen).toHaveLength(3);
  });
});
