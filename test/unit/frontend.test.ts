import { describe, it, expect, vi, afterEach } from 'vitest';
import app, { refreshKey } from '../../frontend/src/index';
import type { Env } from '../../frontend/src/env';
import {
  base64url,
  sha256Hex,
  signState,
  verifyState,
} from '../../frontend/src/lib/crypto';
import { normalizeSubdomain, tokenExpiresAt } from '../../frontend/src/lib/gorgias';

const HOST = 'teststore--0123456789abcdef01234567--app.swell.store';
const WORKER = 'https://swell-gorgias.example.workers.dev';
const env = {
  GORGIAS_CLIENT_ID: 'client-id',
  GORGIAS_CLIENT_SECRET: 'client-secret',
  STATE_SECRET: 'state-secret',
  PUBLIC_URL: WORKER,
} as unknown as Env;

const proxyHeaders = {
  'swell-store-id': 'teststore',
  'swell-access-token': 'app_sk_test_abc',
  'swell-app-id': 'gorgias',
  'swell-environment-id': 'test',
  'x-forwarded-host': HOST,
  cookie: '_swell_admin_session=sess1',
};
const postHeaders = { ...proxyHeaders, origin: `https://${HOST}` };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeJwt(claims: object) {
  return `${base64url('{"alg":"none"}')}.${base64url(JSON.stringify(claims))}.sig`;
}

// Stands in for the admin session API, the Swell API, Gorgias and the app's
// connect function.
function backend(options: {
  session?: object;
  state?: SwellData;
  token?: () => Response;
} = {}) {
  const setSession = (session: object) => {
    options.session = session;
  };
  const db: { state: SwellData | null } = {
    state: options.state ? { id: 'state1', ...options.state } : null,
  };
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method || 'GET',
        headers: (init.headers || {}) as Record<string, string>,
        body: String(init.body ?? ''),
      };
      calls.push(call);
      const { url, method } = call;
      if (url === 'https://teststore.swell.store/admin/api/session') {
        return json(options.session ?? { user_id: 'u1', client_id: 'teststore' });
      }
      if (url.startsWith('https://api.swell.store/connections')) {
        if (method === 'GET') return json({ results: db.state ? [db.state] : [] });
        const data = JSON.parse(call.body);
        db.state = method === 'POST' ? { id: 'state1', ...data } : { ...db.state, ...data };
        return json(db.state);
      }
      if (url === 'https://api.swell.store/settings/gorgias') {
        return json({ connection: { status: 'Connected to acme.gorgias.com. Last checked 2026-09-28 12:00 UTC.' } });
      }
      if (url === 'https://acme.gorgias.com/oauth/token') {
        return options.token
          ? options.token()
          : json({
              access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
              refresh_token: 'refresh-1',
              expires_in: 0,
              scope: 'offline integrations:write',
            });
      }
      if (url.startsWith('https://acme.gorgias.com/')) return json({});
      if (url === 'https://teststore.swell.store/functions/gorgias/connect') {
        return json({ status: 'connected' });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { db, calls, setSession };
}

async function start(subdomain = 'Acme.gorgias.com', headers: Record<string, string> = postHeaders) {
  return app.request(
    '/oauth/start',
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ subdomain }).toString(),
    },
    env,
  );
}

async function startedFlow(stateOverrides: SwellData = {}) {
  const fake = backend({ state: stateOverrides });
  const res = await start();
  const location = new URL(res.headers.get('location')!);
  return { ...fake, location, state: location.searchParams.get('state')! };
}

function complete(query: string, headers: Record<string, string> = proxyHeaders) {
  return app.request(`/oauth/complete?${query}`, { headers }, env);
}

describe('frontend Worker: /oauth/start', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the merchant to the Gorgias consent screen with a signed state', async () => {
    const { db } = backend();
    const res = await start();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://acme.gorgias.com/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('redirect_uri')).toBe(`${WORKER}/oauth/callback`);
    expect(location.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining(['offline', 'customers:write', 'integrations:write']),
    );
    const state = await verifyState<{ h: string; n: string; x: number }>(
      'state-secret',
      location.searchParams.get('state')!,
    );
    expect(state!.h).toBe(HOST);
    expect(db.state).toMatchObject({
      oauth_subdomain: 'acme',
      oauth_user_id: 'u1',
      oauth_nonce_hash: await sha256Hex(state!.n),
    });
  });

  it('refuses requests without a valid dashboard session', async () => {
    backend({ session: {} });
    expect((await start()).status).toBe(401);
  });

  it('refuses posts from another origin', async () => {
    backend();
    const res = await start('acme', { ...postHeaders, origin: 'https://evil.example.com' });
    expect(res.status).toBe(401);
  });

  it('refuses a host that is not this store\'s app proxy', async () => {
    backend();
    const other = 'otherstore--0123456789abcdef01234567--app.swell.store';
    const res = await start('acme', {
      ...postHeaders,
      'x-forwarded-host': other,
      origin: `https://${other}`,
    });
    expect(res.status).toBe(401);
  });

  it('sends an invalid subdomain back to the page without starting', async () => {
    const { db } = backend();
    const res = await start('not a subdomain!');
    expect(res.headers.get('location')).toBe('https://teststore.swell.store/admin/test/app/gorgias');
    expect(db.state).toBeNull();
  });
});

describe('frontend Worker: /oauth/callback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('bounces a signed state to the install\'s proxy host', async () => {
    const state = await signState('state-secret', { h: HOST, n: 'n1', x: Date.now() + 60000 });
    const res = await app.request(`/oauth/callback?code=abc&state=${state}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `https://${HOST}/oauth/complete?code=abc&state=${state}`,
    );
  });

  it('refuses tampered, expired and non-proxy states', async () => {
    const good = await signState('state-secret', { h: HOST, n: 'n1', x: Date.now() + 60000 });
    const tampered = good.replace(/^[^.]+/, base64url(JSON.stringify({ h: 'evil.example.com', n: 'n1', x: Date.now() + 60000 })));
    const expired = await signState('state-secret', { h: HOST, n: 'n1', x: Date.now() - 1 });
    const offsite = await signState('state-secret', { h: 'evil.example.com', n: 'n1', x: Date.now() + 60000 });
    for (const state of [tampered, expired, offsite, 'garbage']) {
      const res = await app.request(`/oauth/callback?code=abc&state=${state}`, {}, env);
      expect(res.status).toBe(400);
    }
  });
});

describe('frontend Worker: /oauth/complete', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exchanges the code, stores the tokens and provisions', async () => {
    const { db, calls, state } = await startedFlow();
    const res = await complete(`code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://teststore.swell.store/admin/test/app/gorgias');

    const exchange = calls.find((c) => c.url === 'https://acme.gorgias.com/oauth/token')!;
    expect(exchange.headers.authorization).toBe(`Basic ${btoa('client-id:client-secret')}`);
    const form = new URLSearchParams(exchange.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('abc');
    expect(form.get('redirect_uri')).toBe(`${WORKER}/oauth/callback`);

    expect(db.state).toMatchObject({
      gorgias_subdomain: 'acme',
      refresh_token: 'refresh-1',
      oauth_store_id: 'teststore',
      oauth_env: 'test',
      oauth_service_url: WORKER,
      oauth_nonce_hash: null,
      oauth_error: null,
      refresh_key: await refreshKey(env, 'teststore', 'test', 'acme', 'refresh-1'),
    });
    expect(db.state!.access_token).toMatch(/\.sig$/);
    expect(Date.parse(db.state!.token_expires_at) - Date.now()).toBeGreaterThan(3500000);

    const connect = calls.find((c) => c.url === 'https://teststore.swell.store/functions/gorgias/connect')!;
    expect(connect.method).toBe('POST');
    expect(connect.headers.authorization).toBe(`Basic ${btoa('teststore:app_sk_test_abc')}`);
  });

  it('is single use: a replay does not exchange again', async () => {
    const { calls, state } = await startedFlow();
    await complete(`code=abc&state=${state}`);
    const exchanges = () => calls.filter((c) => c.url.endsWith('/oauth/token')).length;
    expect(exchanges()).toBe(1);
    const replay = await complete(`code=abc&state=${state}`);
    expect(replay.status).toBe(302);
    expect(exchanges()).toBe(1);
  });

  it('refuses a different dashboard user', async () => {
    const { state, setSession, calls } = await startedFlow();
    setSession({ user_id: 'u2', client_id: 'teststore' });
    expect((await complete(`code=abc&state=${state}`)).status).toBe(400);
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
  });

  it('refuses a state issued for another install', async () => {
    const { state } = await startedFlow();
    const res = await complete(`code=abc&state=${state}`, {
      ...proxyHeaders,
      'x-forwarded-host': 'teststore--ffffffffffffffffffffffff--app.swell.store',
    });
    expect(res.status).toBe(400);
  });

  it('records a declined authorization for the page', async () => {
    const { db, calls, state } = await startedFlow();
    const res = await complete(`error=access_denied&state=${state}`);
    expect(res.status).toBe(302);
    expect(db.state!.oauth_error).toBe('Access to Gorgias was not granted.');
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
  });

  it('records a failed exchange without storing tokens', async () => {
    const fake = backend({ token: () => json({ error: 'invalid_grant' }, 400) });
    const started = await start();
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    await complete(`code=abc&state=${state}`);
    expect(fake.db.state!.refresh_token).toBeUndefined();
    expect(fake.db.state!.oauth_error).toBe('Gorgias did not accept the connection. Try again.');
  });
});

describe('frontend Worker: page API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the connection to a signed-in merchant only', async () => {
    backend({ state: { gorgias_subdomain: 'acme', refresh_token: 'r' } });
    const res = await app.request('/connection/status', { method: 'POST', headers: postHeaders }, env);
    expect(await res.json()).toEqual({
      connected: true,
      account: 'acme.gorgias.com',
      status: 'Connected to acme.gorgias.com. Last checked 2026-09-28 12:00 UTC.',
      error: null,
    });

    backend({ session: {} });
    const anonymous = await app.request('/connection/status', { method: 'POST', headers: postHeaders }, env);
    expect(anonymous.status).toBe(401);
  });

  it('disconnect removes the Gorgias objects, revokes access and forgets the tokens', async () => {
    const { db, calls } = backend({
      state: {
        gorgias_subdomain: 'acme',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
        integration_id: 11,
        widget_id: 22,
        events_secret: 'e',
      },
    });
    const res = await app.request('/connection/disconnect', { method: 'POST', headers: postHeaders }, env);
    expect(res.status).toBe(200);

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual([
      'https://acme.gorgias.com/api/widgets/22',
      'https://acme.gorgias.com/api/integrations/11',
    ]);
    deletes.forEach((c) => expect(c.headers.authorization).toBe('Bearer access-1'));
    const revoke = calls.find((c) => c.url === 'https://acme.gorgias.com/oauth/revoke')!;
    expect(revoke.headers.authorization).toBe(`Basic ${btoa('client-id:client-secret')}`);
    expect(new URLSearchParams(revoke.body).get('token')).toBe('refresh-1');
    expect(db.state).toMatchObject({
      gorgias_subdomain: null,
      access_token: null,
      refresh_token: null,
      events_secret: null,
      integration_id: null,
    });
    expect(calls.some((c) => c.url.endsWith('/functions/gorgias/connect'))).toBe(true);
  });
});

describe('frontend Worker: /oauth/refresh', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function refresh(body: object) {
    return app.request(
      '/oauth/refresh',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      env,
    );
  }

  const store = { store_id: 'teststore', env: 'test', subdomain: 'acme' };

  it('renews the access token for a caller with the key for that token', async () => {
    const { calls } = backend();
    const key = await refreshKey(env, 'teststore', 'test', 'acme', 'refresh-1');
    const res = await refresh({ ...store, refresh_token: 'refresh-1', key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SwellData;
    expect(body.access_token).toMatch(/\.sig$/);
    expect(body.expires_at).toBeTruthy();
    // same refresh token back: nothing to rotate
    expect(body.refresh_token).toBeNull();
    expect(body.key).toBeNull();
    const call = calls.find((c) => c.url === 'https://acme.gorgias.com/oauth/token')!;
    expect(call.headers.authorization).toBe(`Basic ${btoa('client-id:client-secret')}`);
    expect(new URLSearchParams(call.body).get('grant_type')).toBe('refresh_token');
  });

  it('issues a new key when Gorgias rotates the refresh token', async () => {
    backend({
      token: () => json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 86400 }),
    });
    const key = await refreshKey(env, 'teststore', 'test', 'acme', 'refresh-1');
    const body = (await (await refresh({ ...store, refresh_token: 'refresh-1', key })).json()) as SwellData;
    expect(body.refresh_token).toBe('refresh-2');
    expect(body.key).toBe(await refreshKey(env, 'teststore', 'test', 'acme', 'refresh-2'));
  });

  it('refuses a wrong key, another token or another helpdesk', async () => {
    const { calls } = backend();
    const key = await refreshKey(env, 'teststore', 'test', 'acme', 'refresh-1');
    expect((await refresh({ ...store, refresh_token: 'refresh-1', key: 'nope' })).status).toBe(401);
    expect((await refresh({ ...store, refresh_token: 'someone-elses', key })).status).toBe(401);
    expect((await refresh({ ...store, subdomain: 'other', refresh_token: 'refresh-1', key })).status).toBe(401);
    expect((await refresh({ ...store, subdomain: 'evil.com/x', refresh_token: 'refresh-1', key })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('reports revoked access as invalid_grant', async () => {
    backend({ token: () => json({ error: 'invalid_grant' }, 400) });
    const key = await refreshKey(env, 'teststore', 'test', 'acme', 'refresh-1');
    const res = await refresh({ ...store, refresh_token: 'refresh-1', key });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });
});

describe('frontend Worker: platform constraints', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The Swell gateway serves these prefixes itself on app proxy hosts, so a
  // Worker route under them would never be reached (swell-admin server/gateway.js).
  const RESERVED = ['/api', '/functions', '/graphql', '/integration/api', '/checkout/api', '/buy', '/playground', '/oauth/access-tokens', '/.well-known', '/password', '/info'];

  it('keeps every route off the paths the gateway reserves', () => {
    const paths = app.routes.map((r) => r.path);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      expect(RESERVED.some((p) => path === p || path.startsWith(`${p}/`))).toBe(false);
    }
  });

  it('returns merchants to the dashboard path for their environment', async () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'https://teststore.swell.store/admin/app/gorgias'],
      ['test', 'https://teststore.swell.store/admin/test/app/gorgias'],
      ['feature-x', 'https://teststore.swell.store/admin/test-feature-x/app/gorgias'],
    ];
    for (const [envId, expected] of cases) {
      backend();
      const headers: Record<string, string> = { ...postHeaders };
      if (envId) headers['swell-environment-id'] = envId;
      else delete headers['swell-environment-id'];
      // an invalid subdomain sends the merchant straight back
      const res = await start('!', headers);
      expect(res.headers.get('location')).toBe(expected);
    }
  });
});

describe('frontend Worker: /oauth/install', () => {
  it('tells merchants starting from Gorgias how to finish in Swell', async () => {
    const res = await app.request('/oauth/install?account=acme', {}, env);
    const html = await res.text();
    expect(html).toContain('<strong>Gorgias</strong> in the menu');
    expect(html).toContain('<code>acme</code>');
    const injected = await app.request('/oauth/install?account=%3Cscript%3E', {}, env);
    expect(await injected.text()).not.toContain('<script>');
  });
});

describe('helpers', () => {
  it('normalizes what merchants type as their helpdesk', () => {
    expect(normalizeSubdomain('Acme')).toBe('acme');
    expect(normalizeSubdomain('acme.gorgias.com')).toBe('acme');
    expect(normalizeSubdomain('https://acme.gorgias.com/app/tickets')).toBe('acme');
    expect(normalizeSubdomain('evil.com')).toBeNull();
    expect(normalizeSubdomain('')).toBeNull();
  });

  it('prefers the token\'s own expiry and falls back to 24 hours', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const exp = now / 1000 + 7200;
    expect(tokenExpiresAt({ access_token: fakeJwt({ exp }) }, now)).toBe('2026-09-28T14:00:00.000Z');
    expect(tokenExpiresAt({ access_token: 'opaque', expires_in: 0 }, now)).toBe('2026-09-29T12:00:00.000Z');
  });
});
