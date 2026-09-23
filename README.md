# Gorgias for Swell

A Swell integration app that connects a Swell store to the [Gorgias](https://www.gorgias.com) helpdesk.

- **Sidebar context in Gorgias:** agents see the customer's Swell profile, lifetime value and recent orders next to each ticket, with links into the Swell admin.
- **Customer sync:** Swell customers are created and updated as Gorgias customers, matched by email and linked by `external_id`. Sync runs on account, order and shipment events, and a one-time backfill covers existing customers.
- **Ticket context in Swell:** each customer record gets a **Support** tab showing their open ticket count, their last ticket and a link to it in Gorgias.
- **Chat widget settings:** the Gorgias chat app key is exposed as a public setting, so a storefront can load the chat widget.

## How it works

```
Swell events ──► sync-customer ──► Gorgias customer (upsert by email / external_id)

connect (once) ─► Gorgias HTTP integration "Swell" + ticket sidebar widget
              └─► sync (self-chaining backfill of existing customers)

Gorgias ticket created/updated ──► gorgias-events ──► records ticket on the Swell account
                                                  └─► returns customer + orders JSON
                                                      (rendered by the sidebar widget)
```

The app uses Gorgias REST API key (Basic) auth. In that mode, Gorgias only lets OAuth apps push customer data (`PUT /api/customers/:id/data`), so the app uses a pull model instead:

1. `connect` registers an **HTTP integration** in Gorgias that calls `gorgias-events` when a ticket is created (and, optionally, when it's updated).
2. It also registers an **http-type sidebar widget** bound to that integration.
3. Gorgias renders the widget from the JSON that `gorgias-events` returns.

The client still attempts the push and skips it when Gorgias rejects it, so the push will start working without code changes if OAuth support is added later.

## Functions

| Function | Trigger | Purpose |
| --- | --- | --- |
| [`connect`](functions/connect.ts) | Public route (`GET`/`POST`) | Validates credentials, creates or updates the Gorgias integration and sidebar widget, starts the backfill, and lists the existing Gorgias chat integrations. Safe to re-run. |
| [`gorgias-events`](functions/gorgias-events.ts) | Public route, called by Gorgias | Matches the ticket's customer to a Swell account (by `external_id`, then email) and stores up to 20 recent tickets on it. Returns the sidebar payload. Must respond within Gorgias's 5-second limit. |
| [`sync`](functions/sync.ts) | Public route (`POST`) | Syncs one account (`?account_id=`), or runs a backfill of customers with orders, newest first, 2 per invocation, chaining to the next page until `backfill_limit` is reached. |
| [`sync-customer`](functions/sync-customer.ts) | Model events | Pushes the affected customer to Gorgias on `account.created/updated`, `order.submitted/paid/canceled/refunded/delivered` and `shipment.created/updated`. Runs only when sync is enabled. |

Shared code lives in [`functions/lib/`](functions/lib):

- `gorgias.ts`: the Gorgias REST client. It spaces requests to stay under Gorgias's limit of 40 requests per 20 seconds, retries 429s using `Retry-After`, and follows 301 redirects for merged customers.
- `provision.ts`: builds the integration and widget definitions and creates or updates them.
- `payload.ts`: pure functions that turn Swell records into the sidebar data.
- `sync-account.ts`: loads a Swell account with its last 5 orders and subscriptions, and upserts the customer to Gorgias.
- `auth.ts`: shared-secret and HMAC verification.
- `urls.ts`: builds function URLs.

## Data added to Swell

`content/accounts.json` adds these read-only fields to customers under `$app.gorgias`:

| Field | Description |
| --- | --- |
| `open_ticket_count` | Open Gorgias tickets from this customer (also shown in the customer list) |
| `last_ticket_subject` | Subject of the most recent ticket |
| `last_ticket_at` | Time of the most recent ticket activity |
| `last_ticket_url` | Link to the ticket in Gorgias |
| `tickets` | Up to 20 recent tickets (`id`, `subject`, `status`, `channel`, `url`, `date_updated`) |

## Settings

**Gorgias connection** (`connection`)

| Field | Description |
| --- | --- |
| `subdomain` | The `acme` in `acme.gorgias.com` |
| `email` | Email of the Gorgias agent who owns the API key |
| `api_key` | Gorgias REST API key (Gorgias → Settings → You → REST API) |
| `shared_secret` | A random string that authenticates calls between Gorgias and this app, e.g. `openssl rand -hex 24` |

**Sync** (`sync`)

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | off | Sync customers and orders to Gorgias |
| `sync_ticket_updates` | off | Also call `gorgias-events` on ticket updates, not only on creation (more traffic) |
| `backfill_limit` | 500 | Maximum number of existing customers synced by `connect` (100 / 500 / 1000) |

**Chat widget** (`chat`, public)

| Field | Description |
| --- | --- |
| `enabled` | Show the Gorgias chat widget on the storefront |
| `app_key` | The chat key from Gorgias → Settings → Channels → Chat → *integration* → Installation → "Any Other Website" (the `{KEY}` in `https://config.gorgias.chat/bundle-loader/{KEY}`). `connect` lists candidate values in `chat_integrations[].application_id`. |

The app doesn't inject the chat widget itself. These settings are public so that a storefront or theme can read them and load the Gorgias bundle.

## Setup

1. Install the app on your Swell store.
2. In the app settings, fill in **Gorgias connection** and enable **Sync** if you want customer data pushed to Gorgias.
3. Run `connect` once, passing the shared secret:

   ```bash
   curl -X POST "https://<store-url>/functions/gorgias/connect?key=<shared_secret>"
   ```

   Optional query parameters:
   - `events_url=<url>` overrides the URL Gorgias calls for ticket events (useful for local development tunnels).
   - `backfill=false` skips the initial customer backfill.

   A successful response looks like:

   ```json
   {
     "ok": true,
     "gorgias_account": "acme.gorgias.com",
     "integration": { "id": 123, "created": true },
     "widget": { "id": 456, "created": true },
     "events_url": "https://<store-url>/functions/gorgias/gorgias-events",
     "backfill": "started",
     "chat_integrations": [{ "id": 789, "name": "Chat", "application_id": "..." }]
   }
   ```

4. Open a ticket in Gorgias. The **Swell customer** card and the **Recent orders** list appear in the sidebar.

Re-run `connect` after changing the shared secret or `sync_ticket_updates`, or to restart a backfill that stopped. It updates the existing "Swell" integration and widget rather than creating duplicates.

## Security

- Every public route requires the shared secret, sent either in the `X-Swell-Gorgias-Secret` header or as a `?key=` parameter, and compares it in constant time.
- `connect` puts the secret into the Gorgias integration's headers. It also sets the secret as the integration's HMAC secret, so any `X-Gorgias-Signature` / `X-Hub-Signature-256` header on incoming events is verified against the raw body.
- Calls to the app's own functions include the app's public key in the `Authorization` header, which Swell's gateway uses to route public function calls.

## Development

Requirements: Node.js and the [Swell CLI](https://developers.swell.is/cli).

```bash
npm install
npm run typecheck
npm test
```

Tests run with Vitest on `@cloudflare/vitest-pool-workers`, so they execute in the same Workers runtime Swell functions use. Unit tests live in `test/unit/` and cover auth, the Gorgias client, event handling, payload building, provisioning and sync.

Deploy and develop with the Swell CLI:

```bash
swell app push
swell app dev
```

`.dev.vars*` files are gitignored; keep local secrets there.

## Project layout

```
swell.json          App manifest (id, type, permissions)
assets/             App icon
content/            Admin UI fields added to customer records
functions/          Swell functions and shared lib/
settings/           App settings (connection, sync, chat)
test/               Vitest unit tests and helpers
```
