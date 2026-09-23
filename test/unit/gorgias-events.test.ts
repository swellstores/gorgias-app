import { describe, it, expect, vi } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import handler from '../../functions/gorgias-events';

const settings = {
  connection: { subdomain: 'acme', shared_secret: 'shh' },
  sync: { enabled: true },
};

function makeRequest(options: {
  query?: Record<string, string>;
  account?: SwellData | null;
  headers?: Record<string, string>;
}) {
  const put = vi.fn().mockResolvedValue({});
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  const req = createMockRequest({
    query: options.query || {},
    headers: options.headers,
    store: { url: 'https://store.example.com' },
    swell: {
      settings: vi.fn().mockResolvedValue(settings),
      get: vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith('/accounts/')) {
          if (options.account === null) throw new Error('not found');
          return options.account;
        }
        return { results: options.account ? [options.account] : [] };
      }),
      put,
    },
  });
  (req as any).rawBody = '';
  return { req, put, fetchMock };
}

describe('gorgias-events handler', () => {
  it('rejects requests without the shared secret', async () => {
    const { req } = makeRequest({ query: { ticket_id: '1' } });
    const res = (await handler(req)) as Response;
    expect(res.status).toBe(401);
  });

  it('records a ticket ref on the matched account', async () => {
    const { req, put } = makeRequest({
      query: {
        key: 'shh',
        ticket_id: '77',
        email: 'jane@example.com',
        external_id: 'acc1',
        subject: 'Where is my order?',
        status: 'open',
        channel: 'email',
      },
      account: { id: 'acc1', $app: { gorgias: { tickets: [] } } },
    });
    const result = (await handler(req)) as SwellData;
    expect(result.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][1].$app.gorgias.tickets).toBeNull();
    const [url, body] = put.mock.calls[1];
    expect(url).toBe('/accounts/acc1');
    const values = body.$app.gorgias;
    expect(values.tickets[0]).toMatchObject({
      id: '77',
      subject: 'Where is my order?',
      status: 'open',
      url: 'https://acme.gorgias.com/app/ticket/77',
    });
    expect(values.open_ticket_count).toBe(1);
    expect(values.last_ticket_url).toBe('https://acme.gorgias.com/app/ticket/77');
  });

  it('dedupes by ticket id and caps the list at 20', async () => {
    const existing = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 100),
      status: 'closed',
    }));
    existing[0] = { id: '77', status: 'closed' };
    const { req, put } = makeRequest({
      query: { key: 'shh', ticket_id: '77', external_id: 'acc1', status: 'open' },
      account: { id: 'acc1', $app: { gorgias: { tickets: existing } } },
    });
    await handler(req);
    const values = put.mock.calls[1][1].$app.gorgias;
    expect(values.tickets).toHaveLength(20);
    expect(values.tickets.filter((t: SwellData) => t.id === '77')).toHaveLength(1);
    expect(values.tickets[0].status).toBe('open');
  });

  it('triggers a refresh sync for unlinked customers', async () => {
    const { req, fetchMock } = makeRequest({
      query: { key: 'shh', ticket_id: '5', email: 'jane@example.com' },
      account: { id: 'acc2' },
    });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://store.example.com/functions/gorgias/sync?account_id=acc2',
    );
    expect(init.headers['X-Swell-Gorgias-Secret']).toBe('shh');
  });

  it('returns ok without side effects when no account matches', async () => {
    const { req, put } = makeRequest({
      query: { key: 'shh', ticket_id: '5', email: 'stranger@example.com' },
      account: undefined,
    });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('no_matching_account');
    expect(put).not.toHaveBeenCalled();
  });
});
