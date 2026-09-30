import { describe, it, expect, vi } from 'vitest';
import {
  provision,
  buildIntegrationPayload,
  buildWidgetPayload,
  INTEGRATION_NAME,
  TICKET_FORM,
} from '../../functions/lib/provision';
import type { GorgiasClient } from '../../functions/lib/gorgias';

const eventsUrl =
  'https://teststore.swell.store/functions/gorgias/gorgias-events';
const options = {
  eventsUrl,
  eventsSecret: 'shh',
  publicKey: 'app_pk_test_123',
  ownerTag: 'install 0123456789abcdef',
  syncTicketUpdates: true,
};

function stubClient(overrides: Partial<Record<keyof GorgiasClient, any>> = {}) {
  return {
    getIntegration: vi.fn().mockResolvedValue(null),
    listIntegrations: vi.fn().mockResolvedValue([]),
    createIntegration: vi.fn().mockResolvedValue({ id: 11 }),
    updateIntegration: vi.fn().mockResolvedValue({ id: 11 }),
    listWidgets: vi.fn().mockResolvedValue([]),
    createWidget: vi.fn().mockResolvedValue({ id: 22 }),
    updateWidget: vi.fn().mockResolvedValue({ id: 22 }),
    ...overrides,
  } as unknown as GorgiasClient;
}

describe('buildIntegrationPayload', () => {
  it('sends ticket context in the JSON body, not the URL', () => {
    const { http } = buildIntegrationPayload(options);
    expect(http.url).toBe(eventsUrl);
    expect(http.method).toBe('POST');
    expect(http.request_content_type).toBe('application/json');
    expect(http.form).toEqual(TICKET_FORM);
    expect(http.form.ticket_id).toBe('{{ticket.id}}');
  });
  it('tags the description with the install owner', () => {
    expect(buildIntegrationPayload(options).description).toContain(
      'install 0123456789abcdef',
    );
  });
  it('authenticates with headers only, without an HMAC secret', () => {
    const { http } = buildIntegrationPayload(options);
    expect(http.headers).toEqual({
      'X-Swell-Gorgias-Secret': 'shh',
      Authorization: 'app_pk_test_123',
    });
    expect(http).not.toHaveProperty('hmac_secret');
  });
  it('subscribes to ticket updates only when enabled', () => {
    expect(buildIntegrationPayload(options).http.triggers).toEqual({
      'ticket-created': true,
      'ticket-updated': true,
    });
    expect(
      buildIntegrationPayload({ ...options, syncTicketUpdates: false }).http
        .triggers['ticket-updated'],
    ).toBe(false);
  });
});

describe('buildWidgetPayload', () => {
  it('declares a ticket-context http widget of cards and lists', () => {
    const payload = buildWidgetPayload(11);
    expect(payload).toMatchObject({
      type: 'http',
      context: 'ticket',
      integration_id: 11,
    });
    const root = payload.template.widgets[0];
    expect(root.type).toBe('card');
    const [customer, orders] = root.widgets;
    expect(customer).toMatchObject({ type: 'card', path: 'customer' });
    expect(orders).toMatchObject({ type: 'list', path: 'orders' });
    // every list renders its items as cards
    expect(orders.widgets[0].type).toBe('card');
    const nestedLists = orders.widgets[0].widgets.filter(
      (w: SwellData) => w.type === 'list',
    );
    expect(nestedLists.map((w: SwellData) => w.path)).toEqual(['items', 'tracking']);
    nestedLists.forEach((w: SwellData) => expect(w.widgets[0].type).toBe('card'));
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
    // a brand-new integration has no widgets to look for
    expect(client.listWidgets).not.toHaveBeenCalled();
  });

  it('reuses the saved integration id without listing', async () => {
    const client = stubClient({
      getIntegration: vi.fn().mockResolvedValue({ id: 7, type: 'http' }),
      listWidgets: vi
        .fn()
        .mockResolvedValue([
          { id: 8, type: 'http', integration_id: 7, context: 'ticket' },
        ]),
    });
    const result = await provision(client, { ...options, integrationId: 7 });
    expect(result.integration).toEqual({ id: 7, created: false });
    expect(result.widget).toEqual({ id: 8, created: false });
    expect(client.listIntegrations).not.toHaveBeenCalled();
    expect(client.updateIntegration).toHaveBeenCalledWith(7, expect.anything());
    expect(client.updateWidget).toHaveBeenCalledWith(8, expect.anything());
    expect(client.createWidget).not.toHaveBeenCalled();
  });

  it('adopts its own integration by the owner tag (headers are not returned)', async () => {
    const client = stubClient({
      listIntegrations: vi.fn().mockResolvedValue([
        {
          id: 7,
          name: INTEGRATION_NAME,
          type: 'http',
          description: `Managed by the Gorgias app in Swell (${options.ownerTag}).`,
          http: { url: eventsUrl },
        },
      ]),
    });
    const result = await provision(client, options);
    expect(result.integration).toEqual({ id: 7, created: false });
  });

  it("does not adopt another store's or environment's integration", async () => {
    const client = stubClient({
      listIntegrations: vi.fn().mockResolvedValue([
        // same store, other environment or another store: different tag
        {
          id: 3,
          name: INTEGRATION_NAME,
          type: 'http',
          description: 'Managed by the Gorgias app in Swell (install ffffffffffffffff).',
          http: { url: eventsUrl },
        },
        // a merchant's own integration that happens to be called Swell
        { id: 5, name: INTEGRATION_NAME, type: 'http', http: { url: eventsUrl } },
      ]),
    });
    const result = await provision(client, options);
    expect(result.integration).toEqual({ id: 11, created: true });
    expect(client.updateIntegration).not.toHaveBeenCalled();
  });

  it('reports a deactivated integration', async () => {
    const client = stubClient({
      getIntegration: vi.fn().mockResolvedValue({
        id: 7,
        type: 'http',
        deactivated_datetime: '2026-09-20T00:00:00Z',
      }),
    });
    const result = await provision(client, { ...options, integrationId: 7 });
    expect(result.deactivated).toBe(true);
  });

  it('never modifies widgets it did not create', async () => {
    const client = stubClient({
      getIntegration: vi.fn().mockResolvedValue({ id: 7, type: 'http' }),
      listWidgets: vi.fn().mockResolvedValue([
        { id: 9, type: 'customer_external_data', context: 'ticket' },
        { id: 10, type: 'http', integration_id: 99, context: 'ticket' },
      ]),
    });
    const result = await provision(client, { ...options, integrationId: 7 });
    expect(result.widget).toEqual({ id: 22, created: true });
    expect(client.updateWidget).not.toHaveBeenCalled();
  });
});
