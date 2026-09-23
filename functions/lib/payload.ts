// Pure builders: Swell records → Gorgias customer_external_data JSON.
// The widget template (lib/provision.ts) renders paths from this shape.

interface BuildInput {
  account: SwellData;
  orders?: SwellData[];
  subscriptions?: SwellData[];
  store: { admin_url?: string };
  env?: string | null;
}

// store.admin_url is the bare host; dashboard pages live under /admin, with
// the environment segment for non-live envs (/admin/test/...).
export function adminBaseUrl(
  store: { admin_url?: string },
  env?: string | null,
): string {
  const base = (store.admin_url || '').replace(/\/$/, '');
  if (!base) return '';
  const suffix = env && env !== 'live' ? `/admin/${env}` : '/admin';
  return base.endsWith('/admin') ? base : `${base}${suffix}`;
}

export function formatMoney(amount: unknown, currency?: string): string {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount));
  if (!isFinite(n)) return '';
  const formatted = n.toFixed(2);
  return currency ? `${formatted} ${currency}` : formatted;
}

export function formatDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function orderStatusLabel(order: SwellData): string {
  if (order.canceled) return 'canceled';
  return String(order.status || 'pending');
}

export function buildOrderSummary(
  order: SwellData,
  adminUrl?: string,
): SwellData {
  const items = (order.items || []).map((item: SwellData) => ({
    name:
      item.product_name ||
      item.product?.name ||
      item.description ||
      'Item',
    quantity: item.quantity || 1,
    price: formatMoney(item.price_total ?? item.price, order.currency),
  }));

  const shipments = order.shipments?.results || order.shipments || [];
  const tracking = (Array.isArray(shipments) ? shipments : [])
    .filter((s: SwellData) => s.tracking_code && !s.canceled)
    .map((s: SwellData) => ({
      carrier: s.carrier_name || s.carrier || '',
      number: s.tracking_code,
    }));

  return {
    id: order.id,
    number: String(order.number ?? ''),
    status: orderStatusLabel(order),
    paid: !!order.paid,
    refunded: !!order.refunded,
    delivered: !!order.delivered,
    date: formatDate(order.date_created),
    total: formatMoney(order.grand_total, order.currency),
    items,
    tracking,
    admin_url: adminUrl ? `${adminUrl}/orders/${order.id}` : '',
  };
}

export function buildCustomerData(input: BuildInput): SwellData {
  const { account, orders = [], subscriptions = [], store, env } = input;
  const adminUrl = adminBaseUrl(store, env);

  return {
    customer: {
      swell_id: account.id,
      name:
        account.name ||
        [account.first_name, account.last_name].filter(Boolean).join(' '),
      email: account.email,
      group: account.group || '',
      orders_count: account.order_count || 0,
      total_spent: formatMoney(account.order_value || 0, account.currency),
      since: formatDate(account.date_first_order || account.date_created),
      admin_url: adminUrl ? `${adminUrl}/customers/${account.id}` : '',
    },
    orders: orders.map((order) => buildOrderSummary(order, adminUrl)),
    subscriptions: subscriptions.map((sub) => ({
      id: sub.id,
      product: sub.product_name || '',
      plan: sub.plan_name || '',
      status: String(sub.status || ''),
      total: formatMoney(sub.recurring_total, sub.currency),
      admin_url: adminUrl ? `${adminUrl}/subscriptions/${sub.id}` : '',
    })),
  };
}

// Gorgias phone matching improves identity resolution (same trick as Shopify).
export function accountPhone(account: SwellData): string | undefined {
  return account.phone || account.shipping?.phone || account.billing?.phone;
}
