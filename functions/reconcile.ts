import { reconcile } from './lib/connect';

export const config: SwellConfig = {
  description:
    'Renew Gorgias access before it expires, re-provision Gorgias when settings change, re-check the connection hourly, and keep the customer import moving',
  cron: {
    schedule: '*/5 * * * *',
  },
};

export default async function (req: SwellRequest) {
  return reconcile(req);
}
