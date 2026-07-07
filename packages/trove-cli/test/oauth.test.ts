import { describe, expect, it } from 'vitest';
import { CliError, ExitCode } from '../src/errors.js';
import {
  type AuthServerMetadata,
  buildAuthorizeUrl,
  discoverAuthServer,
  exchangeCode,
  generatePkce,
  type LoopbackHandle,
  loopbackStart,
  refreshAccessToken,
  registerClient,
  runLoginFlow,
} from '../src/lib/oauth.js';

/** A fetch mock that routes by URL substring to a JSON body + status. */
function routeFetch(
  routes: Array<{ match: string; body?: unknown; status?: number; text?: string }>,
): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const META: AuthServerMetadata = {
  issuer: 'https://accounts.example.com',
  authorization_endpoint: 'https://accounts.example.com/authorize',
  token_endpoint: 'https://accounts.example.com/token',
  registration_endpoint: 'https://accounts.example.com/register',
};

describe('generatePkce', () => {
  it('produces a verifier and a base64url challenge', () => {
    const pkce = generatePkce();
    expect(pkce.verifier.length).toBeGreaterThan(20);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).not.toContain('=');
  });
});

describe('discoverAuthServer', () => {
  it('follows protected-resource → authorization-server metadata', async () => {
    const fetchImpl = routeFetch([
      {
        match: 'oauth-protected-resource',
        body: { authorization_servers: ['https://accounts.example.com/'] },
      },
      { match: 'oauth-authorization-server', body: META },
    ]);
    const meta = await discoverAuthServer(fetchImpl, 'https://api.example.com/');
    expect(meta.token_endpoint).toBe(META.token_endpoint);
  });

  it('throws when no authorization server is advertised', async () => {
    const fetchImpl = routeFetch([{ match: 'oauth-protected-resource', body: {} }]);
    await expect(discoverAuthServer(fetchImpl, 'https://api.example.com')).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('throws on a non-2xx discovery response', async () => {
    const fetchImpl = routeFetch([{ match: 'oauth-protected-resource', body: {}, status: 500 }]);
    await expect(discoverAuthServer(fetchImpl, 'https://api.example.com')).rejects.toMatchObject({
      code: ExitCode.Transport,
    });
  });

  it('throws on a non-JSON discovery body', async () => {
    const fetchImpl = routeFetch([{ match: 'oauth-protected-resource', text: 'not json' }]);
    await expect(discoverAuthServer(fetchImpl, 'https://api.example.com')).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('throws when the auth-server metadata omits endpoints', async () => {
    const fetchImpl = routeFetch([
      {
        match: 'oauth-protected-resource',
        body: { authorization_servers: ['https://as.example.com'] },
      },
      { match: 'oauth-authorization-server', body: { issuer: 'x' } },
    ]);
    await expect(discoverAuthServer(fetchImpl, 'https://api.example.com')).rejects.toBeInstanceOf(
      CliError,
    );
  });
});

describe('buildAuthorizeUrl', () => {
  it('encodes the PKCE challenge and loopback redirect', () => {
    const url = new URL(
      buildAuthorizeUrl(META, {
        clientId: 'trove-cli',
        redirectUri: 'http://127.0.0.1:5555/callback',
        scope: 'openid',
        state: 'st',
        challenge: 'chal',
      }),
    );
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555/callback');
  });
});

describe('exchangeCode', () => {
  it('returns the access token on success', async () => {
    const fetchImpl = routeFetch([{ match: '/token', body: { access_token: 'tok_xyz' } }]);
    const { accessToken } = await exchangeCode(fetchImpl, META, {
      code: 'c',
      verifier: 'v',
      clientId: 'trove-cli',
      redirectUri: 'http://127.0.0.1:1/callback',
    });
    expect(accessToken).toBe('tok_xyz');
  });

  it('carries through the refresh token when the server grants offline_access', async () => {
    const fetchImpl = routeFetch([
      { match: '/token', body: { access_token: 'tok_xyz', refresh_token: 'rt_abc' } },
    ]);
    const set = await exchangeCode(fetchImpl, META, {
      code: 'c',
      verifier: 'v',
      clientId: 'trove-cli',
      redirectUri: 'http://127.0.0.1:1/callback',
    });
    expect(set.accessToken).toBe('tok_xyz');
    expect(set.refreshToken).toBe('rt_abc');
  });

  it('maps a 401 to an auth error', async () => {
    const fetchImpl = routeFetch([{ match: '/token', body: {}, status: 401 }]);
    await expect(
      exchangeCode(fetchImpl, META, { code: 'c', verifier: 'v', clientId: 'x', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('maps a 500 to a transport error', async () => {
    const fetchImpl = routeFetch([{ match: '/token', body: {}, status: 500 }]);
    await expect(
      exchangeCode(fetchImpl, META, { code: 'c', verifier: 'v', clientId: 'x', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: ExitCode.Transport });
  });

  it('throws when the token endpoint returns no access_token', async () => {
    const fetchImpl = routeFetch([{ match: '/token', body: { token_type: 'bearer' } }]);
    await expect(
      exchangeCode(fetchImpl, META, { code: 'c', verifier: 'v', clientId: 'x', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('throws on a non-JSON token body', async () => {
    const fetchImpl = routeFetch([{ match: '/token', text: 'nope' }]);
    await expect(
      exchangeCode(fetchImpl, META, { code: 'c', verifier: 'v', clientId: 'x', redirectUri: 'r' }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe('refreshAccessToken', () => {
  it('redeems a refresh token for a new access token', async () => {
    let sentBody = '';
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ access_token: 'tok_new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const set = await refreshAccessToken(fetchImpl, META.token_endpoint, {
      refreshToken: 'rt_old',
      clientId: 'cli',
    });
    expect(set.accessToken).toBe('tok_new');
    expect(sentBody).toContain('grant_type=refresh_token');
    expect(sentBody).toContain('refresh_token=rt_old');
    expect(sentBody).toContain('client_id=cli');
  });

  it('returns a rotated refresh token when the server issues one', async () => {
    const fetchImpl = routeFetch([
      { match: '/token', body: { access_token: 'tok_new', refresh_token: 'rt_rotated' } },
    ]);
    const set = await refreshAccessToken(fetchImpl, META.token_endpoint, {
      refreshToken: 'rt_old',
      clientId: 'cli',
    });
    expect(set.refreshToken).toBe('rt_rotated');
  });

  it('maps a 400 invalid_grant (expired/revoked refresh token) to an auth error', async () => {
    const fetchImpl = routeFetch([
      { match: '/token', body: { error: 'invalid_grant' }, status: 400 },
    ]);
    await expect(
      refreshAccessToken(fetchImpl, META.token_endpoint, { refreshToken: 'rt', clientId: 'cli' }),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('maps a 500 to a transport error', async () => {
    const fetchImpl = routeFetch([{ match: '/token', body: {}, status: 500 }]);
    await expect(
      refreshAccessToken(fetchImpl, META.token_endpoint, { refreshToken: 'rt', clientId: 'cli' }),
    ).rejects.toMatchObject({ code: ExitCode.Transport });
  });
});

describe('registerClient (DCR)', () => {
  it('returns the issued client_id on success', async () => {
    const fetchImpl = routeFetch([{ match: '/register', body: { client_id: 'cli_new' } }]);
    const id = await registerClient(
      fetchImpl,
      'https://as/register',
      'http://127.0.0.1:9876/callback',
    );
    expect(id).toBe('cli_new');
  });

  it('throws on a non-2xx registration response', async () => {
    const fetchImpl = routeFetch([{ match: '/register', body: {}, status: 400 }]);
    await expect(
      registerClient(fetchImpl, 'https://as/register', 'http://127.0.0.1:9876/callback'),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('throws on a non-JSON registration body', async () => {
    const fetchImpl = routeFetch([{ match: '/register', text: 'nope' }]);
    await expect(
      registerClient(fetchImpl, 'https://as/register', 'http://127.0.0.1:9876/callback'),
    ).rejects.toMatchObject({ code: ExitCode.Transport });
  });

  it('throws when no client_id is returned', async () => {
    const fetchImpl = routeFetch([{ match: '/register', body: { client_name: 'x' } }]);
    await expect(
      registerClient(fetchImpl, 'https://as/register', 'http://127.0.0.1:9876/callback'),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });
});

describe('runLoginFlow', () => {
  const discovery = routeFetch([
    {
      match: 'oauth-protected-resource',
      body: { authorization_servers: ['https://accounts.example.com'] },
    },
    { match: 'oauth-authorization-server', body: META },
    { match: '/register', body: { client_id: 'cli_dcr_123' } },
    { match: '/token', body: { access_token: 'tok_flow' } },
  ]);

  function loopback(state: string): (path: string) => Promise<LoopbackHandle> {
    return async () => ({ port: 4321, code: Promise.resolve({ code: 'auth-code', state }) });
  }

  it('runs the full loopback flow and returns the token + issuer', async () => {
    const opened: string[] = [];
    const result = await runLoginFlow(
      { apiUrl: 'https://api.example.com' },
      {
        fetchImpl: discovery,
        openBrowser: async (u) => {
          opened.push(u);
        },
        startLoopback: loopback('fixed-state'),
        makePkce: () => ({ verifier: 'ver', challenge: 'chal' }),
        makeState: () => 'fixed-state',
        onProgress: () => {},
      },
    );
    expect(result.token).toBe('tok_flow');
    expect(result.issuer).toBe(META.issuer);
    // No client id supplied → the flow self-registers (DCR) and returns the id.
    expect(result.clientId).toBe('cli_dcr_123');
    expect(opened[0]).toContain('client_id=cli_dcr_123');
    expect(opened[0]).toContain('code_challenge=chal');
    expect(opened[0]).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fcallback');
  });

  it('reuses a supplied client id without registering', async () => {
    const noRegister = routeFetch([
      {
        match: 'oauth-protected-resource',
        body: { authorization_servers: ['https://accounts.example.com'] },
      },
      { match: 'oauth-authorization-server', body: META },
      { match: '/token', body: { access_token: 'tok_flow' } },
    ]);
    const opened: string[] = [];
    const result = await runLoginFlow(
      { apiUrl: 'https://api.example.com', clientId: 'cached_client' },
      {
        fetchImpl: noRegister,
        openBrowser: async (u) => {
          opened.push(u);
        },
        startLoopback: loopback('fixed-state'),
        makePkce: () => ({ verifier: 'ver', challenge: 'chal' }),
        makeState: () => 'fixed-state',
      },
    );
    expect(result.clientId).toBe('cached_client');
    expect(opened[0]).toContain('client_id=cached_client');
  });

  it('throws when no client id is cached and the AS has no registration endpoint', async () => {
    const noReg = routeFetch([
      {
        match: 'oauth-protected-resource',
        body: { authorization_servers: ['https://accounts.example.com'] },
      },
      {
        match: 'oauth-authorization-server',
        body: {
          issuer: META.issuer,
          authorization_endpoint: META.authorization_endpoint,
          token_endpoint: META.token_endpoint,
        },
      },
    ]);
    await expect(
      runLoginFlow(
        { apiUrl: 'https://api.example.com' },
        {
          fetchImpl: noReg,
          openBrowser: async () => {},
          startLoopback: loopback('s'),
          makeState: () => 's',
        },
      ),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('rejects on a state mismatch (CSRF)', async () => {
    await expect(
      runLoginFlow(
        { apiUrl: 'https://api.example.com' },
        {
          fetchImpl: discovery,
          openBrowser: async () => {},
          startLoopback: loopback('attacker-state'),
          makeState: () => 'expected-state',
        },
      ),
    ).rejects.toMatchObject({ code: ExitCode.Auth });
  });
});

describe('loopbackStart (live socket)', () => {
  it('binds a port and resolves the captured code via a real redirect', async () => {
    // requires live loopback: this exercises the real 127.0.0.1 listener.
    const handle = await loopbackStart('/callback', 5000, 0);
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/callback?code=abc&state=st`);
    expect(res.status).toBe(200);
    await expect(handle.code).resolves.toEqual({ code: 'abc', state: 'st' });
  });

  it('404s an unknown path and still resolves on the redirect', async () => {
    const handle = await loopbackStart('/callback', 5000, 0);
    const miss = await fetch(`http://127.0.0.1:${handle.port}/other`);
    expect(miss.status).toBe(404);
    await fetch(`http://127.0.0.1:${handle.port}/callback?code=z&state=s`);
    await expect(handle.code).resolves.toEqual({ code: 'z', state: 's' });
  });

  it('rejects when the browser callback times out', async () => {
    const handle = await loopbackStart('/callback', 60, 0);
    await expect(handle.code).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  it('rejects when the redirect carries no code', async () => {
    const handle = await loopbackStart('/callback', 5000, 0);
    // Attach the rejection expectation before triggering the redirect so the
    // rejection is never momentarily unhandled.
    const expectation = expect(handle.code).rejects.toMatchObject({ code: ExitCode.Auth });
    await fetch(`http://127.0.0.1:${handle.port}/callback?state=s`);
    await expectation;
  });
});
