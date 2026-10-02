import { appSecrets, verifySecretHeader } from './lib/auth';
import { callSync } from './lib/connect';
import { GorgiasClient, connectionFromSettings } from './lib/gorgias';
import { loadState, saveState } from './lib/state';
import { syncAccountToGorgias } from './lib/sync-account';

export const config: SwellConfig = {
  description:
    'Import existing customers into Gorgias in small batches, or refresh one customer (called by the app itself)',
  route: {
    public: true,
    methods: ['post'],
    headers: ['x-swell-gorgias-secret'],
  },
  timeout: 10000,
};

// Small batches with a self-invocation chain: each invocation stays within the
// 10s function budget and the Gorgias rate bucket (40 req/20s). Progress is
// saved after every batch, and reconcile() restarts a stalled chain from it.
const BATCH_SIZE = 2;

export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  const connection = connectionFromSettings(settings);
  const secrets = connection ? await appSecrets(connection, req.store.id) : null;
  if (!connection || !secrets || !verifySecretHeader(req.headers, secrets.internal)) {
    return new SwellResponse({ error: 'unauthorized' }, { status: 401 });
  }
  if (!settings?.sync?.enabled) {
    return { skipped: 'sync_disabled' };
  }

  let state = await loadState(req.swell);
  const gorgias = new GorgiasClient(connection);
  const params: SwellData = req.data || {};

  // Refresh mode: sync one account
  if (params.account_id) {
    const result = await syncAccountToGorgias(
      req.swell,
      gorgias,
      String(params.account_id),
    );
    return { mode: 'refresh', ...result };
  }

  // Import mode: process the expected page, then chain to the next
  const page = Math.max(1, parseInt(String(params.page || '1'), 10));
  if (state.backfill_done || page !== (state.backfill_page || 1)) {
    return { mode: 'import', skipped: 'stale_page', page };
  }
  const limit = parseInt(settings.sync.backfill_limit || '500', 10);
  const maxPages = Math.ceil(limit / BATCH_SIZE);

  const res = await req.swell.get('/accounts', {
    where: { order_count: { $gt: 0 } },
    sort: 'date_last_order desc',
    limit: BATCH_SIZE,
    page,
  });
  const accounts: SwellData[] = res?.results || [];

  const results = [];
  for (const account of accounts) {
    try {
      results.push(await syncAccountToGorgias(req.swell, gorgias, account.id));
    } catch (err) {
      console.error(`Import of account ${account.id} failed: ${String(err)}`);
      results.push({
        account_id: account.id,
        synced: false,
        reason: String(err),
      });
    }
  }

  const done = accounts.length < BATCH_SIZE || page >= maxPages;
  state = await saveState(req.swell, state, {
    backfill_page: done ? page : page + 1,
    backfill_done: done,
    backfill_synced:
      (state.backfill_synced || 0) + results.filter((r) => r.synced).length,
    date_backfill_updated: new Date().toISOString(),
  });
  if (!done) {
    callSync(req, secrets, { page: page + 1 });
  }

  return { mode: 'import', page, processed: accounts.length, done, results };
}
