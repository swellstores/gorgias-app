import { reconcile } from './lib/connect';

export const config: SwellConfig = {
  description:
    'Connect to Gorgias after the connection settings change, re-check the connection hourly, and keep the customer import moving',
  cron: {
    // Every minute, so a merchant who just saved their API key sees the result
    // quickly. Idle runs make two reads (settings and the connections record).
    schedule: '* * * * *',
  },
};

export default async function (req: SwellRequest) {
  return reconcile(req);
}
