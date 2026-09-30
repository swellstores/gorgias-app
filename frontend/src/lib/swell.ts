// Swell context for requests that reach the Worker through a store's admin
// proxy (https://<storeId>--<installedAppId>--app.swell.store). The proxy
// injects the install's credentials on every request — including anonymous
// ones, and anyone can call the Worker's public URL with forged headers — so
// hosts are pinned here and every route that touches store data also checks
// the merchant's admin session.

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env';

export interface ProxyContext {
  storeId: string;
  // '' for live, 'test' (or a branch id) otherwise
  envId: string;
  accessToken: string;
  appId: string;
  // The install's proxy host the browser is on
  host: string;
  apiHost: string;
  adminOrigin: string;
}

const STORE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_ID = /^[a-z0-9-]{0,64}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hostSuffix(env: Env): string {
  return env.SWELL_HOST_SUFFIX || 'swell.store';
}

export function isProxyHost(env: Env, host: string, storeId?: string): boolean {
  const store = storeId ? escapeRegExp(storeId) : '[a-z0-9][a-z0-9-]*';
  return new RegExp(
    `^${store}--[a-f0-9]{24}--app\\.${escapeRegExp(hostSuffix(env))}$`,
  ).test(host);
}

// The browser-facing host: the proxy forwards it as X-Forwarded-Host (Host is
// rewritten to the Worker's own), and form posts from the page carry it as
// Origin.
function requestHost(c: Context<{ Bindings: Env }>): string {
  const forwarded = (c.req.header('x-forwarded-host') || '').split(',')[0].trim();
  if (forwarded) return forwarded.toLowerCase();
  try {
    return new URL(c.req.header('origin') || '').host.toLowerCase();
  } catch {
    return '';
  }
}

export function proxyContext(c: Context<{ Bindings: Env }>): ProxyContext | null {
  const storeId = c.req.header('swell-store-id') || '';
  const accessToken = c.req.header('swell-access-token') || '';
  const appId = c.req.header('swell-app-id') || '';
  const envId = c.req.header('swell-environment-id') || '';
  const host = requestHost(c);
  if (
    !STORE_ID.test(storeId) ||
    !APP_ID.test(appId) ||
    !ENV_ID.test(envId) ||
    !accessToken ||
    !isProxyHost(c.env, host, storeId)
  ) {
    return null;
  }
  return {
    storeId,
    envId: envId === 'live' ? '' : envId,
    accessToken,
    appId,
    host,
    apiHost: c.env.SWELL_API_HOST || 'https://api.swell.store',
    adminOrigin: `https://${storeId}.${hostSuffix(c.env)}`,
  };
}

// The admin session cookie is readable and writable by script, so its value is
// checked against the store's admin API every time, never trusted as-is.
export async function adminSession(
  c: Context<{ Bindings: Env }>,
  ctx: ProxyContext,
): Promise<{ user_id: string } | null> {
  const sessionId = getCookie(c, '_swell_admin_session');
  if (!sessionId || sessionId.length > 256) return null;
  try {
    const res = await fetch(`${ctx.adminOrigin}/admin/api/session`, {
      headers: { 'x-session': sessionId },
    });
    if (!res.ok) return null;
    const session = (await res.json()) as { user_id?: string; client_id?: string };
    return session?.user_id && session.client_id === ctx.storeId
      ? { user_id: String(session.user_id) }
      : null;
  } catch {
    return null;
  }
}

// Where the dashboard shows this app's page. The dashboard routes the test
// environment at /admin/test and other environments at /admin/test-<id>.
export function adminAppUrl(ctx: ProxyContext): string {
  const env = !ctx.envId ? '' : ctx.envId === 'test' ? '/test' : `/test-${ctx.envId}`;
  return `${ctx.adminOrigin}/admin${env}/app/${ctx.appId}`;
}

export interface SwellApi {
  get(path: string): Promise<any>;
  put(path: string, data: unknown): Promise<any>;
  post(path: string, data: unknown): Promise<any>;
}

// The injected token is the install's own app key: the same access the app's
// functions have, scoped to this store and environment.
export function swellApi(ctx: ProxyContext): SwellApi {
  const authorization = `Basic ${btoa(`${ctx.storeId}:${ctx.accessToken}`)}`;
  async function call(method: string, path: string, data?: unknown) {
    const res = await fetch(`${ctx.apiHost}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Swell ${method} ${path} returned ${res.status}`);
    }
    return text ? JSON.parse(text) : null;
  }
  return {
    get: (path) => call('GET', path),
    put: (path, data) => call('PUT', path, data),
    post: (path, data) => call('POST', path, data),
  };
}

// The app's single `connections` record (models/connections.json), shared
// with the app's functions.
export async function loadState(api: SwellApi): Promise<Record<string, any>> {
  const res = await api.get('/connections?sort=date_created+asc&limit=1');
  return res?.results?.[0] || {};
}

export async function saveState(
  api: SwellApi,
  state: Record<string, any>,
  values: Record<string, unknown>,
): Promise<Record<string, any>> {
  const saved = state.id
    ? await api.put(`/connections/${state.id}`, values)
    : await api.post('/connections', values);
  return { ...state, ...values, ...(saved || {}) };
}

// Tells the app to provision Gorgias now instead of on the next cron run.
// The connect route requires a secret key, which the install's app key is.
export async function triggerConnect(ctx: ProxyContext): Promise<void> {
  const res = await fetch(`${ctx.adminOrigin}/functions/${ctx.appId}/connect`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${ctx.storeId}:${ctx.accessToken}`)}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) console.error(`connect function returned ${res.status}`);
}
