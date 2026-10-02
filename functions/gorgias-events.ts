import { appSecrets, verifySecretHeader } from './lib/auth';
import { callSync } from './lib/connect';
import { connectionFromSettings } from './lib/gorgias';
import { loadAccountData } from './lib/sync-account';

export const config: SwellConfig = {
  description:
    'Receives Gorgias ticket events: records the ticket on the Swell customer and returns the data the Gorgias sidebar widget renders',
  route: {
    public: true,
    methods: ['post'],
    headers: ['x-swell-gorgias-secret'],
  },
};

const MAX_TICKETS = 20;
const OBJECT_ID = /^[0-9a-f]{24}$/;

function field(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

// Gorgias allows 5s for this call, so the response is built first and the
// ticket write runs after it returns. The JSON response is the data source for
// the http-type sidebar widget (customer profile + recent orders).
export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  const connection = connectionFromSettings(settings);
  const secrets = connection ? await appSecrets(connection, req.store.id) : null;

  if (!connection || !secrets || !verifySecretHeader(req.headers, secrets.events)) {
    return new SwellResponse({ error: 'unauthorized' }, { status: 401 });
  }

  // Ticket fields arrive as the integration's JSON body (see TICKET_FORM).
  const params: SwellData = req.data || {};
  const ticketId = field(params.ticket_id);
  if (!ticketId) {
    return { ok: true, skipped: 'no_ticket', customer: null, orders: [] };
  }
  const email = field(params.email).toLowerCase();
  const externalId = field(params.external_id);
  const linked = OBJECT_ID.test(externalId);

  // external_id is the Swell account id once the Gorgias customer has been
  // synced; otherwise fall back to an email match.
  let account: SwellData | null = null;
  if (linked) {
    account = await req.swell.get(`/accounts/${externalId}`).catch(() => null);
  }
  if (!account && email) {
    const res = await req.swell.get('/accounts', {
      where: { email },
      limit: 1,
    });
    account = res?.results?.[0] || null;
  }
  if (!account) {
    return { ok: true, skipped: 'no_matching_account', customer: null, orders: [] };
  }

  const appId = req.appId;
  const existing: SwellData[] = account.$app?.[appId]?.tickets || [];
  const entry = {
    id: ticketId,
    subject: field(params.subject),
    status: field(params.status),
    channel: field(params.channel),
    url: `https://${connection.subdomain}.gorgias.com/app/ticket/${ticketId}`,
    date_updated: new Date().toISOString(),
  };
  const tickets = [
    entry,
    ...existing.filter((t) => String(t.id) !== entry.id),
  ].slice(0, MAX_TICKETS);

  // $set replaces the stored array instead of merging into it. Runs alongside
  // the sidebar lookup and is awaited, so a failure reaches the function log.
  const write = req.swell
    .put(
      `/accounts/${account.id}`,
      req.appValues({
        $set: {
          tickets,
          open_ticket_count: tickets.filter((t) => t.status === 'open').length,
          last_ticket_subject: entry.subject,
          last_ticket_url: entry.url,
          last_ticket_at: entry.date_updated,
        },
      }),
    )
    .catch((err: unknown) =>
      console.error(`Could not record ticket ${ticketId}: ${String(err)}`),
    );

  // First contact from a customer Gorgias doesn't know yet: link their Gorgias
  // identity (external_id, phone) in the background.
  if (!linked && settings?.sync?.enabled) {
    callSync(req, secrets, { account_id: account.id });
  }

  const [data] = await Promise.all([
    loadAccountData(req.swell, account, req.store, req.headers.get('swell-env')),
    write,
  ]);
  return {
    ok: true,
    account_id: account.id,
    customer: data.customer,
    orders: data.orders,
  };
}
