import { describe, expect, it } from 'vitest';
import { classifyError, GraphQLClient } from '../src/client.js';
import { ExitCode } from '../src/errors.js';
import { mockFetch } from './helpers.js';

describe('GraphQLClient', () => {
  it('posts to {apiUrl}/graphql with the bearer token and operation', async () => {
    const mock = mockFetch({ data: { stats: { totalDocuments: 5 } } });
    const client = new GraphQLClient({
      apiUrl: 'https://api.ontrove.sh',
      token: 'tok_xyz',
      fetchImpl: mock.fetch,
    });
    const data = await client.request<{ stats: { totalDocuments: number } }>({
      query: 'query CliStats { stats { totalDocuments } }',
      operationName: 'CliStats',
    });
    expect(data.stats.totalDocuments).toBe(5);
    expect(mock.calls[0]?.url).toBe('https://api.ontrove.sh/graphql');
    expect(mock.calls[0]?.authorization).toBe('Bearer tok_xyz');
    expect(mock.calls[0]?.operationName).toBe('CliStats');
  });

  it('strips a trailing slash from apiUrl', async () => {
    const mock = mockFetch({ data: { ok: true } });
    const client = new GraphQLClient({
      apiUrl: 'http://localhost:8787/',
      token: 't',
      fetchImpl: mock.fetch,
    });
    await client.request({ query: '{ ok }' });
    expect(mock.calls[0]?.url).toBe('http://localhost:8787/graphql');
  });

  it('throws a classified CliError on GraphQL errors[]', async () => {
    const mock = mockFetch({ errors: [{ message: 'Document not found' }] });
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl: mock.fetch });
    await expect(
      client.request({
        query: 'query CliGetDocument { document { id } }',
        operationName: 'CliGetDocument',
      }),
    ).rejects.toMatchObject({ code: ExitCode.NotFound });
  });

  it('maps HTTP 401 to an auth error', async () => {
    const mock = mockFetch({}, 401);
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl: mock.fetch });
    await expect(client.request({ query: '{ x }' })).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('maps HTTP 500 to a transport error', async () => {
    const mock = mockFetch({}, 500);
    const client = new GraphQLClient({
      apiUrl: 'https://x',
      token: 't',
      fetchImpl: mock.fetch,
      maxRetries: 0,
    });
    await expect(client.request({ query: '{ x }' }, true)).rejects.toMatchObject({
      code: ExitCode.Transport,
    });
  });

  it('retries idempotent reads on 5xx then succeeds', async () => {
    let count = 0;
    const fetchImpl = (async () => {
      count++;
      if (count < 2) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl, maxRetries: 2 });
    const data = await client.request<{ ok: boolean }>({ query: '{ ok }' }, true);
    expect(data.ok).toBe(true);
    expect(count).toBe(2);
  });

  it('requestEnvelope returns the raw {data,errors} without throwing', async () => {
    const mock = mockFetch({ data: null, errors: [{ message: 'boom' }] });
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl: mock.fetch });
    const env = await client.requestEnvelope({ query: '{ x }' });
    expect(env.errors?.[0]?.message).toBe('boom');
  });

  it('throws on malformed JSON', async () => {
    const fetchImpl = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl });
    await expect(client.request({ query: '{ x }' })).rejects.toMatchObject({
      code: ExitCode.Transport,
    });
  });

  it('throws a transport error on an empty (null data, no errors) response', async () => {
    const mock = mockFetch({ data: null });
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl: mock.fetch });
    await expect(client.request({ query: '{ x }', operationName: 'Op' })).rejects.toMatchObject({
      code: ExitCode.Transport,
    });
  });

  it('maps an unexpected non-ok status (404) to a transport error', async () => {
    const mock = mockFetch({}, 404);
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl: mock.fetch });
    await expect(client.request({ query: '{ x }' })).rejects.toMatchObject({
      code: ExitCode.Transport,
    });
  });

  it('accepts a 400 body (validation errors travel in errors[])', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'bad input' }] }), {
        status: 400,
      })) as unknown as typeof fetch;
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl });
    const env = await client.requestEnvelope({ query: '{ x }' });
    expect(env.errors?.[0]?.message).toBe('bad input');
  });

  it('wraps a thrown network error as a transport error after retries', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new GraphQLClient({ apiUrl: 'https://x', token: 't', fetchImpl, maxRetries: 1 });
    await expect(client.request({ query: '{ x }' }, true)).rejects.toMatchObject({
      code: ExitCode.Transport,
    });
  });

  it('refreshes the token on 401 and retries the request with the new one', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? '';
      seen.push(auth);
      if (auth === 'Bearer stale') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    let refreshCalls = 0;
    const client = new GraphQLClient({
      apiUrl: 'https://x',
      token: 'stale',
      fetchImpl,
      onAuthFailure: async () => {
        refreshCalls++;
        return 'fresh';
      },
    });
    const data = await client.request<{ ok: boolean }>({ query: '{ ok }' });
    expect(data.ok).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(seen).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('surfaces the auth error when no refresh is possible (hook returns null)', async () => {
    const mock = mockFetch({}, 401);
    let refreshCalls = 0;
    const client = new GraphQLClient({
      apiUrl: 'https://x',
      token: 't',
      fetchImpl: mock.fetch,
      onAuthFailure: async () => {
        refreshCalls++;
        return null;
      },
    });
    await expect(client.request({ query: '{ x }' })).rejects.toMatchObject({ code: ExitCode.Auth });
    expect(refreshCalls).toBe(1);
    // The original request plus nothing more — no retry when refresh yields no token.
    expect(mock.calls).toHaveLength(1);
  });

  it('does not loop when the refreshed token is also rejected', async () => {
    const mock = mockFetch({}, 401);
    let refreshCalls = 0;
    const client = new GraphQLClient({
      apiUrl: 'https://x',
      token: 't',
      fetchImpl: mock.fetch,
      onAuthFailure: async () => {
        refreshCalls++;
        return 'still-bad';
      },
    });
    await expect(client.request({ query: '{ x }' })).rejects.toMatchObject({ code: ExitCode.Auth });
    // Exactly one refresh attempt and one retry: original + retry = 2 round-trips.
    expect(refreshCalls).toBe(1);
    expect(mock.calls).toHaveLength(2);
  });
});

describe('classifyError', () => {
  it('classifies auth/admin via extensions.code', () => {
    expect(classifyError([{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }])).toBe(
      ExitCode.Auth,
    );
    expect(classifyError([{ message: 'Forbidden: not in ADMIN_EMAILS' }])).toBe(ExitCode.Auth);
  });

  it('classifies cursor CAS conflicts as retryable', () => {
    expect(classifyError([{ message: 'cursor mismatch (CAS conflict)' }])).toBe(ExitCode.Conflict);
  });

  it('classifies not-found and validation', () => {
    expect(classifyError([{ message: 'Document not found' }])).toBe(ExitCode.NotFound);
    expect(
      classifyError([{ message: 'invalid input', extensions: { code: 'BAD_USER_INPUT' } }]),
    ).toBe(ExitCode.Usage);
  });

  it('falls back to transport', () => {
    expect(classifyError([{ message: 'something weird' }])).toBe(ExitCode.Transport);
  });
});
