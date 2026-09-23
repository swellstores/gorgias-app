import {
  requestParams,
  verifyGorgiasHmac,
  verifySharedSecret,
} from './lib/auth';
import { loadAccountData } from './lib/sync-account';
import { functionUrl } from './lib/urls';

export const config: SwellConfig = {
  description:
    'Receives Gorgias ticket events: records ticket refs on Swell accounts and returns the customer payload rendered by the Gorgias sidebar widget',
  route: {
    public: true,
  },
};

const MAX_TICKETS = 20;

// Gorgias allows 5s for this call. The JSON response is the data source for
// the http-type sidebar widget (customer profile + recent orders).
export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  const secret: string | undefined = settings?.connection?.shared_secret;

  if (!verifySharedSecret(req, secret)) {
    return new SwellResponse({ error: 'unauthorized' }, { status: 401 });
  }
  const signature =
    req.headers.get('x-gorgias-signature') ||
    req.headers.get('x-hub-signature-256');
  if (!(await verifyGorgiasHmac(req.rawBody || '', signature, secret!))) {
    return new SwellResponse({ error: 'invalid signature' }, { status: 401 });
  }

  const { ticket_id, email, external_id, subject, status, channel } =
    requestParams(req);
  if (!ticket_id) {
    return { ok: true, skipped: 'no_ticket', customer: null };
  }

  // Resolve the Swell account: external_id is the Swell account id when the
  // Gorgias customer has been synced; otherwise fall back to email match.
  let account: SwellData | null = null;
  if (external_id) {
    account = await req.swell
      .get(`/accounts/${external_id}`, { $app: true })
      .catch(() => null);
  }
  if (!account && email) {
    const res = await req.swell.get('/accounts', {
      where: { email: String(email).toLowerCase() },
      limit: 1,
      $app: true,
    });
    account = res?.results?.[0] || null;
  }
  if (!account) {
    return { ok: true, skipped: 'no_matching_account', customer: null };
  }

  const subdomain = settings?.connection?.subdomain;
  const appId = req.appId || 'gorgias';
  const existing: SwellData[] = account.$app?.[appId]?.tickets || [];

  const entry = {
    id: String(ticket_id),
    subject: subject || '',
    status: status || '',
    channel: channel || '',
    url: subdomain
      ? `https://${subdomain}.gorgias.com/app/ticket/${ticket_id}`
      : '',
    date_updated: new Date().toISOString(),
  };

  const tickets = [
    entry,
    ...existing.filter((t) => String(t.id) !== entry.id),
  ].slice(0, MAX_TICKETS);

  // Arrays under $app merge positionally on write — null first to replace.
  await req.swell.put(
    `/accounts/${account.id}`,
    req.appValues({ tickets: null }),
  );
  await req.swell.put(
    `/accounts/${account.id}`,
    req.appValues({
      tickets,
      open_ticket_count: tickets.filter((t) => t.status === 'open').length,
      last_ticket_subject: entry.subject,
      last_ticket_url: entry.url,
      last_ticket_at: entry.date_updated,
    }),
  );

  // First contact from a customer Gorgias doesn't know yet: enrich their
  // Gorgias identity (external_id, phone) fire-and-forget to stay under the
  // 5s response budget.
  if (!external_id && settings?.sync?.enabled) {
    const refresh = fetch(
      `${functionUrl(req.store, appId, 'sync')}?account_id=${account.id}`,
      {
        method: 'post',
        headers: {
          'X-Swell-Gorgias-Secret': secret!,
          ...(req.publicKey ? { Authorization: req.publicKey } : {}),
        },
      },
    ).catch(() => undefined);
    req.context?.waitUntil?.(refresh);
  }

  // The response body is the widget's data source.
  const { data } = await loadAccountData(
    req.swell,
    account.id,
    req.store,
    req.headers.get('swell-env'),
  );
  return {
    ok: true,
    account_id: account.id,
    ticket_count: tickets.length,
    customer: data?.customer || null,
    orders: data?.orders || [],
    subscriptions: data?.subscriptions || [],
  };
}
