import { describe, it, expect, afterEach, vi } from 'vitest';
import handler, { config } from '../../functions/sync-customer';
import { changesContactDetails } from '../../functions/lib/sync-account';
import {
  BASIC_AUTH,
  CONNECTION,
  createAppRequest,
  createFakeSwell,
  json,
  mockFetch,
} from '../helpers/fakes';

const settings = {
  connection: CONNECTION,
  sync: { enabled: true },
};

describe('sync-customer config', () => {
  it('uses the nested $settings condition form the platform evaluates', () => {
    const conditions = (config as SwellData).model.conditions;
    expect(conditions.$settings).toEqual({ sync: { enabled: true } });
    expect(conditions).not.toHaveProperty(['$settings.sync.enabled']);
  });
});

describe('changesContactDetails', () => {
  it('passes creates and orders, and updates that touch contact fields', () => {
    expect(changesContactDetails({ type: 'account.created', data: {} })).toBe(true);
    expect(changesContactDetails({ type: 'order.submitted', data: {} })).toBe(true);
    expect(
      changesContactDetails({ type: 'account.updated', data: { phone: '+1' } }),
    ).toBe(true);
  });
  it("skips updates that only touch this app's fields", () => {
    expect(
      changesContactDetails({
        type: 'account.updated',
        data: { $app: { gorgias: {} }, date_updated: 'x' },
      }),
    ).toBe(false);
  });
});

describe('sync-customer handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ignores ticket-only account updates without calling Gorgias', async () => {
    const { calls } = mockFetch();
    const { swell } = createFakeSwell({ settings });
    const req = createAppRequest({
      swell,
      data: { id: 'a1', $event: { type: 'account.updated', data: { $app: {} } } },
    });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('no_contact_changes');
    expect(calls).toHaveLength(0);
  });

  it('syncs the account behind a submitted order', async () => {
    const { calls } = mockFetch();
    const { swell } = createFakeSwell({
      settings,
      accounts: [{ id: 'a1', email: 'a1@x.co', first_name: 'Ann' }],
    });
    const req = createAppRequest({
      swell,
      data: { id: 'o1', account_id: 'a1', $event: { type: 'order.submitted', data: {} } },
    });
    const result = (await handler(req)) as SwellData;
    expect(result).toMatchObject({ account_id: 'a1', synced: true });
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/customers'))!;
    expect(created.body).toMatchObject({ email: 'a1@x.co', name: 'Ann', external_id: 'a1' });
    expect(created.headers.Authorization).toBe(BASIC_AUTH);
  }, 20000);

  it('skips without throwing when the connection is incomplete', async () => {
    const { calls } = mockFetch();
    const { swell } = createFakeSwell({ settings: { sync: { enabled: true }, connection: {} } });
    const req = createAppRequest({
      swell,
      data: { id: 'a1', $event: { type: 'account.created', data: {} } },
    });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('not_connected');
    expect(calls).toHaveLength(0);
  });

  it('skips without throwing when Gorgias rejects the credentials', async () => {
    mockFetch((call) =>
      call.url.includes('gorgias.com') ? json({ error: 'nope' }, 401) : undefined,
    );
    const { swell } = createFakeSwell({
      settings,
      accounts: [{ id: 'a1', email: 'a1@x.co' }],
    });
    const req = createAppRequest({
      swell,
      data: { id: 'a1', $event: { type: 'account.created', data: {} } },
    });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('gorgias_auth_failed');
  });

  it('does nothing when sync is off', async () => {
    const { calls } = mockFetch();
    const { swell } = createFakeSwell({ settings: { ...settings, sync: { enabled: false } } });
    const req = createAppRequest({
      swell,
      data: { id: 'a1', $event: { type: 'account.created', data: {} } },
    });
    const result = (await handler(req)) as SwellData;
    expect(result.skipped).toBe('sync_disabled');
    expect(calls).toHaveLength(0);
  });
});
