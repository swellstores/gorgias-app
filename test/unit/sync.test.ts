import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from '../../functions/sync';
import {
  INTERNAL_SECRET,
  connectedState,
  createAppRequest,
  createFakeSwell,
  mockFetch,
} from '../helpers/fakes';

const settings = {
  sync: { enabled: true, backfill_limit: '4' },
};
const auth = { 'X-Swell-Gorgias-Secret': INTERNAL_SECRET };
const accounts = [
  { id: 'a1', email: 'a1@x.co' },
  { id: 'a2', email: 'a2@x.co' },
  { id: 'a3', email: 'a3@x.co' },
  { id: 'a4', email: 'a4@x.co' },
  { id: 'a5', email: 'a5@x.co' },
];

function setup(data: SwellData, stateOverrides: SwellData = {}, list = accounts) {
  const { calls } = mockFetch();
  const { swell, db } = createFakeSwell({
    settings,
    state: connectedState({
      internal_secret: INTERNAL_SECRET,
      backfill_page: 1,
      backfill_done: false,
      backfill_synced: 0,
      ...stateOverrides,
    }),
    accounts: list,
  });
  return { req: createAppRequest({ swell, data, headers: auth }), db, calls };
}

describe('sync function', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects without the internal secret header', async () => {
    const { swell } = createFakeSwell({ settings, state: { internal_secret: INTERNAL_SECRET } });
    const res = (await handler(createAppRequest({ swell, data: { page: 1 } }))) as Response;
    expect(res.status).toBe(401);
  });

  it('refresh mode syncs a single account with the OAuth token', async () => {
    const { req, calls } = setup({ account_id: 'a1' });
    const result = (await handler(req)) as SwellData;
    expect(result).toMatchObject({ mode: 'refresh', synced: true, gorgias_customer_id: 9 });
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/customers'))!;
    expect(created.headers.Authorization).toBe('Bearer gorgias-access-token');
  }, 20000);

  it('skips when Gorgias is not connected', async () => {
    const { req, calls } = setup({ account_id: 'a1' }, { access_token: null, refresh_token: null });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('not_connected');
    expect(calls).toHaveLength(0);
  });

  it('imports the expected page, saves progress and chains to the next', async () => {
    const { req, db, calls } = setup({ page: 1 });
    const result = (await handler(req)) as SwellData;
    expect(result).toMatchObject({ mode: 'import', processed: 2, done: false });
    expect(db.state).toMatchObject({ backfill_page: 2, backfill_done: false, backfill_synced: 2 });
    const chain = calls.find((c) => c.url.includes('/functions/gorgias/sync'))!;
    expect(chain.url).toBe('https://teststore.swell.store/functions/gorgias/sync');
    expect(chain.body).toEqual({ page: 2 });
    expect(chain.headers['x-swell-gorgias-secret']).toBe(INTERNAL_SECRET);
  }, 20000);

  it('stops at the configured limit', async () => {
    // limit 4, batch 2 → page 2 is the last
    const { req, db, calls } = setup({ page: 2 }, { backfill_page: 2, backfill_synced: 2 });
    const result = (await handler(req)) as SwellData;
    expect(result.done).toBe(true);
    expect(db.state).toMatchObject({ backfill_done: true, backfill_synced: 4 });
    expect(calls.some((c) => c.url.includes('/functions/gorgias/sync'))).toBe(false);
  }, 20000);

  it('stops on a short page', async () => {
    const { req, db } = setup({ page: 1 }, {}, [accounts[0]]);
    const result = (await handler(req)) as SwellData;
    expect(result.done).toBe(true);
    expect(db.state!.backfill_done).toBe(true);
  }, 20000);

  it('skips pages that are not the expected next page', async () => {
    const { req, calls } = setup({ page: 1 }, { backfill_page: 3 });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('stale_page');
    expect(calls).toHaveLength(0);
  });
});
