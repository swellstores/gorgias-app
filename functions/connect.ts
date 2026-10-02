import { reconcile } from './lib/connect';

export const config: SwellConfig = {
  description:
    'Connect to Gorgias immediately instead of waiting for the reconcile cron (developer tool; requires a secret key)',
  route: {
    methods: ['post'],
  },
};

// Merchants never need this: saving settings is enough. For development:
//   swell api post /functions/gorgias/connect
export default async function (req: SwellRequest) {
  return reconcile(req, { force: true });
}
