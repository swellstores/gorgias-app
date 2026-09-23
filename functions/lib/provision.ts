// Idempotent provisioning of Gorgias-side objects (HTTP integration + sidebar
// widget). Objects are found by fixed name/app_id lookup so re-running connect
// reconfigures instead of duplicating.

import { GorgiasClient } from './gorgias';

export const INTEGRATION_NAME = 'Swell';

export interface ProvisionOptions {
  eventsUrl: string;
  sharedSecret: string;
  syncTicketUpdates: boolean;
  // App public key; Swell's gateway requires it to route public function calls
  publicKey?: string;
}

// Ticket context arrives as query params (the documented Gorgias templating
// pattern); the events function reads req.query.
export function buildIntegrationPayload(options: ProvisionOptions): SwellData {
  const url =
    `${options.eventsUrl}?ticket_id={{ticket.id}}` +
    `&email={{ticket.customer.email}}` +
    `&external_id={{ticket.customer.external_id}}` +
    `&subject={{ticket.subject}}` +
    `&status={{ticket.status}}` +
    `&channel={{ticket.channel}}`;

  return {
    name: INTEGRATION_NAME,
    type: 'http',
    http: {
      url,
      method: 'POST',
      request_content_type: 'application/json',
      response_content_type: 'application/json',
      headers: {
        'X-Swell-Gorgias-Secret': options.sharedSecret,
        ...(options.publicKey ? { Authorization: options.publicKey } : {}),
      },
      hmac_secret: options.sharedSecret,
      triggers: {
        'ticket-created': true,
        'ticket-updated': options.syncTicketUpdates,
      },
    },
  };
}

// Renders paths from the buildCustomerData() shape in lib/payload.ts.
export function buildWidgetTemplate(): SwellData {
  return {
    type: 'wrapper',
    order: 0,
    widgets: [
      {
        type: 'card',
        title: 'Swell customer',
        order: 0,
        path: 'customer',
        widgets: [
          { type: 'text', title: 'Name', path: 'name', order: 0 },
          { type: 'text', title: 'Orders', path: 'orders_count', order: 1 },
          { type: 'text', title: 'Total spent', path: 'total_spent', order: 2 },
          { type: 'text', title: 'Customer since', path: 'since', order: 3 },
          {
            type: 'text',
            title: 'Admin',
            path: 'admin_url',
            order: 4,
            meta: { link: true },
          },
        ],
      },
      {
        type: 'list',
        title: 'Recent orders',
        order: 1,
        path: 'orders',
        widgets: [
          { type: 'text', title: 'Order', path: 'number', order: 0 },
          { type: 'text', title: 'Status', path: 'status', order: 1 },
          { type: 'text', title: 'Date', path: 'date', order: 2 },
          { type: 'text', title: 'Total', path: 'total', order: 3 },
          {
            type: 'text',
            title: 'Admin',
            path: 'admin_url',
            order: 4,
            meta: { link: true },
          },
        ],
      },
    ],
  };
}

// http-type widget: rendered from the JSON response of our HTTP integration
// (gorgias-events), which fires on the integration's ticket triggers.
// (customer_external_data + pushed data is OAuth-app-only — public phase.)
export function buildWidgetPayload(integrationId: number): SwellData {
  return {
    type: 'http',
    context: 'ticket',
    integration_id: integrationId,
    template: buildWidgetTemplate(),
  };
}

export interface ProvisionResult {
  integration: { id: number; created: boolean };
  widget: { id: number; created: boolean };
}

export async function provision(
  gorgias: GorgiasClient,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const integrationPayload = buildIntegrationPayload(options);
  const integrations = await gorgias.listIntegrations();
  const existingIntegration = integrations.find(
    (i) => i.name === INTEGRATION_NAME && i.type === 'http',
  );

  let integration: { id: number; created: boolean };
  if (existingIntegration) {
    await gorgias.updateIntegration(existingIntegration.id, integrationPayload);
    integration = { id: existingIntegration.id, created: false };
  } else {
    const created = await gorgias.createIntegration(integrationPayload);
    integration = { id: created.id, created: true };
  }

  const widgetPayload = buildWidgetPayload(integration.id);
  const widgets = await gorgias.listWidgets();
  const existingWidget = widgets.find(
    (w) => w.type === 'http' && w.integration_id === integration.id,
  );

  let widget: { id: number; created: boolean };
  if (existingWidget) {
    await gorgias.updateWidget(existingWidget.id, widgetPayload);
    widget = { id: existingWidget.id, created: false };
  } else {
    const created = await gorgias.createWidget(widgetPayload);
    widget = { id: created.id, created: true };
  }

  // Remove the stale push-model widget from earlier installs (its data source
  // is unusable without OAuth).
  const stale = widgets.find(
    (w) => w.type === 'customer_external_data' && w.context === 'ticket',
  );
  if (stale) {
    await gorgias.deleteWidget(stale.id).catch(() => undefined);
  }

  return { integration, widget };
}
