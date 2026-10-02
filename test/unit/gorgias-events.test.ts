import { describe, it, expect, afterEach, vi } from 'vitest';
import handler from '../../functions/gorgias-events';
import {
  CONNECTION,
  createAppRequest,
  createFakeSwell,
  mockFetch,
  secretsFor,
} from '../helpers/fakes';

const ACCOUNT_ID = '64f1c2a9e3b7d10012a4f5c1';

async function setup(options: {
  data: SwellData;
  account?: SwellData;
  headers?: Record<string, string>;
  syncEnabled?: boolean;
  connection?: SwellData;
}) {
  const { calls } = mockFetch();
  const { swell } = createFakeSwell({
    settings: {
      connection: options.connection ?? CONNECTION,
      sync: { enabled: options.syncEnabled ?? true },
    },
    accounts: options.account ? [options.account] : [],
    orders: [
      {
        id: 'ord1',
        account_id: ACCOUNT_ID,
        number: 10482,
        status: 'delivery_pending',
        grand_total: 128,
        currency: 'USD',
        items: [{ product_name: 'Linen overshirt', quantity: 1, price_total: 128 }],
      },
    ],
  });
  const auth = { 'X-Swell-Gorgias-Secret': (await secretsFor()).events };
  const req = createAppRequest({
    swell,
    data: options.data,
    headers: options.headers ?? auth,
  });
  return { req, swell, calls };
}

function ticketWrites(swell: SwellData) {
  return swell.put.mock.calls.filter(([url]: [string]) => url.startsWith('/accounts/'));
}

describe('gorgias-events handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects requests without the secret header', async () => {
    const { req } = await setup({ data: { ticket_id: '1' }, headers: {} });
    const res = (await handler(req)) as Response;
    expect(res.status).toBe(401);
  });

  it('does not accept the secret in the body or query', async () => {
    const { req } = await setup({
      data: { ticket_id: '1', key: (await secretsFor()).events },
      headers: {},
    });
    const res = (await handler(req)) as Response;
    expect(res.status).toBe(401);
  });

  it('stops accepting the old secret once the API key changes or is removed', async () => {
    for (const connection of [{ ...CONNECTION, api_key: 'rotated' }, {}]) {
      const { req } = await setup({ data: { ticket_id: '1' }, connection });
      const res = (await handler(req)) as Response;
      expect(res.status).toBe(401);
    }
  });

  it('records the ticket in one $set write and returns the sidebar data', async () => {
    const { req, swell } = await setup({
      data: {
        ticket_id: 77,
        email: 'Jane@Example.com ',
        external_id: ACCOUNT_ID,
        subject: 'Where is my order?',
        status: 'open',
        channel: 'email',
      },
      account: {
        id: ACCOUNT_ID,
        email: 'jane@example.com',
        first_name: 'Jane',
        $app: { gorgias: { tickets: [] } },
      },
    });
    const result = (await handler(req)) as SwellData;

    expect(result.ok).toBe(true);
    expect(result.customer).toMatchObject({ swell_id: ACCOUNT_ID, name: 'Jane' });
    expect(result.orders[0]).toMatchObject({ number: '10482', status: 'delivery_pending' });
    expect(result.orders[0].items[0].name).toBe('Linen overshirt');

    const writes = ticketWrites(swell);
    expect(writes).toHaveLength(1);
    const [url, body] = writes[0];
    expect(url).toBe(`/accounts/${ACCOUNT_ID}`);
    const values = body.$app.gorgias.$set;
    expect(values.tickets[0]).toMatchObject({
      id: '77',
      subject: 'Where is my order?',
      status: 'open',
      url: 'https://acme.gorgias.com/app/ticket/77',
    });
    expect(values.open_ticket_count).toBe(1);
    expect(values.last_ticket_url).toBe('https://acme.gorgias.com/app/ticket/77');
  });

  it('falls back to email when external_id is not a Swell id', async () => {
    const { req, swell } = await setup({
      data: { ticket_id: '5', email: 'jane@example.com', external_id: 'shopify-123' },
      account: { id: ACCOUNT_ID, email: 'jane@example.com' },
    });
    const result = (await handler(req)) as SwellData;
    expect(result.account_id).toBe(ACCOUNT_ID);
    expect(swell.get).not.toHaveBeenCalledWith('/accounts/shopify-123');
  });

  it('dedupes by ticket id and caps the list at 20', async () => {
    const existing = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 100),
      status: 'closed',
    }));
    existing[0] = { id: '77', status: 'closed' };
    const { req, swell } = await setup({
      data: { ticket_id: '77', external_id: ACCOUNT_ID, status: 'open' },
      account: { id: ACCOUNT_ID, email: 'j@x.co', $app: { gorgias: { tickets: existing } } },
    });
    await handler(req);
    const values = ticketWrites(swell)[0][1].$app.gorgias.$set;
    expect(values.tickets).toHaveLength(20);
    expect(values.tickets.filter((t: SwellData) => t.id === '77')).toHaveLength(1);
    expect(values.tickets[0].status).toBe('open');
  });

  it('asks sync to link customers Gorgias does not know yet', async () => {
    const { req, calls } = await setup({
      data: { ticket_id: '5', email: 'jane@example.com' },
      account: { id: ACCOUNT_ID, email: 'jane@example.com' },
    });
    await handler(req);
    const refresh = calls.find((c) => c.url.includes('/functions/gorgias/sync'))!;
    expect(refresh.url).toBe('https://teststore.swell.store/functions/gorgias/sync');
    expect(refresh.body).toEqual({ account_id: ACCOUNT_ID });
    expect(refresh.headers['x-swell-gorgias-secret']).toBe((await secretsFor()).internal);
  });

  it('does not ask sync when sync is off', async () => {
    const { req, calls } = await setup({
      data: { ticket_id: '5', email: 'jane@example.com' },
      account: { id: ACCOUNT_ID, email: 'jane@example.com' },
      syncEnabled: false,
    });
    await handler(req);
    expect(calls).toHaveLength(0);
  });

  it('returns an empty payload without side effects when no account matches', async () => {
    const { req, swell } = await setup({
      data: { ticket_id: '5', email: 'stranger@example.com' },
    });
    const result = (await handler(req)) as SwellData;
    expect(result).toMatchObject({ skipped: 'no_matching_account', customer: null, orders: [] });
    expect(ticketWrites(swell)).toHaveLength(0);
  });
});
