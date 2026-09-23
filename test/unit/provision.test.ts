import { describe, it, expect, vi } from 'vitest';
import {
  provision,
  buildIntegrationPayload,
  buildWidgetPayload,
  INTEGRATION_NAME,
} from '../../functions/lib/provision';
import type { GorgiasClient } from '../../functions/lib/gorgias';

const options = {
  eventsUrl: 'https://store.example.com/functions/gorgias/gorgias-events',
  sharedSecret: 'shh',
  syncTicketUpdates: false,
};

function stubClient(overrides: Partial<Record<keyof GorgiasClient, any>> = {}) {
  return {
    listIntegrations: vi.fn().mockResolvedValue([]),
    createIntegration: vi.fn().mockResolvedValue({ id: 11 }),
    updateIntegration: vi.fn().mockResolvedValue({ id: 11 }),
    listWidgets: vi.fn().mockResolvedValue([]),
    createWidget: vi.fn().mockResolvedValue({ id: 22 }),
    updateWidget: vi.fn().mockResolvedValue({ id: 22 }),
    deleteWidget: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GorgiasClient;
}

describe('buildIntegrationPayload', () => {
  it('templates ticket context into the URL and sets auth headers', () => {
    const payload = buildIntegrationPayload(options);
    expect(payload.http.url).toContain('ticket_id={{ticket.id}}');
    expect(payload.http.url).toContain('email={{ticket.customer.email}}');
    expect(payload.http.headers['X-Swell-Gorgias-Secret']).toBe('shh');
    expect(payload.http.hmac_secret).toBe('shh');
    expect(payload.http.triggers['ticket-created']).toBe(true);
    expect(payload.http.triggers['ticket-updated']).toBe(false);
  });
});

describe('buildWidgetPayload', () => {
  it('declares a ticket-context http widget bound to the integration', () => {
    const payload = buildWidgetPayload(11);
    expect(payload.type).toBe('http');
    expect(payload.context).toBe('ticket');
    expect(payload.integration_id).toBe(11);
    expect(payload.template.widgets.length).toBeGreaterThan(0);
  });
});

describe('provision', () => {
  it('creates integration and widget when none exist', async () => {
    const client = stubClient();
    const result = await provision(client, options);
    expect(result.integration).toEqual({ id: 11, created: true });
    expect(result.widget).toEqual({ id: 22, created: true });
    expect(client.createIntegration).toHaveBeenCalledOnce();
    expect(client.createWidget).toHaveBeenCalledOnce();
  });

  it('updates in place when objects already exist (idempotent)', async () => {
    const client = stubClient({
      listIntegrations: vi
        .fn()
        .mockResolvedValue([{ id: 7, name: INTEGRATION_NAME, type: 'http' }]),
      listWidgets: vi
        .fn()
        .mockResolvedValue([
          { id: 8, type: 'http', integration_id: 7, context: 'ticket' },
        ]),
    });
    const result = await provision(client, options);
    expect(result.integration).toEqual({ id: 7, created: false });
    expect(result.widget).toEqual({ id: 8, created: false });
    expect(client.createIntegration).not.toHaveBeenCalled();
    expect(client.createWidget).not.toHaveBeenCalled();
    expect(client.updateIntegration).toHaveBeenCalledWith(7, expect.anything());
    expect(client.updateWidget).toHaveBeenCalledWith(8, expect.anything());
  });

  it('deletes a stale customer_external_data widget on migration', async () => {
    const client = stubClient({
      listIntegrations: vi
        .fn()
        .mockResolvedValue([{ id: 7, name: INTEGRATION_NAME, type: 'http' }]),
      listWidgets: vi
        .fn()
        .mockResolvedValue([
          { id: 9, type: 'customer_external_data', context: 'ticket' },
        ]),
    });
    const result = await provision(client, options);
    expect(result.widget).toEqual({ id: 22, created: true });
    expect(client.deleteWidget).toHaveBeenCalledWith(9);
  });
});
