import { clientFromSettings, hasConnection, isAuthError } from './lib/gorgias';
import {
  changesContactDetails,
  syncAccountToGorgias,
} from './lib/sync-account';

// The $or mirrors CONTACT_FIELDS in lib/sync-account.ts: updates that only
// touch other fields (e.g. this app's own ticket writes) never fire.
export const config: SwellConfig = {
  description:
    'Create or update the Gorgias customer when a Swell customer signs up, changes their contact details, or places an order',
  model: {
    events: ['account.created', 'account.updated', 'order.submitted'],
    conditions: {
      $settings: { sync: { enabled: true } },
      $or: [
        { '$event.type': { $in: ['account.created', 'order.submitted'] } },
        { '$event.data.email': { $exists: true } },
        { '$event.data.name': { $exists: true } },
        { '$event.data.first_name': { $exists: true } },
        { '$event.data.last_name': { $exists: true } },
        { '$event.data.phone': { $exists: true } },
        { '$event.data.shipping': { $exists: true } },
        { '$event.data.billing': { $exists: true } },
      ],
    },
  },
};

export default async function (req: SwellRequest) {
  const record = req.data;
  if (!changesContactDetails(record?.$event)) {
    return { skipped: 'no_contact_changes' };
  }

  const settings = await req.swell.settings();
  if (!settings?.sync?.enabled) {
    return { skipped: 'sync_disabled' };
  }
  if (!hasConnection(settings)) {
    return { skipped: 'not_connected' };
  }

  const accountId: string | undefined = String(
    record?.$event?.type || '',
  ).startsWith('account.')
    ? record.id
    : record.account_id;
  if (!accountId) {
    return { skipped: 'no_account' };
  }

  const gorgias = clientFromSettings(settings);
  try {
    return await syncAccountToGorgias(req.swell, gorgias, accountId);
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`Gorgias rejected the credentials: ${String(err)}`);
      return { skipped: 'gorgias_auth_failed' };
    }
    throw err;
  }
}
