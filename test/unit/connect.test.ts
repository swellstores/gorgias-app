import { describe, it, expect, afterEach, vi } from 'vitest';
import { ownerTag, reconcile } from '../../functions/lib/connect';
import {
  BASIC_AUTH,
  CONNECTION,
  PUBLIC_KEY,
  createAppRequest,
  createFakeSwell,
  json,
  mockFetch,
  secretsFor,
} from '../helpers/fakes';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

function gorgiasCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => c.url.includes('gorgias.com'));
}

function connected(settings: SwellData = {}) {
  return createFakeSwell({ settings: { connection: { ...CONNECTION }, ...settings } });
}

describe('reconcile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops when settings are incomplete', async () => {
    const { calls } = mockFetch();
    const { swell } = createFakeSwell({ settings: { connection: {} } });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('incomplete');
    expect(calls).toHaveLength(0);
  });

  it('treats a subdomain that is not a single helpdesk name as missing', async () => {
    const { calls } = mockFetch();
    const { swell } = createFakeSwell({
      settings: { connection: { ...CONNECTION, subdomain: 'evil.com/x' } },
    });
    expect((await reconcile(createAppRequest({ swell }))).status).toBe('incomplete');
    expect(calls).toHaveLength(0);
  });

  it('reports a missing public key instead of provisioning', async () => {
    const { calls } = mockFetch();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { swell } = connected();
    const result = await reconcile(createAppRequest({ swell, publicKey: null }));
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no app public key/);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^Gorgias connection failed: .*no app public key/),
    );
    expect(calls).toHaveLength(0);
    log.mockRestore();
  });

  it('connects on first run: provisions with a derived secret', async () => {
    const { calls } = mockFetch();
    const { swell, db } = connected();
    const result = await reconcile(createAppRequest({ swell }));

    expect(result).toMatchObject({ status: 'connected', provisioned: true, import: 'off' });
    expect(db.state).toMatchObject({
      integration_id: 11,
      widget_id: 22,
      gorgias_account: 'acme.gorgias.com',
      last_error: null,
    });

    gorgiasCalls(calls).forEach((c) => expect(c.headers.Authorization).toBe(BASIC_AUTH));
    const created = calls.find(
      (c) => c.method === 'POST' && c.url === 'https://acme.gorgias.com/api/integrations',
    )!;
    expect(created.body.http.url).toBe(
      'https://teststore.swell.store/functions/gorgias/gorgias-events',
    );
    expect(created.body.http.headers).toEqual({
      'X-Swell-Gorgias-Secret': (await secretsFor()).events,
      Authorization: PUBLIC_KEY,
    });
    expect(created.body.http.triggers['ticket-updated']).toBe(true);
    expect(created.body.description).toContain(await ownerTag(PUBLIC_KEY));
    expect(created.body.description).not.toContain(PUBLIC_KEY);
  }, 20000);

  it('never stores a secret in its state record', async () => {
    mockFetch();
    const { swell } = connected({ sync: { enabled: true } });
    await reconcile(createAppRequest({ swell }));
    const secrets = await secretsFor();
    const writes = JSON.stringify(
      [...swell.put.mock.calls, ...swell.post.mock.calls].filter(([url]) =>
        String(url).startsWith('/connections'),
      ),
    );
    expect(writes).not.toContain(secrets.events);
    expect(writes).not.toContain(secrets.internal);
    expect(writes).not.toContain(CONNECTION.api_key);
  }, 20000);

  it('does nothing in Gorgias when settings are unchanged and recently checked', async () => {
    const first = mockFetch();
    const { swell } = connected();
    await reconcile(createAppRequest({ swell }));
    expect(gorgiasCalls(first.calls).length).toBeGreaterThan(0);

    const second = mockFetch();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result).toMatchObject({ status: 'connected', provisioned: false });
    expect(gorgiasCalls(second.calls)).toHaveLength(0);
  }, 20000);

  it('re-provisions the saved integration when a setting changes', async () => {
    mockFetch();
    const { swell, db } = connected();
    await reconcile(createAppRequest({ swell }));

    db.settings.sync = { sync_ticket_updates: false };
    const { calls } = mockFetch((call) =>
      call.method === 'GET' && call.url.endsWith('/api/integrations/11')
        ? json({ id: 11, type: 'http' })
        : undefined,
    );
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.provisioned).toBe(true);
    const updated = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/api/integrations/11'),
    )!;
    expect(updated.body.http.triggers['ticket-updated']).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/integrations'))).toBe(false);
  }, 20000);

  it('reports rejected credentials and backs off until settings change', async () => {
    mockFetch((call) =>
      call.url.endsWith('/api/account') ? json({ error: 'nope' }, 401) : undefined,
    );
    const { swell, db } = connected();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('error');
    expect(result.error).toBe('Gorgias rejected the agent email or API key (401)');

    const retry = mockFetch();
    await reconcile(createAppRequest({ swell }));
    expect(gorgiasCalls(retry.calls)).toHaveLength(0);

    db.settings.connection.api_key = 'fixed';
    const fixed = mockFetch();
    const after = await reconcile(createAppRequest({ swell }));
    expect(after.status).toBe('connected');
    expect(gorgiasCalls(fixed.calls).length).toBeGreaterThan(0);
  }, 20000);

  it('rotates the Gorgias secret when the API key changes', async () => {
    const first = mockFetch();
    const { swell, db } = connected();
    await reconcile(createAppRequest({ swell }));
    const created = first.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/integrations'))!;
    const before = created.body.http.headers['X-Swell-Gorgias-Secret'];

    db.settings.connection.api_key = 'rotated';
    const { calls } = mockFetch((call) =>
      call.method === 'GET' && call.url.endsWith('/api/integrations/11')
        ? json({ id: 11, type: 'http' })
        : undefined,
    );
    await reconcile(createAppRequest({ swell }));
    const updated = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/api/integrations/11'))!;
    const after = updated.body.http.headers['X-Swell-Gorgias-Secret'];
    expect(after).not.toBe(before);
    expect(after).toBe((await secretsFor({ ...CONNECTION, api_key: 'rotated' })).events);
  }, 20000);

  it('starts the customer import when sync is on', async () => {
    const { calls } = mockFetch();
    const { swell, db } = connected({ sync: { enabled: true } });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.import).toBe('started');
    const kick = calls.find((c) => c.url.includes('/functions/gorgias/sync'))!;
    expect(kick.url).toBe('https://teststore.swell.store/functions/gorgias/sync');
    expect(kick.body).toEqual({ page: 1 });
    expect(kick.headers['x-swell-gorgias-secret']).toBe((await secretsFor()).internal);
    expect(kick.headers.Authorization).toBe(PUBLIC_KEY);
    expect(db.state).toMatchObject({ backfill_subdomain: 'acme', backfill_page: 1 });
  }, 20000);

  it('resumes a stalled import from the saved page', async () => {
    const { calls } = mockFetch();
    const { swell } = connected({ sync: { enabled: true } });
    await reconcile(createAppRequest({ swell }));
    await swell.put('/connections/state1', {
      backfill_page: 4,
      date_backfill_updated: minutesAgo(30),
    });
    calls.length = 0;

    const result = await reconcile(createAppRequest({ swell }));
    expect(result.import).toBe('resumed');
    const kick = calls.find((c) => c.url.includes('/functions/gorgias/sync'))!;
    expect(kick.body).toEqual({ page: 4 });
  }, 20000);

  it('forgets old ids when switching helpdesks', async () => {
    mockFetch();
    const { swell, db } = connected();
    await reconcile(createAppRequest({ swell }));

    db.settings.connection = { ...CONNECTION, subdomain: 'other' };
    const { calls } = mockFetch();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('connected');
    expect(db.state!.gorgias_account).toBe('other.gorgias.com');
    // integration 11 belonged to acme; it's never looked up in the new helpdesk
    expect(calls.some((c) => c.url.endsWith('/api/integrations/11'))).toBe(false);
    const created = calls.find(
      (c) => c.method === 'POST' && c.url === 'https://other.gorgias.com/api/integrations',
    )!;
    expect(created.body.http.headers['X-Swell-Gorgias-Secret']).toBe(
      (await secretsFor({ ...CONNECTION, subdomain: 'other' })).events,
    );
  }, 20000);

  it('reports an integration Gorgias has deactivated', async () => {
    mockFetch();
    const { swell, db } = connected();
    await reconcile(createAppRequest({ swell }));

    db.settings.sync = { sync_ticket_updates: false };
    mockFetch((call) =>
      call.method === 'GET' && call.url.endsWith('/api/integrations/11')
        ? json({ id: 11, type: 'http', deactivated_datetime: '2026-09-20T00:00:00Z' })
        : undefined,
    );
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/deactivated in Gorgias/);
  }, 20000);
});
