// Shared account-data loading and Gorgias sync, used by sync-customer.ts
// (event-triggered), sync.ts (backfill/refresh), and gorgias-events.ts
// (serves the sidebar widget response).

import { GorgiasClient } from './gorgias';
import { accountPhone, buildCustomerData } from './payload';

interface SwellGetter {
  get(url: string, query?: any): Promise<any>;
}

export interface SyncResult {
  account_id: string;
  synced: boolean;
  reason?: string;
  gorgias_customer_id?: number;
  data_pushed?: boolean;
}

// Fetch a Swell account + recent commerce data and build the sidebar payload.
export async function loadAccountData(
  swell: SwellGetter,
  accountId: string,
  store: { admin_url?: string },
  env?: string | null,
): Promise<{ account: SwellData | null; data: SwellData | null }> {
  const account = await swell.get(`/accounts/${accountId}`);
  if (!account?.email) {
    return { account: account || null, data: null };
  }

  const [ordersRes, subsRes] = await Promise.all([
    swell.get('/orders', {
      account_id: accountId,
      limit: 5,
      sort: 'date_created desc',
      expand: ['shipments', 'items.product'],
    }),
    swell.get('/subscriptions', {
      account_id: accountId,
      limit: 5,
      sort: 'date_created desc',
    }),
  ]);

  const data = buildCustomerData({
    account,
    orders: ordersRes?.results || [],
    subscriptions: subsRes?.results || [],
    store,
    env,
  });

  return { account, data };
}

export async function syncAccountToGorgias(
  swell: SwellGetter,
  gorgias: GorgiasClient,
  accountId: string,
  store: { admin_url?: string },
  env?: string | null,
): Promise<SyncResult> {
  const { account, data } = await loadAccountData(swell, accountId, store, env);
  if (!account) {
    return { account_id: accountId, synced: false, reason: 'account_not_found' };
  }
  if (!data) {
    return { account_id: accountId, synced: false, reason: 'no_email' };
  }

  const customer = await gorgias.upsertCustomer({
    email: account.email,
    firstname: account.first_name,
    lastname: account.last_name,
    external_id: account.id,
    phone: accountPhone(account),
  });

  // OAuth-only endpoint: returns null on Basic-auth installs (widget data is
  // served by the http integration pull instead).
  const pushed = await gorgias.putCustomerData(customer.id, data);

  return {
    account_id: accountId,
    synced: true,
    gorgias_customer_id: customer.id,
    data_pushed: pushed !== null,
  };
}
