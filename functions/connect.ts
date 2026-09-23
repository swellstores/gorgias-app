import { requestParams, verifySharedSecret } from './lib/auth';
import { clientFromSettings } from './lib/gorgias';
import { provision } from './lib/provision';
import { functionUrl } from './lib/urls';

export const config: SwellConfig = {
  description:
    'Validates Gorgias credentials, provisions the Gorgias integration + sidebar widget, and starts customer backfill',
  route: {
    public: true,
    methods: ['get', 'post'],
  },
};

// Invoke after saving app settings:
//   curl -X POST "https://<store-url>/functions/gorgias/connect?key=<shared_secret>"
// Optional query params:
//   events_url=...   override the URL Gorgias calls for ticket events
//   backfill=false   skip starting the backfill workflow
export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();

  if (!verifySharedSecret(req, settings?.connection?.shared_secret)) {
    return new SwellResponse({ error: 'unauthorized' }, { status: 401 });
  }

  let gorgias;
  try {
    gorgias = clientFromSettings(settings);
  } catch (err) {
    return new SwellResponse(
      { error: String((err as Error).message) },
      { status: 400 },
    );
  }

  // 1. Credential check
  let gorgiasAccount;
  try {
    gorgiasAccount = await gorgias.checkAuth();
  } catch (err) {
    return new SwellResponse(
      { error: 'Gorgias credentials invalid', detail: String(err) },
      { status: 400 },
    );
  }

  // 2. Provision integration + widget (idempotent)
  const appId = req.appId || 'gorgias';
  const params = requestParams(req);
  const eventsUrl =
    params.events_url || functionUrl(req.store, appId, 'gorgias-events');

  const provisioned = await provision(gorgias, {
    eventsUrl,
    sharedSecret: settings.connection.shared_secret,
    syncTicketUpdates: !!settings?.sync?.sync_ticket_updates,
    publicKey: req.publicKey || undefined,
  });

  // 3. Backfill (self-chaining sync function; fire-and-forget)
  let backfill: string = 'skipped';
  if (params.backfill !== 'false') {
    if (settings?.sync?.enabled) {
      const start = fetch(`${functionUrl(req.store, appId, 'sync')}?page=1`, {
        method: 'post',
        headers: {
          'X-Swell-Gorgias-Secret': settings.connection.shared_secret,
          ...(req.publicKey ? { Authorization: req.publicKey } : {}),
        },
      }).catch(() => undefined);
      req.context?.waitUntil?.(start);
      backfill = 'started';
    } else {
      backfill = 'skipped (sync.enabled is off)';
    }
  }

  // Report existing Gorgias chat integrations: confirms chat is set up and
  // surfaces application_id as a candidate for the chat.app_key setting.
  const chatIntegrations = await gorgias
    .listChatIntegrations()
    .then((list) =>
      list.map((i) => ({
        id: i.id,
        name: i.name,
        application_id: i.application_id,
      })),
    )
    .catch(() => []);

  return {
    ok: true,
    gorgias_account: gorgiasAccount?.domain || gorgias.baseUrl,
    integration: provisioned.integration,
    widget: provisioned.widget,
    events_url: eventsUrl,
    backfill,
    chat_integrations: chatIntegrations,
  };
}
