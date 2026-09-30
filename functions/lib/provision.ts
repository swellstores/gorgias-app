// Idempotent provisioning of Gorgias-side objects (HTTP integration + sidebar
// widget). The integration is found by the id saved from the last run, falling
// back to the owner tag in its description, so re-running reconfigures instead
// of duplicating. Nothing the app didn't create is modified or deleted.

import { GorgiasClient } from './gorgias';

export const INTEGRATION_NAME = 'Swell';

// Bump when the integration or widget payload changes, so existing installs
// re-provision on the next reconcile.
export const TEMPLATE_VERSION = '3';

export interface ProvisionOptions {
  eventsUrl: string;
  eventsSecret: string;
  // App public key; the gateway needs it to route calls to gorgias-events
  publicKey: string;
  // Identifies this store + environment's install (see ownerTag in connect.ts)
  ownerTag: string;
  syncTicketUpdates: boolean;
  integrationId?: number | null;
}

// Ticket context goes in the JSON body (`form`): the gateway drops URL query
// params whenever a request has a body. gorgias-events reads req.data.
export const TICKET_FORM = {
  ticket_id: '{{ticket.id}}',
  email: '{{ticket.customer.email}}',
  external_id: '{{ticket.customer.external_id}}',
  subject: '{{ticket.subject}}',
  status: '{{ticket.status}}',
  channel: '{{ticket.channel}}',
};

export function buildIntegrationPayload(options: ProvisionOptions): SwellData {
  return {
    name: INTEGRATION_NAME,
    description: `Managed by the Gorgias app in Swell (${options.ownerTag}). Changes made here are overwritten.`,
    type: 'http',
    http: {
      url: options.eventsUrl,
      method: 'POST',
      request_content_type: 'application/json',
      response_content_type: 'application/json',
      headers: {
        'X-Swell-Gorgias-Secret': options.eventsSecret,
        Authorization: options.publicKey,
      },
      form: TICKET_FORM,
      triggers: {
        'ticket-created': true,
        'ticket-updated': options.syncTicketUpdates,
      },
    },
  };
}

function textField(title: string, path: string, order: number) {
  return { type: 'text', title, path, order };
}

// Renders paths from the buildCustomerData() shape in lib/payload.ts, using
// Gorgias's documented layout: a root card, and lists of cards.
export function buildWidgetTemplate(): SwellData {
  return {
    type: 'wrapper',
    widgets: [
      {
        type: 'card',
        title: 'Swell',
        path: '',
        order: 0,
        meta: { displayCard: true, link: '' },
        widgets: [
          {
            type: 'card',
            title: '{{name}}',
            path: 'customer',
            order: 0,
            meta: { displayCard: true, link: '{{admin_url}}' },
            widgets: [
              textField('Email', 'email', 0),
              textField('Orders', 'orders_count', 1),
              textField('Total spent', 'total_spent', 2),
              textField('Customer since', 'since', 3),
            ],
          },
          {
            type: 'list',
            path: 'orders',
            order: 1,
            meta: { limit: '', orderBy: '' },
            widgets: [
              {
                type: 'card',
                title: 'Order {{number}} · {{status}}',
                meta: { displayCard: true, link: '{{admin_url}}' },
                widgets: [
                  textField('Date', 'date', 0),
                  textField('Total', 'total', 1),
                  {
                    type: 'list',
                    path: 'items',
                    order: 2,
                    meta: { limit: '', orderBy: '' },
                    widgets: [
                      {
                        type: 'card',
                        title: '{{quantity}} × {{name}}',
                        meta: { displayCard: true, link: '' },
                        widgets: [textField('Price', 'price', 0)],
                      },
                    ],
                  },
                  {
                    type: 'list',
                    path: 'tracking',
                    order: 3,
                    meta: { limit: '', orderBy: '' },
                    widgets: [
                      {
                        type: 'card',
                        title: '{{carrier}}',
                        meta: { displayCard: true, link: '' },
                        widgets: [textField('Tracking number', 'number', 0)],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// http-type widget: rendered from the JSON response of our HTTP integration
// (gorgias-events), which fires on the integration's ticket triggers.
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
  // Gorgias deactivated the integration (e.g. after repeated failures)
  deactivated: boolean;
}

// Without a saved id, only adopt an integration that provably belongs to this
// store and environment: its description carries this install's owner tag.
// (Gorgias no longer returns integration headers, so the public key itself
// can't be compared.) Test and live installs, or several stores sharing one
// helpdesk, each keep their own.
async function findOwnIntegration(
  gorgias: GorgiasClient,
  options: ProvisionOptions,
): Promise<any | null> {
  if (options.integrationId) {
    const saved = await gorgias.getIntegration(options.integrationId);
    if (saved?.type === 'http') return saved;
  }
  const integrations = await gorgias.listIntegrations();
  return (
    integrations.find(
      (i) =>
        i.type === 'http' &&
        i.name === INTEGRATION_NAME &&
        String(i.description || '').includes(options.ownerTag),
    ) || null
  );
}

export async function provision(
  gorgias: GorgiasClient,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const integrationPayload = buildIntegrationPayload(options);
  const existingIntegration = await findOwnIntegration(gorgias, options);

  let integration: { id: number; created: boolean };
  if (existingIntegration) {
    await gorgias.updateIntegration(existingIntegration.id, integrationPayload);
    integration = { id: existingIntegration.id, created: false };
  } else {
    const created = await gorgias.createIntegration(integrationPayload);
    integration = { id: created.id, created: true };
  }

  const widgetPayload = buildWidgetPayload(integration.id);
  const widgets = integration.created
    ? []
    : await gorgias.listWidgets(integration.id);
  const existingWidget = widgets.find(
    (w) =>
      w.type === 'http' &&
      w.context === 'ticket' &&
      w.integration_id === integration.id,
  );

  let widget: { id: number; created: boolean };
  if (existingWidget) {
    await gorgias.updateWidget(existingWidget.id, widgetPayload);
    widget = { id: existingWidget.id, created: false };
  } else {
    const created = await gorgias.createWidget(widgetPayload);
    widget = { id: created.id, created: true };
  }

  return {
    integration,
    widget,
    deactivated: !!existingIntegration?.deactivated_datetime,
  };
}
