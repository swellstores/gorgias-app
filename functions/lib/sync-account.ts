// Shared account loading and Gorgias sync, used by sync-customer.ts
// (event-triggered), sync.ts (import/refresh), and gorgias-events.ts
// (serves the sidebar widget response).

import { GorgiasClient } from './gorgias';
import { accountName, accountPhone, buildCustomerData } from './payload';

interface SwellGetter {
  get(url: string, query?: any): Promise<any>;
}

// Account fields that change what the Gorgias customer looks like. Mirrored by
// the event conditions in sync-customer.ts.
export const CONTACT_FIELDS = [
  'email',
  'name',
  'first_name',
  'last_name',
  'phone',
  'shipping',
  'billing',
];

export function changesContactDetails(event?: SwellData): boolean {
  if (event?.type !== 'account.updated') return true;
  const changed = event.data || {};
  return CONTACT_FIELDS.some((f) => f in changed);
}

export interface SyncResult {
  account_id: string;
  synced: boolean;
  reason?: string;
  gorgias_customer_id?: number;
}

// Build the sidebar payload for an account already loaded by the caller.
export async function loadAccountData(
  swell: SwellGetter,
  account: SwellData,
  store: { admin_url?: string },
  env?: string | null,
): Promise<SwellData> {
  const ordersRes = await swell.get('/orders', {
    account_id: account.id,
    limit: 5,
    sort: 'date_created desc',
    expand: ['shipments'],
  });

  return buildCustomerData({
    account,
    orders: ordersRes?.results || [],
    store,
    env,
  });
}

export async function syncAccountToGorgias(
  swell: SwellGetter,
  gorgias: GorgiasClient,
  accountId: string,
): Promise<SyncResult> {
  const account = await swell.get(`/accounts/${accountId}`);
  if (!account) {
    return { account_id: accountId, synced: false, reason: 'account_not_found' };
  }
  if (!account.email) {
    return { account_id: accountId, synced: false, reason: 'no_email' };
  }

  const customer = await gorgias.upsertCustomer({
    email: account.email,
    name: accountName(account),
    external_id: account.id,
    phone: accountPhone(account),
  });

  return {
    account_id: accountId,
    synced: true,
    gorgias_customer_id: customer?.id,
  };
}
