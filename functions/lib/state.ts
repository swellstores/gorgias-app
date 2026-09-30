// Single-record app collection (models/connections.json) holding the Gorgias
// OAuth tokens (written by the frontend/ Worker), generated secrets,
// provisioned Gorgias ids and import progress. Kept out of settings so a stale
// dashboard Save can't overwrite it, and so merchants never handle secrets.

import { randomHex } from './auth';

// Fields set to null are cleared on save.
export interface ConnectionState {
  id?: string;
  // OAuth, written by the Worker when the merchant connects
  gorgias_subdomain?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  refresh_key?: string | null;
  oauth_store_id?: string;
  oauth_env?: string;
  oauth_service_url?: string;
  date_authorized?: string | null;
  // Provisioning
  events_secret?: string | null;
  internal_secret?: string;
  fingerprint?: string | null;
  integration_id?: number | null;
  widget_id?: number | null;
  gorgias_account?: string | null;
  last_error?: string | null;
  last_attempt_fingerprint?: string;
  date_last_attempt?: string;
  date_connected?: string;
  date_checked?: string;
  backfill_subdomain?: string;
  backfill_page?: number;
  backfill_done?: boolean;
  backfill_synced?: number;
  date_backfill_updated?: string;
}

interface SwellClient {
  get(url: string, query?: any): Promise<any>;
  put(url: string, data: any): Promise<any>;
  post(url: string, data: any): Promise<any>;
}

const COLLECTION = '/connections';

export async function loadState(swell: SwellClient): Promise<ConnectionState> {
  const res = await swell.get(COLLECTION, {
    sort: 'date_created asc',
    limit: 1,
  });
  return res?.results?.[0] || {};
}

export async function saveState(
  swell: SwellClient,
  state: ConnectionState,
  values: Partial<ConnectionState>,
): Promise<ConnectionState> {
  const saved = state.id
    ? await swell.put(`${COLLECTION}/${state.id}`, values)
    : await swell.post(COLLECTION, values);
  return { ...state, ...values, ...(saved || {}) };
}

export async function ensureSecrets(
  swell: SwellClient,
  state: ConnectionState,
): Promise<ConnectionState> {
  if (state.id && state.events_secret && state.internal_secret) return state;
  return saveState(swell, state, {
    events_secret: state.events_secret || randomHex(24),
    internal_secret: state.internal_secret || randomHex(24),
  });
}
