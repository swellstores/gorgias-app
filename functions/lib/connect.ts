// Dashboard-driven connection: the merchant saves their Gorgias API key in the
// app settings, and reconcile() (run every minute by functions/reconcile.ts)
// provisions Gorgias when the settings change, re-checks the connection
// hourly and keeps the customer import moving.

import { AppSecrets, SECRET_HEADER, appSecrets, sha256Hex } from './auth';
import { GorgiasClient, GorgiasError, connectionFromSettings } from './gorgias';
import { TEMPLATE_VERSION, provision } from './provision';
import { ConnectionState, loadState, saveState } from './state';
import { functionUrl } from './urls';

const HEALTH_CHECK_MS = 60 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 15 * 60 * 1000;
const IMPORT_STALL_MS = 10 * 60 * 1000;

export interface ReconcileResult {
  status: 'incomplete' | 'connected' | 'error';
  provisioned?: boolean;
  import?: string;
  error?: string;
}

function elapsed(now: Date, date?: string | null): number {
  return date ? now.getTime() - Date.parse(date) : Infinity;
}

// The app public key differs per store and per environment, so a short hash of
// it identifies this install's integration in a shared helpdesk without
// exposing the key.
export async function ownerTag(publicKey: string): Promise<string> {
  return `install ${(await sha256Hex(publicKey)).slice(0, 16)}`;
}

export function describeError(err: unknown): string {
  if (err instanceof GorgiasError) {
    if (err.status === 401 || err.status === 403) {
      return `Gorgias rejected the agent email or API key (${err.status})`;
    }
    if (err.status === 404) {
      return 'Gorgias returned 404 — check the subdomain';
    }
    return `Gorgias returned an error (${err.status})`;
  }
  return String((err as Error)?.message || err).slice(0, 200);
}

// Calls the sync route through the gateway. Fire-and-forget: the import chain
// is restarted by reconcile() if a link is lost.
export function callSync(
  req: SwellRequest,
  secrets: AppSecrets,
  body: { page?: number; account_id?: string },
): void {
  const call = fetch(functionUrl(req.store, req.appId, 'sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SECRET_HEADER]: secrets.internal,
      Authorization: req.publicKey || '',
    },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) console.error(`sync call returned ${res.status}`);
    })
    .catch((err) => console.error(`sync call failed: ${String(err)}`));
  req.context?.waitUntil?.(call);
}

async function continueImport(
  req: SwellRequest,
  settings: SwellSettings,
  state: ConnectionState,
  secrets: AppSecrets,
  subdomain: string,
  now: Date,
): Promise<{ state: ConnectionState; phase: string }> {
  if (!settings?.sync?.enabled) return { state, phase: 'off' };

  if (state.backfill_subdomain !== subdomain) {
    state = await saveState(req.swell, state, {
      backfill_subdomain: subdomain,
      backfill_page: 1,
      backfill_done: false,
      backfill_synced: 0,
      date_backfill_updated: now.toISOString(),
    });
    callSync(req, secrets, { page: 1 });
    return { state, phase: 'started' };
  }
  if (state.backfill_done) return { state, phase: 'done' };

  if (elapsed(now, state.date_backfill_updated) > IMPORT_STALL_MS) {
    state = await saveState(req.swell, state, {
      date_backfill_updated: now.toISOString(),
    });
    callSync(req, secrets, { page: state.backfill_page || 1 });
    return { state, phase: 'resumed' };
  }
  return { state, phase: 'running' };
}

export async function reconcile(
  req: SwellRequest,
  { force = false }: { force?: boolean } = {},
): Promise<ReconcileResult> {
  const [settings, loaded] = await Promise.all([
    req.swell.settings(),
    loadState(req.swell),
  ]);
  let state = loaded;

  // Nothing to revoke when the settings are cleared: the secret Gorgias holds
  // is derived from them, so it stops being accepted at once.
  const connection = connectionFromSettings(settings);
  if (!connection) {
    return { status: 'incomplete' };
  }
  if (!req.publicKey) {
    const error =
      'This environment has no app public key, so Gorgias could not reach Swell. Reinstall the app.';
    console.error(`Gorgias connection failed: ${error}`);
    return { status: 'error', error };
  }

  const { subdomain } = connection;
  const gorgiasAccount = `${subdomain}.gorgias.com`;

  // Switched to a different helpdesk: ids saved from the old one mean nothing
  // in the new one. (Its secret already differs, since it's derived per helpdesk.)
  if (state.gorgias_account && state.gorgias_account !== gorgiasAccount) {
    state = await saveState(req.swell, state, {
      fingerprint: null,
      integration_id: null,
      widget_id: null,
      gorgias_account: gorgiasAccount,
    });
  }

  const secrets = await appSecrets(connection, req.store.id);
  const eventsUrl = functionUrl(req.store, req.appId, 'gorgias-events');
  const syncTicketUpdates = settings?.sync?.sync_ticket_updates !== false;
  const fingerprint = await sha256Hex(
    [
      TEMPLATE_VERSION,
      subdomain,
      connection.email,
      await sha256Hex(connection.apiKey),
      req.publicKey,
      eventsUrl,
      String(syncTicketUpdates),
    ].join('|'),
  );

  const now = new Date();
  const upToDate =
    state.fingerprint === fingerprint &&
    !state.last_error &&
    elapsed(now, state.date_checked) < HEALTH_CHECK_MS;
  const backingOff =
    !!state.last_error &&
    state.last_attempt_fingerprint === fingerprint &&
    elapsed(now, state.date_last_attempt) < RETRY_AFTER_ERROR_MS;

  if (!force && backingOff) {
    return { status: 'error', error: state.last_error || undefined };
  }

  const provisioned = force || !upToDate;
  if (provisioned) {
    try {
      const gorgias = new GorgiasClient(connection);
      await gorgias.checkAuth();
      const result = await provision(gorgias, {
        eventsUrl,
        eventsSecret: secrets.events,
        publicKey: req.publicKey,
        ownerTag: await ownerTag(req.publicKey),
        syncTicketUpdates,
        integrationId: state.integration_id,
      });
      if (result.deactivated) {
        throw new Error(
          'The Swell integration is deactivated in Gorgias. Reactivate it under Settings → Integrations → HTTP',
        );
      }
      state = await saveState(req.swell, state, {
        fingerprint,
        integration_id: result.integration.id,
        widget_id: result.widget.id,
        gorgias_account: gorgiasAccount,
        last_error: null,
        last_attempt_fingerprint: fingerprint,
        date_last_attempt: now.toISOString(),
        date_checked: now.toISOString(),
        date_connected:
          state.fingerprint === fingerprint && state.date_connected
            ? state.date_connected
            : now.toISOString(),
      });
    } catch (err) {
      const error = describeError(err);
      console.error(`Gorgias connection failed: ${String(err)}`);
      await saveState(req.swell, state, {
        last_error: error,
        last_attempt_fingerprint: fingerprint,
        date_last_attempt: now.toISOString(),
      });
      return { status: 'error', error };
    }
  }

  const imported = await continueImport(req, settings, state, secrets, subdomain, now);
  return { status: 'connected', provisioned, import: imported.phase };
}
