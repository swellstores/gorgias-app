# Gorgias for Swell

A Swell integration app that connects a Swell store to the [Gorgias](https://www.gorgias.com) helpdesk.

- **Sidebar context in Gorgias:** agents see the customer's Swell profile, lifetime value and five latest orders (with items and tracking) next to each ticket, with links into the Swell admin.
- **Ticket context in Swell:** each customer record gets a **Support** tab showing their open ticket count, their last ticket and a link to it in Gorgias. The customer list gets an **Open tickets** column.
- **Customer sync (optional):** Swell customers are created and updated as Gorgias customers (name, email, phone), linked by `external_id`. An import covers existing customers who have ordered.

## How it works

```
Merchant saves settings ──► reconcile (cron, every minute)
                              ├─► Gorgias HTTP integration "Swell" + ticket sidebar widget
                              ├─► connection.status setting ("Connected to acme.gorgias.com …")
                              └─► sync (self-chaining import of existing customers)

Swell account/order events ──► sync-customer ──► Gorgias customer (upsert by external_id / email)

Gorgias ticket created/updated ──► gorgias-events ──► returns customer + orders JSON
                                                  │   (rendered by the sidebar widget)
                                                  └─► records the ticket on the Swell account
```

The app authenticates with the merchant's Gorgias REST API key (Basic auth). Gorgias renders the sidebar from an HTTP integration the app registers: the integration calls `gorgias-events` when a ticket is created and, by default, when it's updated (ticket fields are sent as a JSON body), and an http-type widget bound to it renders the JSON response.

An OAuth "Connect" flow was built and set aside: it needs a Gorgias partner app, Gorgias's review and a Cloudflare Worker to hold the client secret. It lives on the `oauth-connect` branch.

## Functions

| Function | Trigger | Purpose |
| --- | --- | --- |
| [`reconcile`](functions/reconcile.ts) | Cron, every minute | Connects when the connection settings change (credential check, then create or update the integration and widget), re-checks the connection hourly, keeps the customer import moving and writes the result to the `connection.status` setting. Backs off for 15 minutes after a failure unless the settings change. Idle runs make two reads. |
| [`connect`](functions/connect.ts) | Route (`POST`, secret key required) | Runs `reconcile` immediately. A developer tool: `swell api post /functions/gorgias/connect`. |
| [`gorgias-events`](functions/gorgias-events.ts) | Public route (`POST`), called by Gorgias | Matches the ticket's customer to a Swell account (by `external_id`, then email), returns the sidebar payload, and records up to 20 recent tickets on the account. Must respond within Gorgias's 5-second limit. |
| [`sync`](functions/sync.ts) | Public route (`POST`), called by the app | Syncs one account (`{ "account_id" }`), or imports customers with orders, newest buyers first, 2 per invocation, chaining to the next page until the import limit. Progress is saved after every batch. |
| [`sync-customer`](functions/sync-customer.ts) | Model events | Upserts the Gorgias customer on `account.created`, on `account.updated` when contact details change, and on `order.submitted`. Runs only when sync is enabled. |

Shared code lives in [`functions/lib/`](functions/lib):

- `connect.ts`: the reconcile logic, status text and the self-call to `sync`.
- `auth.ts`: header secret check, the secrets derived from the API key, and hashing.
- `state.ts`: the single `connections` record (Gorgias ids, connection health, import progress).
- `gorgias.ts`: the Gorgias REST client and connection settings. It spaces requests to stay under Gorgias's limit of 40 requests per 20 seconds, retries 429s using `Retry-After`, follows 301 redirects for merged customers and pages through list endpoints.
- `provision.ts`: builds the integration and widget definitions and creates or updates them. It never touches Gorgias objects it didn't create.
- `payload.ts`: pure functions that turn Swell records into the sidebar data.
- `sync-account.ts`: loads the sidebar data for an account and upserts a customer to Gorgias.
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

**App collection** `connections` (`models/connections.json`): one record with the provisioned integration and widget ids, the last error and the import progress. It lives outside settings so a stale dashboard save can't overwrite it, and it holds no secrets.

## Settings

**Gorgias connection** (`connection`)

| Field | Description |
| --- | --- |
| `subdomain` | The `acme` in `acme.gorgias.com` (a pasted `acme.gorgias.com` or helpdesk URL also works) |
| `email` | Email of the Gorgias agent who owns the API key |
| `api_key` | Gorgias REST API key (Gorgias → Settings → You → REST API) |
| `status` | Read-only, written by `reconcile` |

**Sync** (`sync`)

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | off | Create and update Gorgias customers from Swell accounts |
| `backfill_limit` | 500 | Maximum number of existing customers to import (100 / 500 / 1000) |
| `sync_ticket_updates` | on | Also call `gorgias-events` when a ticket changes, not only when it's created. Keeps open-ticket counts and the sidebar current |

## Setup (merchants)

1. Install the app on your Swell store.
2. In Gorgias, open **Settings → You → REST API** and copy your API key.
3. In Swell, open **Apps → Gorgias → Settings**, fill in **Gorgias connection** (subdomain, agent email, API key) and save. Turn on **Sync customers to Gorgias** if you want customers created in Gorgias.
4. Within about a minute, reload the settings page: **Status** reads "Connected to acme.gorgias.com". If it reads "Could not connect", it says why.
5. Open a ticket from a Swell customer in Gorgias. The **Swell** card and the customer's recent orders appear in the sidebar.

Changing a connection setting or the ticket-updates toggle re-provisions the existing "Swell" integration and widget on the next run rather than creating duplicates.

## Security

- `gorgias-events` and `sync` are public routes that only accept a secret in the `X-Swell-Gorgias-Secret` header, compared in constant time, and forward only that header (`route.headers`). Secrets are never accepted in URLs.
- The app's two secrets (the one Gorgias sends to `gorgias-events`, and the one only the app's own functions send to `sync`) are derived from the merchant's API key with HMAC-SHA256, scoped to the store and helpdesk, instead of being stored. Anything an app writes through the Swell API is kept in the store's request logs, which every installed app can read. Changing the API key or the helpdesk rotates the secrets; clearing the connection settings revokes them.
- The API key itself sits in the app settings like any other field: it shows in plain text in the dashboard, and other installed apps with `read_settings` can read it. Fixing that needs secret settings fields in the Swell app framework.
- Calls to the app's functions carry the app public key in the `Authorization` header, which Swell's gateway uses to route them to the right environment.
- Gorgias request signatures (HMAC) aren't used: the gateway re-serializes request bodies, so a signature over the original bytes can't be checked.

## Development

Requirements: Node.js and the [Swell CLI](https://developers.swell.is/cli).

```bash
npm install
npm run typecheck
npm test
```

Tests run with Vitest on `@cloudflare/vitest-pool-workers`, so they execute in the same Workers runtime Swell functions use. Unit tests live in `test/unit/`; `test/helpers/fakes.ts` provides an in-memory Swell API and a `fetch` router for Gorgias and gateway calls.

Deploy and develop with the Swell CLI:

```bash
swell app push
swell api post /functions/gorgias/connect
```

`.dev.vars*` files are gitignored; keep local secrets there.

## Project layout

```
swell.json          App manifest (id, type, permissions)
assets/             App icon, social card and App Store screenshots
content/            Admin UI fields added to customer records
functions/          Swell functions and shared lib/
models/             Customer fields and the connections collection
settings/           App settings (connection, sync)
test/               Vitest unit tests and helpers
```
