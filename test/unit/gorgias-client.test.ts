import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GorgiasClient,
  clientFromSettings,
  connectionFromSettings,
  customerCreateBody,
  customerUpdateBody,
  hasConnection,
  normalizeSubdomain,
} from '../../functions/lib/gorgias';

const auth = { subdomain: 'acme', email: 'agent@acme.com', apiKey: 'key123' };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('GorgiasClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends Basic auth to the subdomain base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));
    const client = new GorgiasClient(auth);
    await client.get('/api/account');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.gorgias.com/api/account');
    expect(init.headers.Authorization).toBe(
      `Basic ${btoa('agent@acme.com:key123')}`,
    );
  });

  it('retries on 429 honoring Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new GorgiasClient(auth);
    const result = await client.get('/api/account');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a relative 301 to the merged customer', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 301,
          headers: { Location: '/api/customers/99' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 99 }));
    const client = new GorgiasClient(auth);
    const result = await client.get('/api/customers/12');
    expect(result).toEqual({ id: 99 });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://acme.gorgias.com/api/customers/99',
    );
  });

  it('throws GorgiasError with status and body on failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'nope' }, { status: 403 }),
    );
    const client = new GorgiasClient(auth);
    await expect(client.get('/api/account')).rejects.toMatchObject({
      status: 403,
      body: { error: 'nope' },
    });
  });

  it('upsertCustomer looks up by external_id first and updates', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 5, channels: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 5 }));
    const client = new GorgiasClient(auth);
    await client.upsertCustomer({
      email: 'a@b.c',
      name: 'Ann Bee',
      external_id: '64f1c2a9e3b7d10012a4f5c1',
    });
    expect(fetchMock.mock.calls[0][0]).toContain(
      'external_id=64f1c2a9e3b7d10012a4f5c1',
    );
    expect(fetchMock.mock.calls[1][0]).toContain('/api/customers/5');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      name: 'Ann Bee',
      email: 'a@b.c',
    });
  }, 10000);

  it('upsertCustomer falls back to email, then creates with an email channel', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // external_id miss
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // email miss
      .mockResolvedValueOnce(jsonResponse({ id: 6 }));
    const client = new GorgiasClient(auth);
    await client.upsertCustomer({
      email: 'new@b.c',
      external_id: '64f1c2a9e3b7d10012a4f5c1',
      phone: '+15551234567',
    });
    expect(fetchMock.mock.calls[1][0]).toContain('email=new%40b.c');
    const [, init] = fetchMock.mock.calls[2];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).channels).toEqual([
      { type: 'email', address: 'new@b.c', preferred: true },
      { type: 'phone', address: '+15551234567' },
    ]);
  }, 10000);

  it('upsertCustomer recovers from a create conflict via the email channel', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // email miss (no external_id)
      .mockResolvedValueOnce(
        jsonResponse({ error: { msg: 'already exists' } }, { status: 409 }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 42 }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 42 }));
    const client = new GorgiasClient(auth);
    const result = await client.upsertCustomer({ email: 'a@b.c' });
    expect(result).toEqual({ id: 42 });
    expect(fetchMock.mock.calls[2][0]).toContain('channel_address=a%40b.c');
    expect(fetchMock.mock.calls[3][1].method).toBe('PUT');
  }, 10000);

  it('fetches the full customer before adding a phone to a list match', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 5 }] })) // external_id hit, no channels
      .mockResolvedValueOnce(
        jsonResponse({
          id: 5,
          channels: [{ type: 'email', address: 'a@b.c', preferred: true }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 5 }));
    const client = new GorgiasClient(auth);
    await client.upsertCustomer({
      email: 'a@b.c',
      external_id: '64f1c2a9e3b7d10012a4f5c1',
      phone: '+15551234567',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://acme.gorgias.com/api/customers/5');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).channels).toEqual([
      { type: 'email', address: 'a@b.c', preferred: true },
      { type: 'phone', address: '+15551234567' },
    ]);
  }, 10000);

  it('keeps the link when an updated email belongs to another customer', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 5, channels: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'conflict' }, { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ id: 5 }));
    const client = new GorgiasClient(auth);
    const result = await client.upsertCustomer({
      email: 'changed@b.c',
      name: 'Ann',
      external_id: '64f1c2a9e3b7d10012a4f5c1',
    });
    expect(result).toEqual({ id: 5 });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      name: 'Ann',
      external_id: '64f1c2a9e3b7d10012a4f5c1',
    });
  }, 10000);

  it('listIntegrations follows next_cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 1 }], meta: { next_cursor: 'c2' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 2 }], meta: {} }));
    const client = new GorgiasClient(auth);
    const list = await client.listIntegrations();
    expect(list.map((i) => i.id)).toEqual([1, 2]);
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=c2');
  });

  it('listWidgets accepts a bare array response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 8 }]));
    const client = new GorgiasClient(auth);
    expect(await client.listWidgets(7)).toEqual([{ id: 8 }]);
    expect(fetchMock.mock.calls[0][0]).toContain('integration_id=7');
  });

  it('getIntegration returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    const client = new GorgiasClient(auth);
    expect(await client.getIntegration(7)).toBeNull();
  });
});

describe('customer bodies', () => {
  it('create includes the email channel, plus phone when known', () => {
    expect(customerCreateBody({ email: 'a@b.c' }).channels).toEqual([
      { type: 'email', address: 'a@b.c', preferred: true },
    ]);
  });
  it('update leaves channels alone unless a new phone must be added', () => {
    const existing = {
      channels: [{ type: 'email', address: 'a@b.c', preferred: true }],
    };
    expect(customerUpdateBody(existing, { email: 'a@b.c' }).channels).toBeUndefined();
    expect(
      customerUpdateBody(existing, { email: 'a@b.c', phone: '+1555' }).channels,
    ).toEqual([
      { type: 'email', address: 'a@b.c', preferred: true },
      { type: 'phone', address: '+1555' },
    ]);
    const withPhone = {
      channels: [...existing.channels, { type: 'phone', address: '+1555' }],
    };
    expect(
      customerUpdateBody(withPhone, { email: 'a@b.c', phone: '+1555' }).channels,
    ).toBeUndefined();
  });
});

describe('connection settings', () => {
  it('builds a client from complete settings', () => {
    const client = clientFromSettings({
      connection: { subdomain: ' Acme.gorgias.com ', email: ' a@b.c ', api_key: ' k ' },
    });
    expect(client.baseUrl).toBe('https://acme.gorgias.com');
    expect(connectionFromSettings({
      connection: { subdomain: 'acme', email: ' a@b.c ', api_key: ' k ' },
    })).toEqual({ subdomain: 'acme', email: 'a@b.c', apiKey: 'k' });
  });
  it('treats incomplete settings or a bad subdomain as not connected', () => {
    expect(hasConnection({ connection: { subdomain: 'x' } })).toBe(false);
    expect(hasConnection({})).toBe(false);
    expect(
      hasConnection({ connection: { subdomain: 'evil.com/x', email: 'a@b.c', api_key: 'k' } }),
    ).toBe(false);
    expect(() => clientFromSettings({ connection: { subdomain: 'x' } })).toThrow(/incomplete/);
  });
  it('normalizes what merchants type as their helpdesk', () => {
    expect(normalizeSubdomain('Acme')).toBe('acme');
    expect(normalizeSubdomain('acme.gorgias.com')).toBe('acme');
    expect(normalizeSubdomain('https://acme.gorgias.com/app/tickets')).toBe('acme');
    expect(normalizeSubdomain('evil.com')).toBeNull();
    expect(normalizeSubdomain('')).toBeNull();
  });
});
