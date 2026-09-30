import { reconcile } from './lib/connect';

export const config: SwellConfig = {
  description:
    'Provision Gorgias immediately instead of waiting for the reconcile cron. Called by the app\'s Worker after the merchant connects (requires a secret key)',
  route: {
    methods: ['post'],
  },
};

// Also handy in development:
//   swell api post /functions/gorgias/connect
export default async function (req: SwellRequest) {
  return reconcile(req, { force: true });
}
