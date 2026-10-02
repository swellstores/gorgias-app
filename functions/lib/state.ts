// Single-record app collection (models/connections.json) holding provisioned
// Gorgias ids, connection health and import progress. Kept out of settings so
// a stale dashboard Save can't overwrite it. It holds no secrets: anything
// written here also lands in the store's request logs (see appSecrets).

// Fields set to null are cleared on save.
export interface ConnectionState {
  id?: string;
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
