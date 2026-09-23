import { requestParams, verifySharedSecret } from './lib/auth';
import { clientFromSettings } from './lib/gorgias';
import { syncAccountToGorgias } from './lib/sync-account';
import { functionUrl } from './lib/urls';

export const config: SwellConfig = {
  description:
    'Sync customers to Gorgias: single-account refresh or self-chaining backfill',
  route: {
    public: true,
    methods: ['post'],
  },
  timeout: 10000,
};

// Small batches with a self-invocation chain: each invocation stays within the
// 10s function budget and the Gorgias rate bucket (40 req/20s); re-running is
// idempotent, so a dropped chain link is recovered by re-running connect.
const BATCH_SIZE = 2;


export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  const secret: string | undefined = settings?.connection?.shared_secret;

  if (!verifySharedSecret(req, secret)) {
    return new SwellResponse({ error: 'unauthorized' }, { status: 401 });
  }
  if (!settings?.sync?.enabled) {
    return { skipped: 'sync_disabled' };
  }

  const gorgias = clientFromSettings(settings);
  const appId = req.appId || 'gorgias';
  const params = requestParams(req);
  const env = req.headers.get('swell-env');

  // Refresh mode: sync one account
  if (params.account_id) {
    const result = await syncAccountToGorgias(
      req.swell,
      gorgias,
      params.account_id,
      req.store,
      env,
    );
    return { mode: 'refresh', ...result };
  }

  // Backfill mode: process one page, then chain to the next
  const limit = parseInt(settings.sync.backfill_limit || '500', 10);
  const page = Math.max(1, parseInt(params.page || '1', 10));
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
      results.push(
        await syncAccountToGorgias(
          req.swell,
          gorgias,
          account.id,
          req.store,
          env,
        ),
      );
    } catch (err) {
      results.push({
        account_id: account.id,
        synced: false,
        reason: String(err),
      });
    }
  }

  const done = accounts.length < BATCH_SIZE || page >= maxPages;
  if (!done) {
    const next = fetch(
      `${functionUrl(req.store, appId, 'sync')}?page=${page + 1}`,
      {
        method: 'POST',
        headers: {
          'X-Swell-Gorgias-Secret': secret!,
          ...(req.publicKey ? { Authorization: req.publicKey } : {}),
        },
      },
    ).catch(() => undefined);
    req.context?.waitUntil?.(next);
  }

  return { mode: 'backfill', page, processed: accounts.length, done, results };
}
