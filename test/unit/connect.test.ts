import { describe, it, expect, afterEach, vi } from 'vitest';
import { ownerTag, reconcile } from '../../functions/lib/connect';
import {
  ACCESS_TOKEN,
  PUBLIC_KEY,
  RENEWED_TOKEN,
  WORKER_URL,
  connectedState,
  createAppRequest,
  createFakeSwell,
  json,
  mockFetch,
} from '../helpers/fakes';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600000).toISOString();

function gorgiasCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => c.url.includes('gorgias.com'));
}

function connected(overrides: SwellData = {}, settings: SwellData = {}) {
  return createFakeSwell({ settings, state: connectedState(overrides) });
}

describe('reconcile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('points to the Connect page until the merchant authorizes the app', async () => {
    const { calls } = mockFetch();
    const { swell, db } = createFakeSwell();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('incomplete');
    expect(db.settings.connection.status).toMatch(/^Not connected\. Open Gorgias in your dashboard menu/);
    expect(calls).toHaveLength(0);
  });

  it('reports a missing public key instead of provisioning', async () => {
    const { calls } = mockFetch();
    const { swell, db } = connected();
    const result = await reconcile(createAppRequest({ swell, publicKey: null }));
    expect(result.status).toBe('error');
    expect(db.settings.connection.status).toMatch(/^Could not connect/);
    expect(calls).toHaveLength(0);
  });

  it('provisions with the OAuth token: secrets, integration, widget, status', async () => {
    const { calls } = mockFetch();
    const { swell, db } = connected();
    const result = await reconcile(createAppRequest({ swell }));

    expect(result).toMatchObject({ status: 'connected', provisioned: true, import: 'off' });
    expect(db.state!.events_secret).toMatch(/^[0-9a-f]{48}$/);
    expect(db.state!.internal_secret).toMatch(/^[0-9a-f]{48}$/);
    expect(db.state!.events_secret).not.toBe(db.state!.internal_secret);
    expect(db.state).toMatchObject({
      integration_id: 11,
      widget_id: 22,
      gorgias_account: 'acme.gorgias.com',
      last_error: null,
    });
    expect(db.settings.connection.status).toMatch(/^Connected to acme\.gorgias\.com\./);

    gorgiasCalls(calls).forEach((c) =>
      expect(c.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`),
    );
    const created = calls.find(
      (c) => c.method === 'POST' && c.url === 'https://acme.gorgias.com/api/integrations',
    )!;
    expect(created.body.http.url).toBe(
      'https://teststore.swell.store/functions/gorgias/gorgias-events',
    );
    expect(created.body.http.headers).toEqual({
      'X-Swell-Gorgias-Secret': db.state!.events_secret,
      Authorization: PUBLIC_KEY,
    });
    expect(created.body.http.triggers['ticket-updated']).toBe(true);
    expect(created.body.description).toContain(await ownerTag(PUBLIC_KEY));
    expect(created.body.description).not.toContain(PUBLIC_KEY);
    // the token has hours left: no refresh
    expect(calls.some((c) => c.url.startsWith(WORKER_URL))).toBe(false);
  }, 20000);

  it('renews an access token that is about to expire through the Worker', async () => {
    const { calls } = mockFetch();
    const { swell, db } = connected({ token_expires_at: hoursFromNow(1) });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('connected');

    const refresh = calls.find((c) => c.url === `${WORKER_URL}/oauth/refresh`)!;
    expect(refresh.method).toBe('POST');
    expect(refresh.body).toEqual({
      store_id: 'teststore',
      env: 'test',
      subdomain: 'acme',
      refresh_token: 'gorgias-refresh-token',
      key: 'refresh-key',
    });
    expect(db.state!.access_token).toBe(RENEWED_TOKEN);
    expect(db.state!.refresh_token).toBe('gorgias-refresh-token');
    gorgiasCalls(calls).forEach((c) =>
      expect(c.headers.Authorization).toBe(`Bearer ${RENEWED_TOKEN}`),
    );
  }, 20000);

  it('stores a rotated refresh token together with its new key', async () => {
    mockFetch((call) =>
      call.url === `${WORKER_URL}/oauth/refresh`
        ? json({
            access_token: RENEWED_TOKEN,
            refresh_token: 'rotated-refresh',
            key: 'rotated-key',
            expires_at: hoursFromNow(24),
          })
        : undefined,
    );
    const { swell, db } = connected({ token_expires_at: hoursFromNow(1) });
    await reconcile(createAppRequest({ swell }));
    expect(db.state).toMatchObject({
      access_token: RENEWED_TOKEN,
      refresh_token: 'rotated-refresh',
      refresh_key: 'rotated-key',
    });
  }, 20000);

  it('forgets revoked access and asks the merchant to reconnect', async () => {
    mockFetch((call) =>
      call.url === `${WORKER_URL}/oauth/refresh`
        ? json({ error: 'invalid_grant' }, 400)
        : undefined,
    );
    const { swell, db } = connected({ token_expires_at: minutesAgo(5) });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result).toMatchObject({ status: 'error', error: 'Gorgias access was revoked' });
    expect(db.state).toMatchObject({
      access_token: null,
      refresh_token: null,
      events_secret: null,
    });
    expect(db.settings.connection.status).toMatch(
      /^Not connected: Gorgias access was revoked\. Open Gorgias in your dashboard menu/,
    );
  }, 20000);

  it('reports a failed renewal and backs off', async () => {
    mockFetch((call) =>
      call.url === `${WORKER_URL}/oauth/refresh` ? json({ error: 'unavailable' }, 502) : undefined,
    );
    const { swell, db } = connected({ token_expires_at: hoursFromNow(1) });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('error');
    expect(db.settings.connection.status).toBe(
      'Could not connect: Could not renew Gorgias access (502)',
    );
    expect(db.state!.refresh_token).toBe('gorgias-refresh-token');

    const retry = mockFetch();
    await reconcile(createAppRequest({ swell }));
    expect(retry.calls).toHaveLength(0);
  }, 20000);

  it('does nothing in Gorgias when nothing changed and it was checked recently', async () => {
    const first = mockFetch();
    const { swell } = connected();
    await reconcile(createAppRequest({ swell }));
    expect(gorgiasCalls(first.calls).length).toBeGreaterThan(0);

    const second = mockFetch();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result).toMatchObject({ status: 'connected', provisioned: false });
    expect(second.calls).toHaveLength(0);
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

  it('backs off after Gorgias refuses access, until the merchant authorizes again', async () => {
    mockFetch((call) =>
      call.url.endsWith('/api/account') ? json({ error: 'nope' }, 401) : undefined,
    );
    const { swell, db } = connected();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('error');
    expect(db.settings.connection.status).toBe(
      "Could not connect: Gorgias refused the app's access (401). Connect again from the Gorgias page in your dashboard",
    );

    const retry = mockFetch();
    await reconcile(createAppRequest({ swell }));
    expect(gorgiasCalls(retry.calls)).toHaveLength(0);

    // The Worker records a new authorization when the merchant reconnects.
    await swell.put('/connections/state1', { date_authorized: new Date().toISOString() });
    const fixed = mockFetch();
    const after = await reconcile(createAppRequest({ swell }));
    expect(after.status).toBe('connected');
    expect(gorgiasCalls(fixed.calls).length).toBeGreaterThan(0);
  }, 20000);

  it('starts the customer import when sync is on', async () => {
    const { calls } = mockFetch();
    const { swell, db } = connected({}, { sync: { enabled: true } });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.import).toBe('started');
    const kick = calls.find((c) => c.url.includes('/functions/gorgias/sync'))!;
    expect(kick.url).toBe('https://teststore.swell.store/functions/gorgias/sync');
    expect(kick.body).toEqual({ page: 1 });
    expect(kick.headers['x-swell-gorgias-secret']).toBe(db.state!.internal_secret);
    expect(kick.headers.Authorization).toBe(PUBLIC_KEY);
    expect(db.state).toMatchObject({ backfill_subdomain: 'acme', backfill_page: 1 });
  }, 20000);

  it('resumes a stalled import from the saved page', async () => {
    const { calls } = mockFetch();
    const { swell } = connected({}, { sync: { enabled: true } });
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

  it('writes the status to the settings record by its own id', async () => {
    mockFetch();
    const { swell } = connected({}, { id: '6aa81465935d8f001217ad00' });
    await reconcile(createAppRequest({ swell }));
    const statusWrites = swell.put.mock.calls
      .map(([url]) => url)
      .filter((url) => url.startsWith('/settings/'));
    expect(statusWrites.length).toBeGreaterThan(0);
    statusWrites.forEach((url) =>
      expect(url).toBe('/settings/6aa81465935d8f001217ad00/connection'),
    );
  }, 20000);

  it('revokes the events secret once the tokens are gone', async () => {
    mockFetch();
    const { swell, db } = connected();
    await reconcile(createAppRequest({ swell }));
    expect(db.state!.events_secret).toBeTruthy();

    await swell.put('/connections/state1', { access_token: null, refresh_token: null });
    const { calls } = mockFetch();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('incomplete');
    expect(db.state!.events_secret).toBeNull();
    expect(db.state!.fingerprint).toBeNull();
    expect(calls).toHaveLength(0);
  }, 20000);

  it('rotates the secret and forgets old ids when switching helpdesks', async () => {
    mockFetch();
    const { swell, db } = connected();
    await reconcile(createAppRequest({ swell }));
    const oldSecret = db.state!.events_secret;

    await swell.put('/connections/state1', {
      gorgias_subdomain: 'other',
      date_authorized: new Date().toISOString(),
    });
    const { calls } = mockFetch();
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('connected');
    expect(db.state!.events_secret).toMatch(/^[0-9a-f]{48}$/);
    expect(db.state!.events_secret).not.toBe(oldSecret);
    expect(db.state!.gorgias_account).toBe('other.gorgias.com');
    // integration 11 belonged to acme; it's never looked up in the new helpdesk
    expect(calls.some((c) => c.url.endsWith('/api/integrations/11'))).toBe(false);
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.url === 'https://other.gorgias.com/api/integrations',
      ),
    ).toBe(true);
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
    expect(db.settings.connection.status).toMatch(/deactivated in Gorgias/);
  }, 20000);

  it('keeps going when the status write fails', async () => {
    mockFetch();
    const { swell } = connected();
    const put = swell.put.getMockImplementation()!;
    swell.put.mockImplementation(async (url: string, data: SwellData) => {
      if (url.startsWith('/settings/')) throw new Error('403 forbidden');
      return put(url, data);
    });
    const result = await reconcile(createAppRequest({ swell }));
    expect(result.status).toBe('connected');
  }, 20000);
});
