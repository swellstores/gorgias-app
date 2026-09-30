# Gorgias for Swell

A Swell integration app that connects a Swell store to the [Gorgias](https://www.gorgias.com) helpdesk.

- **One-click connect:** merchants enter their Gorgias subdomain on the app's Connect page and approve access in Gorgias (OAuth2). There are no API keys to copy.
- **Sidebar context in Gorgias:** agents see the customer's Swell profile, lifetime value and five latest orders (with items and tracking) next to each ticket, with links into the Swell admin.
- **Ticket context in Swell:** each customer record gets a **Support** tab showing their open ticket count, their last ticket and a link to it in Gorgias. The customer list gets an **Open tickets** column.
- **Customer sync (optional):** Swell customers are created and updated as Gorgias customers (name, email, phone), linked by `external_id`. An import covers existing customers who have ordered.

## How it works

```
Connect page (Gorgias menu item) ──► Gorgias consent ──► frontend Worker
      stores OAuth tokens in the app's `connections` record, then calls `connect`

connect / reconcile (cron, every 5 min)
      ├─► renews the 24-hour access token through the Worker
      ├─► Gorgias HTTP integration "Swell" + ticket sidebar widget
      ├─► connection.status setting ("Connected to acme.gorgias.com …")
      └─► sync (self-chaining import of existing customers)

Swell account/order events ──► sync-customer ──► Gorgias customer (upsert by external_id / email)

Gorgias ticket created/updated ──► gorgias-events ──► returns customer + orders JSON
                                                  │   (rendered by the sidebar widget)
                                                  └─► records the ticket on the Swell account
```

Gorgias renders the sidebar from an HTTP integration the app registers: the integration calls `gorgias-events` when a ticket is created and, by default, when it's updated (ticket fields are sent as a JSON body), and an http-type widget bound to it renders the JSON response.

### The frontend Worker

[`frontend/`](frontend) is a Cloudflare Worker deployed once for every store that installs the app. It holds the Gorgias client secret, which Swell functions can't. Each store's dashboard shows it through its admin proxy (`https://<store>--<install>--app.swell.store`), which injects that install's credentials.

| Route | Reached through | Purpose |
| --- | --- | --- |
| `/` | admin proxy | The Connect page (static `public/index.html`) |
| `POST /oauth/start` | admin proxy | Checks the dashboard session, stores a one-time nonce, redirects to Gorgias's consent screen with a signed `state` |
| `GET /oauth/callback` | public URL (the Redirect URL registered with Gorgias) | Checks the signed `state` and bounces the browser back to the install's proxy host |
| `GET /oauth/complete` | admin proxy | Checks the state, session and nonce, exchanges the code with the client secret, stores the tokens, calls `connect` |
| `POST /connection/status`, `POST /connection/disconnect` | admin proxy | Page data; disconnect removes the Gorgias integration and widget and revokes access |
| `POST /oauth/refresh` | public URL | Renews an access token for the app's functions, authorized by a per-store key issued at connect |
| `GET /oauth/install` | public URL (the App URL registered with Gorgias) | Installs started from Gorgias's App Store: tells the merchant to finish from their Swell dashboard |

## Functions

| Function | Trigger | Purpose |
| --- | --- | --- |
| [`reconcile`](functions/reconcile.ts) | Cron, every 5 minutes | Renews the access token before it expires, re-provisions the integration and widget when anything relevant changes (a new authorization, the ticket-updates toggle, URLs), re-checks hourly, keeps the customer import moving and writes the result to the `connection.status` setting. Backs off for 15 minutes after a failure. |
| [`connect`](functions/connect.ts) | Route (`POST`, secret key required) | Runs `reconcile` immediately. Called by the Worker right after the merchant connects; also `swell api post /functions/gorgias/connect` in development. |
| [`gorgias-events`](functions/gorgias-events.ts) | Public route (`POST`), called by Gorgias | Matches the ticket's customer to a Swell account (by `external_id`, then email), returns the sidebar payload, and records up to 20 recent tickets on the account. Must respond within Gorgias's 5-second limit. |
| [`sync`](functions/sync.ts) | Public route (`POST`), called by the app | Syncs one account (`{ "account_id" }`), or imports customers with orders, newest buyers first, 2 per invocation, chaining to the next page until the import limit. Progress is saved after every batch. |
| [`sync-customer`](functions/sync-customer.ts) | Model events | Upserts the Gorgias customer on `account.created`, on `account.updated` when contact details change, and on `order.submitted`. Runs only when sync is enabled. |

Shared code lives in [`functions/lib/`](functions/lib):

- `connect.ts`: the reconcile logic, token renewal, status text and the self-call to `sync`.
- `state.ts`: the single `connections` record (tokens, generated secrets, Gorgias ids, import progress).
- `gorgias.ts`: the Gorgias REST client (bearer token). It spaces requests, retries 429s using `Retry-After`, follows 301 redirects for merged customers and pages through list endpoints.
- `provision.ts`: builds the integration and widget definitions and creates or updates them. It never touches Gorgias objects it didn't create.
- `payload.ts`: pure functions that turn Swell records into the sidebar data.
- `sync-account.ts`: loads the sidebar data for an account and upserts a customer to Gorgias.
- `auth.ts`: header secret check, random secrets and hashing.
- `urls.ts`: builds function URLs on the store's `swell.store` host.

## Data

**On customers** (`models/accounts.json`, shown by `content/accounts.json`), under `$app.gorgias`:

| Field | Description |
| --- | --- |
| `open_ticket_count` | Recent tickets whose last known status is open (also shown in the customer list) |
| `last_ticket_subject` | Subject of the most recently updated ticket |
| `last_ticket_at` | When Swell last heard about one of the customer's tickets |
| `last_ticket_url` | Link to that ticket in Gorgias |
| `tickets` | Up to 20 recent tickets (`id`, `subject`, `status`, `channel`, `url`, `date_updated`) |

**App collection** `connections` (`models/connections.json`): one record with the OAuth tokens, the generated secrets, the provisioned integration and widget ids, the last error and the import progress. It lives outside settings so a stale dashboard save can't overwrite it and merchants never handle secrets. `content/connections.json` adds the top-level **Gorgias** menu entry that opens the Connect page. (It can't sit under Customers: the dashboard only nests app entries under sections that already have sub-items.)

## Settings

**Gorgias connection** (`connection`): `status`, read-only, written by `reconcile`. Connecting happens on the Connect page.

**Sync** (`sync`)

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | off | Create and update Gorgias customers from Swell accounts |
| `backfill_limit` | 500 | Maximum number of existing customers to import (100 / 500 / 1000) |
| `sync_ticket_updates` | on | Also call `gorgias-events` when a ticket changes, not only when it's created. Keeps open-ticket counts and the sidebar current |

## Setup (merchants)

1. Install the app on your Swell store.
2. Open **Gorgias** in the dashboard menu, enter your Gorgias subdomain and click **Connect Gorgias**.
3. Approve access in Gorgias. You're brought back to Swell, and the page shows "Connected to acme.gorgias.com" once the integration is set up.
4. Optionally turn on **Sync customers to Gorgias** in the app settings.
5. Open a ticket from a Swell customer in Gorgias. The **Swell** card and the customer's recent orders appear in the sidebar.

## Security

- **OAuth:** the client secret lives only in the Worker (a Cloudflare secret). Functions renew tokens through `/oauth/refresh` with a per-store key. Tokens are stored in private fields of the app's own collection.
- **Connect flow:** every Worker route that acts for a merchant requires a dashboard session checked against the store's admin API, and POSTs must come from the install's own origin. The OAuth `state` is HMAC-signed, expires after 10 minutes and names the install's proxy host; the nonce it carries is single-use and tied to the dashboard user who started the flow. The public callback only ever redirects to Swell app proxy hosts.
- **Gorgias → Swell:** `gorgias-events` and `sync` are public routes that only accept a secret in the `X-Swell-Gorgias-Secret` header, compared in constant time, and forward only that header (`route.headers`). The app generates two secrets: one Gorgias sends to `gorgias-events`, and one only the app's own functions send to `sync`. Disconnecting or revoking access revokes the Gorgias secret too.
- Calls to the app's functions carry the app public key in the `Authorization` header, which Swell's gateway uses to route them to the right environment.
- Gorgias request signatures (HMAC) aren't used: the gateway re-serializes request bodies, so a signature over the original bytes can't be checked.

## Development

Requirements: Node.js 22+, the [Swell CLI](https://developers.swell.is/cli), and `wrangler login` for the Cloudflare account that hosts the Worker.

```bash
npm install
npm run typecheck
npm test
```

Tests run with Vitest on `@cloudflare/vitest-pool-workers`, so they execute in the same Workers runtime Swell functions use. Unit tests live in `test/unit/`; `test/helpers/fakes.ts` provides an in-memory Swell API and a `fetch` router for Gorgias and gateway calls.

### Gorgias OAuth app

Register a draft app in the [Gorgias partner portal](https://partners.gorgias.com) with:

- **App URL:** `https://<worker-host>/oauth/install`
- **Redirect URL:** `https://<worker-host>/oauth/callback`

where `<worker-host>` is the Worker's public host printed by `swell app push` (e.g. `swell-gorgias.<account>.workers.dev`). Then set the Worker's secrets once, in `frontend/`:

```bash
npx wrangler secret put GORGIAS_CLIENT_ID
npx wrangler secret put GORGIAS_CLIENT_SECRET
npx wrangler secret put STATE_SECRET
```

`STATE_SECRET` is any long random value (`openssl rand -hex 32`). Never put secrets in `frontend/wrangler.jsonc`: files in `frontend/` are uploaded to Swell with the app. `.dev.vars*` files are gitignored; keep local secrets there.

### Deploy

```bash
CLOUDFLARE_ACCOUNT_ID=<account id> swell app push
```

## Project layout

```
swell.json          App manifest (id, type, permissions)
assets/             App icon and App Store screenshots
content/            Admin UI: customer fields and the Gorgias menu entry
frontend/           Cloudflare Worker: Connect page and OAuth
functions/          Swell functions and shared lib/
models/             Customer fields and the connections collection
settings/           App settings (connection status, sync)
test/               Vitest unit tests and helpers
```
