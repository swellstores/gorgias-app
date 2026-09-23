import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GorgiasClient, GorgiasError, clientFromSettings } from '../../functions/lib/gorgias';

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

  it('follows a 301 to the merged customer', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 301,
          headers: { Location: 'https://acme.gorgias.com/api/customers/99' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 99 }));
    const client = new GorgiasClient(auth);
    const result = await client.get('/api/customers/12');
    expect(result).toEqual({ id: 99 });
    expect(fetchMock.mock.calls[1][0]).toContain('/api/customers/99');
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

  it('upsertCustomer updates when found, creates when missing', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 5 }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 5 }));
    const client = new GorgiasClient(auth);
    await client.upsertCustomer({ email: 'a@b.c', external_id: 'acc1' });
    expect(fetchMock.mock.calls[1][0]).toContain('/api/customers/5');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 6 }));
    await client.upsertCustomer({ email: 'new@b.c' });
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
  });

  it('putCustomerData writes with a timestamp version, no GET', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new GorgiasClient(auth);
    const result = await client.putCustomerData(5, { customer: {} });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/customers/5/data');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body).version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('upsertCustomer falls back to external_id lookup on create conflict', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // email search: miss
      .mockResolvedValueOnce(
        jsonResponse({ error: { msg: 'already exists' } }, { status: 409 }),
      ) // POST create conflict
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 42 }] })) // external_id lookup
      .mockResolvedValueOnce(jsonResponse({ id: 42 })); // PUT update
    const client = new GorgiasClient(auth);
    const result = await client.upsertCustomer({
      email: 'a@b.c',
      external_id: 'acc9',
    });
    expect(result).toEqual({ id: 42 });
    expect(fetchMock.mock.calls[2][0]).toContain('external_id=acc9');
    expect(fetchMock.mock.calls[3][1].method).toBe('PUT');
  });

  it('listChatIntegrations filters by gorgias_chat type', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 3, name: 'Chat', application_id: 'abc' }] }),
    );
    const client = new GorgiasClient(auth);
    const list = await client.listChatIntegrations();
    expect(list).toEqual([{ id: 3, name: 'Chat', application_id: 'abc' }]);
    expect(fetchMock.mock.calls[0][0]).toContain('type=gorgias_chat');
  });

  it('putCustomerData retries once with a fresh version on 409', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new GorgiasClient(auth);
    await expect(client.putCustomerData(5, {})).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('clientFromSettings', () => {
  it('builds a client from connection settings', () => {
    const client = clientFromSettings({
      connection: { subdomain: ' acme ', email: 'a@b.c', api_key: 'k' },
    });
    expect(client.baseUrl).toBe('https://acme.gorgias.com');
  });
  it('throws when settings are incomplete', () => {
    expect(() => clientFromSettings({ connection: { subdomain: 'x' } })).toThrow(
      /incomplete/,
    );
    expect(() => clientFromSettings({})).toThrow(/incomplete/);
  });
});
