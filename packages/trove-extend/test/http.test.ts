import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublicHttpUrl,
  fetchBytes,
  fetchPage,
  fetchPageWithMeta,
  HttpStatusError,
  isTooLargeError,
  MAX_RESPONSE_BYTES,
  TROVE_USER_AGENT,
} from '../src/http.js';
import type { FetchLike } from '../src/types.js';

/** A mock fetch that answers every request the same way. */
function always(response: () => Response) {
  return vi.fn((_url: string | URL, _init?: RequestInit) => Promise.resolve(response()));
}

/** A mock fetch that answers per URL. */
function routed(route: (url: string) => Response) {
  return vi.fn((url: string | URL, _init?: RequestInit) => Promise.resolve(route(String(url))));
}

/** A Response whose body streams `chunks` and declares no Content-Length. */
function streamingResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

/** A redirect response — what `redirect: 'manual'` surfaces to the caller. */
function redirect(status: number, location?: string): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}

describe('guarded fetch', () => {
  it('returns the response body as text', async () => {
    const fetch = always(() => new Response('hello world'));
    expect(await fetchPage('https://example.com/page', { fetch })).toBe('hello world');
  });

  it('sends the honest bot User-Agent', async () => {
    const fetch = always(() => new Response('ok'));
    await fetchPage('https://example.com/', { fetch });
    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(TROVE_USER_AGENT);
    expect(headers['User-Agent']).toContain('TroveBot');
  });

  it('merges extra headers over the defaults instead of replacing them', async () => {
    const fetch = always(() => new Response('ok'));
    await fetchPage('https://example.com/', { fetch, headers: { Authorization: 'Bearer x' } });
    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer x');
    expect(headers['User-Agent']).toBe(TROVE_USER_AGENT);
  });

  it('throws on a non-200 response, carrying the status', async () => {
    const fetch = always(() => new Response('', { status: 503 }));
    const error = await fetchPage('https://example.com/down', { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(503);
    expect((error as Error).message).toContain('HTTP 503');
    expect(isTooLargeError(error)).toBe(false);
  });

  it('fails clearly on a 200 with no body at all', async () => {
    const fetch = always(() => new Response(null, { status: 200 }));
    await expect(fetchBytes('https://example.com/empty', { fetch })).rejects.toThrow(
      /no body fetching/,
    );
  });

  it('returns the raw response bytes', async () => {
    const payload = new Uint8Array([37, 80, 68, 70, 0, 255]);
    const fetch = always(() => streamingResponse([payload]));
    expect([...(await fetchBytes('https://example.com/file.pdf', { fetch }))]).toEqual([
      ...payload,
    ]);
  });

  it('rejects a declared Content-Length above the cap with a too-large error', async () => {
    const fetch = always(
      () => new Response('tiny', { headers: { 'content-length': '99999999999' } }),
    );
    const error = await fetchPage('https://example.com/big', { fetch }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('too large');
    expect(isTooLargeError(error)).toBe(true);
    // The cap is declared-length only here; nothing was streamed.
    expect(MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('rejects a streamed body that exceeds maxBytes, mid-body', async () => {
    const chunk = new Uint8Array(64);
    const fetch = always(() => streamingResponse([chunk, chunk, chunk]));
    const error = await fetchBytes('https://example.com/stream', { fetch, maxBytes: 100 }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain('exceeded');
    expect(isTooLargeError(error)).toBe(true);
  });

  it('accepts a streamed body that stays under maxBytes', async () => {
    const fetch = always(() => streamingResponse([new Uint8Array([1, 2]), new Uint8Array([3])]));
    expect([...(await fetchBytes('https://example.com/s', { fetch, maxBytes: 100 }))]).toEqual([
      1, 2, 3,
    ]);
  });

  it('isTooLargeError is false for ordinary errors and for nothing at all', () => {
    expect(isTooLargeError(new Error('HTTP 404'))).toBe(false);
    expect(isTooLargeError()).toBe(false);
    expect(isTooLargeError('boom')).toBe(false);
    expect(isTooLargeError({ code: 'ENOTFOUND' })).toBe(false);
  });

  it('aborts the request when the deadline passes', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by deadline')));
      });
    await expect(fetchPage('https://slow.test/', { fetch, timeoutMs: 1 })).rejects.toThrow(
      'aborted by deadline',
    );
  });
});

describe('SSRF guard', () => {
  it.each([
    'https://localhost/admin',
    'https://127.0.0.1/metadata',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/internal',
    'https://192.168.1.1/router',
    'https://172.16.0.1/internal',
    'https://100.64.0.1/cgnat',
    'https://0.0.0.0/this-host',
    'https://[::1]/loopback',
    // IPv6 forms carrying a v4 address: mapped, compatible, and unspecified.
    'https://[::ffff:127.0.0.1]/mapped-loopback',
    'https://[::ffff:10.0.0.1]/mapped-private',
    'https://[::127.0.0.1]/compatible-loopback',
    'https://[::]/unspecified',
    // Non-dotted spellings of 127.0.0.1: the URL parser normalizes each one
    // back to dotted-quad before the guard sees it.
    'http://2130706433/decimal',
    'http://0x7f000001/hex',
    'http://127.1/short',
    'https://[fd00::1]/ula',
    'https://[fe80::1]/link-local',
    'https://backend.internal/api',
    'https://printer.local/status',
    'file:///etc/passwd',
    'not a url',
  ])('refuses to fetch %s', async (url) => {
    const fetch = always(() => new Response('should never be reached'));
    await expect(fetchBytes(url, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.com/page',
    'https://11.0.0.1/public',
    'https://172.32.0.1/public',
    'https://192.169.0.1/public',
    'https://100.128.0.1/public',
    'https://169.253.0.1/public',
    // Four labels, none numeric: the octet parse bails, and the host is public.
    'https://a.b.c.d/public',
    'http://example.com/plain-http',
    'https://[2606:4700::1111]/global-unicast-v6',
  ])('permits %s', async (url) => {
    const fetch = always(() => new Response('ok'));
    expect(await fetchPage(url, { fetch })).toBe('ok');
  });

  it('is exported so an address can be refused when it is entered', () => {
    expect(() => assertPublicHttpUrl('https://example.com')).not.toThrow();
    expect(() => assertPublicHttpUrl('https://127.0.0.1')).toThrow(/private or loopback/);
    expect(() => assertPublicHttpUrl('ftp://example.com')).toThrow(/non-HTTP/);
    expect(() => assertPublicHttpUrl('nonsense')).toThrow(/Invalid URL/);
  });
});

describe('the fetch it uses', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('falls back to the global fetch, resolved at call time', async () => {
    // The global is installed AFTER this module was imported — a host that
    // guards egress by replacing it must still be the one that gets called.
    const fetch = always(() => new Response('from the global'));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    expect(await fetchPage('https://example.com/')).toBe('from the global');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Redirects are followed by hand so a PERMANENT move can be told from a routine
 * one. Getting this wrong in either direction is costly: miss a 301 and
 * subscriptions rot; treat a 302 as a move and healthy ones get rewritten.
 */
describe('redirects', () => {
  it('follows a redirect and returns the final body', async () => {
    const fetch = routed((url) =>
      url === 'https://old.test/f' ? redirect(301, 'https://new.test/f') : new Response('moved'),
    );
    expect(await fetchPage('https://old.test/f', { fetch })).toBe('moved');
  });

  it.each([301, 308])('reports a %i as a permanent move', async (status) => {
    const fetch = routed((url) =>
      url === 'https://old.test/f' ? redirect(status, 'https://new.test/f') : new Response('body'),
    );
    const meta = await fetchPageWithMeta('https://old.test/f', { fetch });
    expect(meta.movedPermanentlyTo).toBe('https://new.test/f');
  });

  it.each([302, 303, 307])('does NOT report a %i as a move', async (status) => {
    // Routine CDN routing. Treating it as a move would rewrite a healthy
    // subscription to wherever the load balancer pointed today.
    const fetch = routed((url) =>
      url === 'https://s.test/f' ? redirect(status, 'https://edge-7.test/f') : new Response('body'),
    );
    const meta = await fetchPageWithMeta('https://s.test/f', { fetch });
    expect(meta.text).toBe('body');
    expect(meta.movedPermanentlyTo).toBeUndefined();
  });

  it('stops counting at the first non-permanent hop', async () => {
    // 301 -> 302: the resource permanently moved ONCE. Following further is
    // fine, but the new home is the 302's origin, not past it.
    const chain: Record<string, Response> = {
      'https://a.test/f': redirect(301, 'https://b.test/f'),
      'https://b.test/f': redirect(302, 'https://c.test/f'),
    };
    const fetch = routed((url) => chain[url] ?? new Response('body'));
    const meta = await fetchPageWithMeta('https://a.test/f', { fetch });
    expect(meta.movedPermanentlyTo).toBe('https://b.test/f');
  });

  it('follows a chain of permanent hops to its end', async () => {
    const chain: Record<string, Response> = {
      'https://a.test/f': redirect(301, 'https://b.test/f'),
      'https://b.test/f': redirect(308, 'https://c.test/f'),
    };
    const fetch = routed((url) => chain[url] ?? new Response('body'));
    const meta = await fetchPageWithMeta('https://a.test/f', { fetch });
    expect(meta.movedPermanentlyTo).toBe('https://c.test/f');
  });

  it('re-applies the SSRF guard to every hop', async () => {
    // A redirect chain is the classic way past a guard applied only to the URL
    // the caller supplied.
    const fetch = always(() => redirect(301, 'https://169.254.169.254/latest/meta-data/'));
    await expect(fetchPage('https://evil.test/f', { fetch })).rejects.toThrow(
      /private or loopback/,
    );
  });

  it('refuses a hop to a non-HTTP scheme', async () => {
    const fetch = always(() => redirect(301, 'file:///etc/passwd'));
    await expect(fetchPage('https://evil.test/f', { fetch })).rejects.toThrow(/non-HTTP/);
  });

  it('resolves a relative Location against the current URL', async () => {
    const seen: string[] = [];
    const fetch = routed((url) => {
      seen.push(url);
      return seen.length === 1 ? redirect(301, '/moved/f.xml') : new Response('body');
    });
    await fetchPage('https://s.test/deep/f.xml', { fetch });
    expect(seen[1]).toBe('https://s.test/moved/f.xml');
  });

  it('gives up rather than looping forever', async () => {
    const fetch = routed((url) =>
      redirect(301, url === 'https://a.test/f' ? 'https://b.test/f' : 'https://a.test/f'),
    );
    await expect(fetchPage('https://a.test/f', { fetch })).rejects.toThrow(/Too many redirects/);
  });

  it('fails clearly on a redirect with no Location', async () => {
    const fetch = always(() => redirect(301));
    await expect(fetchPage('https://s.test/f', { fetch })).rejects.toThrow(/no Location/);
  });

  it('fails clearly on a redirect whose Location cannot be resolved', async () => {
    const fetch = always(() => redirect(301, 'http://['));
    await expect(fetchPage('https://s.test/f', { fetch })).rejects.toThrow(/unusable Location/);
  });

  it('reports no move for an ordinary 200', async () => {
    const fetch = always(() => new Response('body'));
    const meta = await fetchPageWithMeta('https://s.test/f', { fetch });
    expect(meta.movedPermanentlyTo).toBeUndefined();
  });

  it('still returns bytes through a redirect for fetchBytes', async () => {
    const fetch = routed((url) =>
      url === 'https://old.test/f.pdf'
        ? redirect(301, 'https://new.test/f.pdf')
        : new Response(new Uint8Array([1, 2, 3])),
    );
    expect([...(await fetchBytes('https://old.test/f.pdf', { fetch }))]).toEqual([1, 2, 3]);
  });
});
