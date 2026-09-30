// Secrets are set with `npx wrangler secret put <NAME>` in this folder, never
// in wrangler.jsonc: files in frontend/ are uploaded to Swell as app configs.
// (Static assets in public/ are served by the platform before the Worker runs.)
export interface Env {
  // From the Gorgias partner portal (draft app credentials)
  GORGIAS_CLIENT_ID: string;
  GORGIAS_CLIENT_SECRET: string;
  // Random value that signs OAuth state and refresh keys (openssl rand -hex 32)
  STATE_SECRET: string;
  // This Worker's public origin, as registered with Gorgias. Defaults to the
  // origin requests arrive on.
  PUBLIC_URL?: string;
  // Overrides for non-production Swell hosts
  SWELL_HOST_SUFFIX?: string;
  SWELL_API_HOST?: string;
}
