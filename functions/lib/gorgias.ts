// Gorgias REST API client for Workers runtime.
// Basic auth (private-app phase); OAuth support later only changes the
// constructor and authHeader(). Rate limit: 40 req/20s per account (Basic),
// shared across all API-key integrations — requests are spaced sequentially
// and 429s honor Retry-After within the remaining invocation budget.

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

const MIN_REQUEST_INTERVAL_MS = 600;
const MAX_RETRIES_429 = 2;

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
      url += (url.includes('?') ? '&' : '?') + params.toString();
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
      if (location) return this.request(method, location, options, attempt + 1);
    }

    if (res.status === 429 && attempt < MAX_RETRIES_429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
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

  // --- API helpers ---

  checkAuth() {
    return this.get('/api/account');
  }

  async findCustomerByEmail(email: string): Promise<any | null> {
    const res = await this.get('/api/customers', { email, limit: 1 });
    return res?.data?.[0] || null;
  }

  async upsertCustomer(fields: {
    email: string;
    firstname?: string;
    lastname?: string;
    external_id?: string;
    phone?: string;
  }): Promise<any> {
    const existing = await this.findCustomerByEmail(fields.email);
    const body: Record<string, unknown> = {
      email: fields.email,
      firstname: fields.firstname || undefined,
      lastname: fields.lastname || undefined,
      external_id: fields.external_id || undefined,
    };
    if (fields.phone) {
      body.channels = [{ type: 'phone', address: fields.phone }];
    }
    if (existing) {
      return this.put(`/api/customers/${existing.id}`, body);
    }
    try {
      return await this.post('/api/customers', body);
    } catch (err) {
      // Email search can miss a customer that already holds this external_id
      // (e.g. index lag or changed email) — find and update it instead.
      if (
        err instanceof GorgiasError &&
        err.status === 409 &&
        fields.external_id
      ) {
        const res = await this.get('/api/customers', {
          external_id: fields.external_id,
          limit: 1,
        });
        const match = res?.data?.[0];
        if (match) return this.put(`/api/customers/${match.id}`, body);
      }
      throw err;
    }
  }

  // Version is a monotonic stale-write guard — a current timestamp always
  // supersedes prior writes. NOTE: this endpoint is OAuth-app-only; with Basic
  // auth Gorgias returns 400 "only accessible via OAuth" — we return null so
  // Basic-auth installs skip it (sidebar data comes from the http widget pull
  // instead) and the code path lights up in the OAuth phase.
  async putCustomerData(
    customerId: number,
    data: SwellData,
  ): Promise<any | null> {
    const doPut = () =>
      this.put(`/api/customers/${customerId}/data`, {
        data,
        version: new Date().toISOString(),
      });
    try {
      return await doPut();
    } catch (err) {
      if (err instanceof GorgiasError) {
        if (err.status === 409) return doPut();
        if (err.status === 400 && /oauth/i.test(JSON.stringify(err.body))) {
          return null;
        }
      }
      throw err;
    }
  }

  async listIntegrations(): Promise<any[]> {
    const res = await this.get('/api/integrations', { limit: 100 });
    return res?.data || [];
  }
  async listChatIntegrations(): Promise<any[]> {
    const res = await this.get('/api/integrations', {
      type: 'gorgias_chat',
      limit: 100,
    });
    return res?.data || [];
  }
  createIntegration(data: SwellData) {
    return this.post('/api/integrations', data);
  }
  updateIntegration(id: number, data: SwellData) {
    return this.put(`/api/integrations/${id}`, data);
  }

  async listWidgets(): Promise<any[]> {
    const res = await this.get('/api/widgets', { limit: 100 });
    return res?.data || [];
  }
  createWidget(data: SwellData) {
    return this.post('/api/widgets', data);
  }
  updateWidget(id: number, data: SwellData) {
    return this.put(`/api/widgets/${id}`, data);
  }
  deleteWidget(id: number) {
    return this.request('DELETE', `/api/widgets/${id}`);
  }

  createInternalNote(ticketId: number, bodyText: string) {
    return this.post(`/api/tickets/${ticketId}/messages`, {
      channel: 'internal-note',
      via: 'api',
      source: { type: 'internal-note' },
      body_text: bodyText,
      internal: true,
    });
  }
}

export function clientFromSettings(settings: SwellSettings): GorgiasClient {
  const conn = settings?.connection || {};
  if (!conn.subdomain || !conn.email || !conn.api_key) {
    throw new Error(
      'Gorgias connection settings are incomplete (subdomain, email, api_key required)',
    );
  }
  return new GorgiasClient({
    subdomain: String(conn.subdomain).trim(),
    email: String(conn.email).trim(),
    apiKey: String(conn.api_key).trim(),
  });
}
