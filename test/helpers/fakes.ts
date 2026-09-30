import { vi } from 'vitest';
import { createMockRequest } from './mock-request';

export const STORE = {
  id: 'teststore',
  admin_url: 'https://teststore.swell.store',
  // A headless storefront domain: function URLs must never use it
  url: 'https://shop.example.com',
};
export const PUBLIC_KEY = 'app_pk_test_123';
export const EVENTS_SECRET = 'events-secret';
export const INTERNAL_SECRET = 'internal-secret';
export const WORKER_URL = 'https://swell-gorgias.example.workers.dev';
export const ACCESS_TOKEN = 'gorgias-access-token';
export const RENEWED_TOKEN = 'gorgias-renewed-token';

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600000).toISOString();

// State as the frontend Worker leaves it after the merchant authorizes the app.
export function connectedState(overrides: SwellData = {}): SwellData {
  return {
    gorgias_subdomain: 'acme',
    access_token: ACCESS_TOKEN,
    refresh_token: 'gorgias-refresh-token',
    token_expires_at: hoursFromNow(20),
    refresh_key: 'refresh-key',
    oauth_store_id: 'teststore',
    oauth_env: 'test',
    oauth_service_url: WORKER_URL,
    date_authorized: '2026-09-28T12:00:00.000Z',
    ...overrides,
  };
}

export interface FakeSwellOptions {
  settings?: SwellData;
  state?: SwellData | null;
  accounts?: SwellData[];
  orders?: SwellData[];
}

// In-memory stand-in for the parts of the Swell API the app uses: settings,
// the app's connections collection, accounts and orders.
export function createFakeSwell(options: FakeSwellOptions = {}) {
  const accounts = options.accounts || [];
  const orders = options.orders || [];
  const db: { settings: SwellData; state: SwellData | null } = {
    settings: JSON.parse(JSON.stringify(options.settings || {})),
    state: options.state ? { id: 'state1', ...options.state } : null,
  };

  const swell = {
    settings: vi.fn(async () => db.settings),
    get: vi.fn(async (url: string, query: SwellData = {}) => {
      if (url === '/connections') {
        return { results: db.state ? [db.state] : [] };
      }
      if (url === '/accounts') {
        if (query.where?.email) {
          return {
            results: accounts.filter((a) => a.email === query.where.email),
          };
        }
        const limit = query.limit || 25;
        const page = query.page || 1;
        return { results: accounts.slice((page - 1) * limit, page * limit) };
      }
      if (url.startsWith('/accounts/')) {
        return accounts.find((a) => a.id === url.split('/')[2]) || null;
      }
      if (url === '/orders') {
        return {
          results: orders.filter((o) => o.account_id === query.account_id),
        };
      }
      return null;
    }),
    post: vi.fn(async (url: string, data: SwellData) => {
      if (url === '/connections') {
        db.state = { id: 'state1', ...data };
        return db.state;
      }
      return data;
    }),
    put: vi.fn(async (url: string, data: SwellData) => {
      if (url.startsWith('/connections/')) {
        db.state = { ...db.state, ...data };
        return db.state;
      }
      if (url.startsWith('/settings/')) {
        const section = url.split('/')[3];
        db.settings[section] = { ...(db.settings[section] || {}), ...data };
        return db.settings[section];
      }
      return data;
    }),
  };
  return { swell, db };
}

export function createAppRequest(options: {
  swell: SwellData;
  data?: SwellData;
  headers?: Record<string, string>;
  publicKey?: string | null;
}): SwellRequest {
  const req = createMockRequest({
    data: options.data || {},
    headers: options.headers,
    swell: options.swell as Partial<SwellAPI>,
    store: STORE,
  });
  (req as SwellData).publicKey =
    options.publicKey === undefined ? PUBLIC_KEY : options.publicKey;
  return req;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Override = (call: FetchCall) => Response | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Routes fetch() for Gorgias API calls and gateway self-calls. Overrides run
// first; anything they don't answer gets a plausible default.
export function mockFetch(override?: Override) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const call: FetchCall = {
      url: String(input),
      method: init.method || 'GET',
      headers: (init.headers || {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const custom = override?.(call);
    if (custom) return custom;

    const { pathname } = new URL(call.url);
    if (call.url.includes('.swell.store/functions/')) return json({});
    if (call.url === `${WORKER_URL}/oauth/refresh`) {
      return json({
        access_token: RENEWED_TOKEN,
        refresh_token: null,
        expires_at: hoursFromNow(24),
      });
    }
    if (pathname === '/api/account') return json({ domain: 'acme' });
    if (pathname.startsWith('/api/integrations/')) {
      return call.method === 'GET'
        ? json({ error: 'not found' }, 404)
        : json({ id: Number(pathname.split('/')[3]) });
    }
    if (pathname === '/api/integrations') {
      return call.method === 'POST' ? json({ id: 11 }) : json({ data: [], meta: {} });
    }
    if (pathname.startsWith('/api/widgets/')) {
      return json({ id: Number(pathname.split('/')[3]) });
    }
    if (pathname === '/api/widgets') {
      return call.method === 'POST' ? json({ id: 22 }) : json({ data: [], meta: {} });
    }
    if (pathname === '/api/customers') {
      return call.method === 'POST' ? json({ id: 9 }) : json({ data: [] });
    }
    if (pathname.startsWith('/api/customers/')) {
      return json({ id: Number(pathname.split('/')[3]) });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock, json };
}

export { json };
