# Gorgias app frontend Worker

The Connect page and the Gorgias OAuth flow for the Gorgias Swell app. See
[the app README](../README.md#the-frontend-worker) for the routes, the
security model and the one-time setup (Gorgias partner app and
`wrangler secret put` for `GORGIAS_CLIENT_ID`, `GORGIAS_CLIENT_SECRET` and
`STATE_SECRET`).

It's deployed by `swell app push` from the app folder; tests live in the app's
`test/unit/frontend.test.ts`.
