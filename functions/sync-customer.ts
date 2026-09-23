import { clientFromSettings } from './lib/gorgias';
import { syncAccountToGorgias } from './lib/sync-account';

export const config: SwellConfig = {
  description:
    'Push customer profile and recent orders to Gorgias when they change',
  model: {
    events: [
      'account.created',
      'account.updated',
      'order.submitted',
      'order.paid',
      'order.canceled',
      'order.refunded',
      'order.delivered',
      'shipment.created',
      'shipment.updated',
    ],
    conditions: {
      '$settings.sync.enabled': true,
    },
  },
};

export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  if (!settings?.sync?.enabled) {
    return { skipped: 'sync_disabled' };
  }

  const record = req.data;
  const eventType: string = record?.$event?.type || '';

  let accountId: string | undefined;
  if (eventType.startsWith('account.')) {
    accountId = record.id;
  } else if (eventType.startsWith('shipment.')) {
    const order = record.order_id
      ? await req.swell.get(`/orders/${record.order_id}`)
      : null;
    accountId = order?.account_id;
  } else {
    accountId = record.account_id;
  }

  if (!accountId) {
    return { skipped: 'no_account' };
  }

  const gorgias = clientFromSettings(settings);
  return syncAccountToGorgias(
    req.swell,
    gorgias,
    accountId,
    req.store,
    req.headers.get('swell-env'),
  );
}
