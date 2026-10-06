// Gorgias REST API client for Workers runtime.
// Basic auth with a REST API key. Rate limit: 40 req/20s per account —
// requests are spaced sequentially and 429s honor Retry-After within the
// remaining invocation budget.

export interface GorgiasAuth {
  subdomain: string;
  email: string;
  apiKey: string;
}

export class GorgiasError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface CustomerFields {
  email: string;
  name?: string;
  external_id?: string;
  phone?: string;
}

const MIN_REQUEST_INTERVAL_MS = 600;
const MAX_RETRIES_429 = 2;
const MAX_LIST_PAGES = 10;

// List endpoints answer { data, meta: { next_cursor } }; some are documented as
// a bare array, so accept both.
function listData(res: any): any[] {
  if (Array.isArray(res)) return res;
  return Array.isArray(res?.data) ? res.data : [];
}

export class GorgiasClient {
  private auth: GorgiasAuth;
  private lastRequestAt = 0;

  constructor(auth: GorgiasAuth) {
    this.auth = auth;
  }

  get baseUrl(): string {
    return `https://${this.auth.subdomain}.gorgias.com`;
  }

  private authHeader(): string {
    return `Basic ${btoa(`${this.auth.email}:${this.auth.apiKey}`)}`;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  async request(
    method: string,
    path: string,
    options: { query?: Record<string, any>; data?: unknown } = {},
    attempt = 0,
  ): Promise<any> {
    await this.throttle();
    let url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
    });

    // 301 = merged customer; follow to the surviving record once.
    if (res.status === 301 && attempt < 1) {
      const location = res.headers.get('location');
      if (location) {
        return this.request(
          method,
          new URL(location, this.baseUrl).toString(),
          { data: options.data },
          attempt + 1,
        );
      }
    }

    // Waits are capped so a batch can't sleep past the 10s function timeout.
    if (res.status === 429 && attempt < MAX_RETRIES_429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 3) * 1000));
      return this.request(method, path, options, attempt + 1);
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    if (!res.ok) {
      throw new GorgiasError(
        `Gorgias ${method} ${path} failed: ${res.status}`,
        res.status,
        body,
      );
    }
    return body;
  }

  get(path: string, query?: Record<string, any>) {
    return this.request('GET', path, { query });
  }
  post(path: string, data?: unknown) {
    return this.request('POST', path, { data });
  }
  put(path: string, data?: unknown) {
    return this.request('PUT', path, { data });
  }

  private async listAll(path: string, query: Record<string, any> = {}) {
    const results: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.get(path, { ...query, limit: 100, cursor });
      results.push(...listData(res));
      cursor = res?.meta?.next_cursor || undefined;
      if (!cursor) break;
    }
    return results;
  }

  // --- API helpers ---

  checkAuth() {
    return this.get('/api/account');
  }

  async findCustomer(query: Record<string, string>): Promise<any | null> {
    const res = await this.get('/api/customers', { ...query, limit: 1 });
    return listData(res)[0] || null;
  }

  // Looks up by external_id (the Swell account id, stable across email
  // changes), then by email. Name is sent as `name`; firstname/lastname are
  // derived by Gorgias.
  async upsertCustomer(fields: CustomerFields): Promise<any> {
    let existing = fields.external_id
      ? await this.findCustomer({ external_id: fields.external_id })
      : null;
    if (!existing) {
      existing = await this.findCustomer({ email: fields.email });
    }
    if (existing) {
      return this.updateCustomer(existing, fields);
    }
    try {
      return await this.post('/api/customers', customerCreateBody(fields));
    } catch (err) {
      // Search can lag behind a customer that already holds this address.
      if (err instanceof GorgiasError && err.status === 409) {
        const match = await this.findCustomer({
          channel_type: 'email',
          channel_address: fields.email,
        });
        if (match) return this.updateCustomer(match, fields);
      }
      throw err;
    }
  }

  private async updateCustomer(existing: any, fields: CustomerFields) {
    // List results don't carry channels; the full record is needed to add a
    // phone without dropping the channels the customer already has.
    if (fields.phone && !Array.isArray(existing.channels)) {
      existing = await this.get(`/api/customers/${existing.id}`);
    }
    const body = customerUpdateBody(existing, fields);
    try {
      return await this.put(`/api/customers/${existing.id}`, body);
    } catch (err) {
      // The new email or phone already belongs to another Gorgias customer
      // (e.g. after an email change in Swell): keep the link, skip the contact.
      if (err instanceof GorgiasError && err.status === 409) {
        return this.put(`/api/customers/${existing.id}`, {
          name: body.name,
          external_id: body.external_id,
        });
      }
      throw err;
    }
  }

  async getIntegration(id: number): Promise<any | null> {
    try {
      return await this.get(`/api/integrations/${id}`);
    } catch (err) {
      if (err instanceof GorgiasError && err.status === 404) return null;
      throw err;
    }
  }
  listIntegrations(): Promise<any[]> {
    return this.listAll('/api/integrations');
  }
  createIntegration(data: SwellData) {
    return this.post('/api/integrations', data);
  }
  updateIntegration(id: number, data: SwellData) {
    return this.put(`/api/integrations/${id}`, data);
  }

  listWidgets(integrationId: number): Promise<any[]> {
    return this.listAll('/api/widgets', { integration_id: integrationId });
  }
  createWidget(data: SwellData) {
    return this.post('/api/widgets', data);
  }
  updateWidget(id: number, data: SwellData) {
    return this.put(`/api/widgets/${id}`, data);
  }
}

function phoneChannel(phone: string) {
  return { type: 'phone', address: phone };
}

export function customerCreateBody(fields: CustomerFields): SwellData {
  const channels: SwellData[] = [
    { type: 'email', address: fields.email, preferred: true },
  ];
  if (fields.phone) channels.push(phoneChannel(fields.phone));
  return {
    email: fields.email,
    name: fields.name || undefined,
    external_id: fields.external_id || undefined,
    channels,
  };
}

// Channels are only sent to add a missing phone, and then as the full merged
// list so an update can't drop the customer's existing email/phone channels.
export function customerUpdateBody(
  existing: SwellData,
  fields: CustomerFields,
): SwellData {
  const body: SwellData = {
    email: fields.email,
    name: fields.name || undefined,
    external_id: fields.external_id || undefined,
  };
  const current: SwellData[] = Array.isArray(existing?.channels)
    ? existing.channels
    : [];
  const hasPhone = current.some(
    (c) => c?.type === 'phone' && c?.address === fields.phone,
  );
  if (fields.phone && !hasPhone && Array.isArray(existing?.channels)) {
    body.channels = [
      ...current.map((c) => ({
        type: c.type,
        address: c.address,
        preferred: !!c.preferred,
      })),
      phoneChannel(fields.phone),
    ];
  }
  return body;
}

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Accepts "acme", "acme.gorgias.com" or a pasted helpdesk URL. The result is
// used to build the URL the API key is sent to, so anything else is refused.
export function normalizeSubdomain(input: unknown): string | null {
  let value = String(input ?? '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (value.endsWith('.gorgias.com')) {
    value = value.slice(0, -'.gorgias.com'.length);
  }
  return SUBDOMAIN.test(value) ? value : null;
}

export interface Connection {
  subdomain: string;
  email: string;
  apiKey: string;
}

// The merchant's connection settings, or null until all three are filled in
// (a subdomain that isn't a single helpdesk name counts as missing).
export function connectionFromSettings(settings: SwellSettings): Connection | null {
  const conn = settings?.connection || {};
  const subdomain = normalizeSubdomain(conn.subdomain);
  const email = String(conn.email || '').trim();
  const apiKey = String(conn.api_key || '').trim();
  return subdomain && email && apiKey ? { subdomain, email, apiKey } : null;
}

export function hasConnection(settings: SwellSettings): boolean {
  return connectionFromSettings(settings) !== null;
}

// Rejected credentials are a configuration problem, not a transient failure:
// event handlers skip instead of throwing, so the platform doesn't retry and
// eventually auto-disable them. reconcile() logs it and keeps it as the last error.
export function isAuthError(err: unknown): boolean {
  return (
    err instanceof GorgiasError && (err.status === 401 || err.status === 403)
  );
}

export function clientFromSettings(settings: SwellSettings): GorgiasClient {
  const connection = connectionFromSettings(settings);
  if (!connection) {
    throw new Error(
      'Gorgias connection settings are incomplete (subdomain, email, api_key required)',
    );
  }
  return new GorgiasClient(connection);
}
