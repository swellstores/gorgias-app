// OAuth connection between a Swell store and Gorgias.
//
// Gorgias registers one App URL and one Redirect URL for the app, but every
// Swell install has its own admin proxy host, so this Worker's public URL is
// the fixed endpoint and bounces the browser back to the right install:
//
//   Connect page (proxy host)  POST /oauth/start ──► Gorgias consent screen
//   Gorgias ──► GET /oauth/callback (public URL, stateless: checks the signed
//               state and redirects to the install's proxy host)
//   GET /oauth/complete (proxy host) ──► code exchange with the client secret,
//               tokens saved to the app's `connections` record, the app's
//               connect function provisions Gorgias, back to the dashboard
//
// The app's functions can't hold the client secret, so they refresh access
// tokens through POST /oauth/refresh with a per-store key issued at connect.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './env';
import {
  hmacHex,
  randomHex,
  sha256Hex,
  signState,
  timingSafeEqual,
  verifyState,
} from './lib/crypto';
import {
  OAuthError,
  authorizeUrl,
  deleteResource,
  exchangeCode,
  normalizeSubdomain,
  refreshAccessToken,
  revokeToken,
  tokenExpiresAt,
} from './lib/gorgias';
import {
  ProxyContext,
  adminAppUrl,
  adminSession,
  isProxyHost,
  loadState,
  proxyContext,
  saveState,
  swellApi,
  triggerConnect,
} from './lib/swell';
import { installPage, messagePage } from './pages';

type AppContext = Context<{ Bindings: Env }>;
type OAuthState = { h: string; n: string; x: number };

const STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRED =
  'This link has expired. Start again from the Gorgias page in your Swell dashboard.';

const app = new Hono<{ Bindings: Env }>();

function publicOrigin(c: AppContext): string {
  return (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');
}

function callbackUrl(c: AppContext): string {
  return `${publicOrigin(c)}/oauth/callback`;
}

function background(c: AppContext, promise: Promise<unknown>): void {
  const task = promise.catch((err) => console.error(String(err)));
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // no execution context (tests)
  }
}

// Authorizes a store's token refreshes. Bound to the refresh token itself, so
// the key only ever renews the token it was issued for.
export async function refreshKey(
  env: Env,
  storeId: string,
  envId: string,
  subdomain: string,
  refreshToken: string,
): Promise<string> {
  return hmacHex(
    env.STATE_SECRET,
    ['refresh', storeId, envId, subdomain, await sha256Hex(refreshToken)].join('|'),
  );
}

// Routes that act for a merchant: the request must come through their store's
// admin proxy, from the app's own page, with a valid dashboard session.
async function merchant(
  c: AppContext,
): Promise<{ ctx: ProxyContext; userId: string } | null> {
  const ctx = proxyContext(c);
  if (!ctx) return null;
  if (c.req.method === 'POST' && c.req.header('origin') !== `https://${ctx.host}`) {
    return null;
  }
  const session = await adminSession(c, ctx);
  return session ? { ctx, userId: session.user_id } : null;
}

// Connect page form (target=_top) → Gorgias consent screen.
app.post('/oauth/start', async (c) => {
  const m = await merchant(c);
  if (!m) {
    return c.html(
      messagePage('Not signed in', 'Open the Gorgias page in your Swell dashboard to connect.'),
      401,
    );
  }
  const form = await c.req.parseBody();
  const subdomain = normalizeSubdomain(form.subdomain);
  if (!subdomain) return c.redirect(adminAppUrl(m.ctx), 302);

  const nonce = randomHex(16);
  const expires = Date.now() + STATE_TTL_MS;
  const api = swellApi(m.ctx);
  await saveState(api, await loadState(api), {
    oauth_nonce_hash: await sha256Hex(nonce),
    oauth_subdomain: subdomain,
    oauth_user_id: m.userId,
    oauth_expires: new Date(expires).toISOString(),
    oauth_error: null,
  });
  const state = await signState(c.env.STATE_SECRET, { h: m.ctx.host, n: nonce, x: expires });
  return c.redirect(authorizeUrl(c.env, subdomain, callbackUrl(c), state), 302);
});

// Gorgias → the registered Redirect URL. Stateless: only signed states are
// forwarded, and only to a Swell app proxy host.
app.get('/oauth/callback', async (c) => {
  const state = await verifyState<OAuthState>(c.env.STATE_SECRET, c.req.query('state'));
  if (!state || !isProxyHost(c.env, state.h)) {
    return c.html(messagePage('Link expired', EXPIRED), 400);
  }
  return c.redirect(`https://${state.h}/oauth/complete${new URL(c.req.url).search}`, 302);
});

// On the install's proxy host: exchange the code with the client secret and
// save the tokens where the app's functions read them.
app.get('/oauth/complete', async (c) => {
  const ctx = proxyContext(c);
  const oauth = await verifyState<OAuthState>(c.env.STATE_SECRET, c.req.query('state'));
  if (!ctx || !oauth || oauth.h !== ctx.host) {
    return c.html(messagePage('Link expired', EXPIRED), 400);
  }
  const session = await adminSession(c, ctx);
  if (!session) {
    return c.html(
      messagePage(
        'Not signed in',
        'Sign in to your Swell dashboard, then connect again from the Gorgias page.',
      ),
      401,
    );
  }

  const api = swellApi(ctx);
  let state = await loadState(api);
  const back = adminAppUrl(ctx);
  const nonceValid =
    !!state.oauth_nonce_hash &&
    timingSafeEqual(state.oauth_nonce_hash, await sha256Hex(oauth.n)) &&
    Date.parse(state.oauth_expires) > Date.now() &&
    state.oauth_user_id === session.user_id;
  if (!nonceValid) {
    // A retried request after a completed exchange lands here: send the
    // merchant back to the page, which shows the connection.
    if (state.date_authorized && Date.now() - Date.parse(state.date_authorized) < STATE_TTL_MS) {
      return c.redirect(back, 302);
    }
    return c.html(messagePage('Link expired', EXPIRED), 400);
  }

  const subdomain = String(state.oauth_subdomain);
  state = await saveState(api, state, { oauth_nonce_hash: null, oauth_expires: null });

  const code = c.req.query('code');
  if (!code) {
    await saveState(api, state, {
      oauth_error:
        c.req.query('error') === 'access_denied'
          ? 'Access to Gorgias was not granted.'
          : 'Gorgias did not finish connecting. Try again.',
    });
    return c.redirect(back, 302);
  }

  try {
    const token = await exchangeCode(c.env, subdomain, code, callbackUrl(c));
    await saveState(api, state, {
      gorgias_subdomain: subdomain,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_expires_at: tokenExpiresAt(token),
      token_scope: token.scope || '',
      refresh_key: await refreshKey(
        c.env,
        ctx.storeId,
        ctx.envId,
        subdomain,
        token.refresh_token!,
      ),
      oauth_store_id: ctx.storeId,
      oauth_env: ctx.envId,
      oauth_service_url: publicOrigin(c),
      date_authorized: new Date().toISOString(),
      oauth_error: null,
    });
  } catch (err) {
    console.error(`Gorgias code exchange failed: ${String(err)}`);
    await saveState(api, state, {
      oauth_error: 'Gorgias did not accept the connection. Try again.',
    });
    return c.redirect(back, 302);
  }

  background(c, triggerConnect(ctx));
  return c.redirect(back, 302);
});

// Connect page data.
app.post('/connection/status', async (c) => {
  const m = await merchant(c);
  if (!m) return c.json({ error: 'unauthorized' }, 401);
  const api = swellApi(m.ctx);
  const [state, settings] = await Promise.all([
    loadState(api),
    api.get(`/settings/${m.ctx.appId}`).catch(() => null),
  ]);
  return c.json({
    connected: !!(state.refresh_token && state.gorgias_subdomain),
    account: state.gorgias_subdomain ? `${state.gorgias_subdomain}.gorgias.com` : null,
    status: settings?.connection?.status || '',
    error: state.oauth_error || null,
  });
});

// Removes what the app created in Gorgias, revokes access and forgets the
// tokens. Best effort on the Gorgias side: the tokens are dropped regardless.
app.post('/connection/disconnect', async (c) => {
  const m = await merchant(c);
  if (!m) return c.json({ error: 'unauthorized' }, 401);
  const api = swellApi(m.ctx);
  const state = await loadState(api);
  const subdomain = normalizeSubdomain(state.gorgias_subdomain);

  if (subdomain && state.refresh_token) {
    let accessToken: string | null = state.access_token || null;
    const expiresAt = Date.parse(state.token_expires_at || '');
    // An unknown expiry counts as expired.
    if (!accessToken || !(expiresAt > Date.now() + 60_000)) {
      accessToken = await refreshAccessToken(c.env, subdomain, state.refresh_token)
        .then((t) => t.access_token)
        .catch(() => null);
    }
    if (accessToken) {
      if (state.widget_id) {
        await deleteResource(subdomain, accessToken, `/api/widgets/${state.widget_id}`).catch(
          () => undefined,
        );
      }
      if (state.integration_id) {
        await deleteResource(
          subdomain,
          accessToken,
          `/api/integrations/${state.integration_id}`,
        ).catch(() => undefined);
      }
    }
    await revokeToken(c.env, subdomain, state.refresh_token).catch((err) =>
      console.error(`Gorgias revoke failed: ${String(err)}`),
    );
  }

  await saveState(api, state, {
    gorgias_subdomain: null,
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    refresh_key: null,
    date_authorized: null,
    events_secret: null,
    fingerprint: null,
    integration_id: null,
    widget_id: null,
    gorgias_account: null,
    oauth_error: null,
  });
  background(c, triggerConnect(m.ctx));
  return c.json({ ok: true });
});

// Called by the app's functions (reconcile) to renew the 24-hour access token.
app.post('/oauth/refresh', async (c) => {
  const body = await c.req.json().catch(() => null);
  const subdomain = normalizeSubdomain(body?.subdomain);
  if (
    !subdomain ||
    subdomain !== body.subdomain ||
    typeof body.refresh_token !== 'string' ||
    typeof body.key !== 'string'
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const storeId = String(body.store_id || '');
  const envId = String(body.env || '');
  const expected = await refreshKey(c.env, storeId, envId, subdomain, body.refresh_token);
  if (!timingSafeEqual(body.key, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  try {
    const token = await refreshAccessToken(c.env, subdomain, body.refresh_token);
    // If Gorgias rotates the refresh token, the key has to follow it.
    const rotated = token.refresh_token && token.refresh_token !== body.refresh_token;
    return c.json({
      access_token: token.access_token,
      refresh_token: rotated ? token.refresh_token : null,
      key: rotated
        ? await refreshKey(c.env, storeId, envId, subdomain, token.refresh_token!)
        : null,
      expires_at: tokenExpiresAt(token),
    });
  } catch (err) {
    if (err instanceof OAuthError && err.code === 'invalid_grant') {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    console.error(`Gorgias token refresh failed: ${String(err)}`);
    return c.json({ error: 'unavailable' }, 502);
  }
});

// The App URL registered with Gorgias, for installs started from its App Store.
app.get('/oauth/install', (c) =>
  c.html(installPage(normalizeSubdomain(c.req.query('account')))),
);

export default app;
