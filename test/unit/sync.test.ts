import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import handler from '../../functions/sync';

const settings = {
  connection: {
    subdomain: 'acme',
    email: 'agent@acme.com',
    api_key: 'k',
    shared_secret: 'shh',
  },
  sync: { enabled: true, backfill_limit: '4' },
};

// One synced account = 4 Gorgias calls: find customer, update, get data, put data
function gorgiasResponses(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.includes('gorgias.com')) {
      if (url.includes('/api/customers?') || url.endsWith('email=&limit=1')) {
        return new Response(JSON.stringify({ data: [{ id: 9 }] }), { status: 200 });
      }
      if (url.includes('/data')) {
        return new Response(
          JSON.stringify(init?.method === 'PUT' ? { ok: true } : { version: 'v1' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    }
    // self-chain call
    return new Response('{}', { status: 200 });
  });
}

function makeRequest(query: Record<string, string>, accounts: SwellData[]) {
  const fetchMock = vi.fn();
  gorgiasResponses(fetchMock);
  vi.stubGlobal('fetch', fetchMock);
  const req = createMockRequest({
    query,
    store: { url: 'https://store.example.com', admin_url: 'https://admin.example.com' },
    swell: {
      settings: vi.fn().mockResolvedValue(settings),
      get: vi.fn().mockImplementation(async (url: string) => {
        if (url === '/accounts') return { results: accounts };
        if (url.startsWith('/accounts/')) {
          const id = url.split('/')[2];
          return accounts.find((a) => a.id === id) || { id, email: `${id}@x.co` };
        }
        if (url === '/orders' || url === '/subscriptions') return { results: [] };
        return {};
      }),
    },
  });
  return { req, fetchMock };
}

describe('sync function', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects without the shared secret', async () => {
    const { req } = makeRequest({}, []);
    const res = (await handler(req)) as Response;
    expect(res.status).toBe(401);
  });

  it('refresh mode syncs a single account', async () => {
    const { req } = makeRequest(
      { key: 'shh', account_id: 'acc1' },
      [{ id: 'acc1', email: 'a@x.co' }],
    );
    const result = (await handler(req)) as SwellData;
    expect(result.mode).toBe('refresh');
    expect(result.synced).toBe(true);
  }, 20000);

  it('backfill chains to the next page when the batch is full', async () => {
    const { req, fetchMock } = makeRequest(
      { key: 'shh', page: '1' },
      [
        { id: 'a1', email: 'a1@x.co' },
        { id: 'a2', email: 'a2@x.co' },
      ],
    );
    const result = (await handler(req)) as SwellData;
    expect(result.mode).toBe('backfill');
    expect(result.processed).toBe(2);
    expect(result.done).toBe(false);
    const chain = fetchMock.mock.calls.find(([u]: [string]) =>
      String(u).includes('/functions/gorgias/sync?page=2'),
    );
    expect(chain).toBeTruthy();
    expect(chain![1].headers['X-Swell-Gorgias-Secret']).toBe('shh');
  }, 20000);

  it('backfill stops at the configured limit and on short pages', async () => {
    const { req, fetchMock } = makeRequest(
      { key: 'shh', page: '2' }, // limit 4, batch 2 → page 2 is the last
      [
        { id: 'a3', email: 'a3@x.co' },
        { id: 'a4', email: 'a4@x.co' },
      ],
    );
    const result = (await handler(req)) as SwellData;
    expect(result.done).toBe(true);
    const chain = fetchMock.mock.calls.find(([u]: [string]) =>
      String(u).includes('sync?page='),
    );
    expect(chain).toBeUndefined();

    const short = makeRequest({ key: 'shh', page: '1' }, [
      { id: 'a1', email: 'a1@x.co' },
    ]);
    const shortResult = (await handler(short.req)) as SwellData;
    expect(shortResult.done).toBe(true);
  }, 20000);
});
