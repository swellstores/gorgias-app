import { describe, it, expect } from 'vitest';
import {
  adminBaseUrl,
  buildCustomerData,
  buildOrderSummary,
  formatMoney,
  accountPhone,
} from '../../functions/lib/payload';

const account = {
  id: 'acc1',
  email: 'jane@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  order_count: 3,
  order_value: 245.5,
  currency: 'USD',
  date_first_order: '2025-02-10T00:00:00.000Z',
  shipping: { phone: '+15551234567' },
};

const order = {
  id: 'ord1',
  number: 1042,
  status: 'complete',
  paid: true,
  currency: 'USD',
  grand_total: 89,
  date_created: '2026-07-30T12:00:00.000Z',
  items: [
    { product_name: 'Blue Mug', quantity: 2, price_total: 40 },
    { product: { name: 'Red Mug' }, quantity: 1, price: 49 },
  ],
  shipments: {
    results: [
      { tracking_code: '1Z999', carrier_name: 'UPS' },
      { tracking_code: 'XX', carrier: 'usps', canceled: true },
      { carrier: 'fedex' },
      { tracking_code: 'NOCARRIER' },
    ],
  },
};

describe('formatMoney', () => {
  it('formats numbers with currency', () => {
    expect(formatMoney(89, 'USD')).toBe('89.00 USD');
    expect(formatMoney(0, 'USD')).toBe('0.00 USD');
    expect(formatMoney('bad')).toBe('');
  });
});

describe('buildOrderSummary', () => {
  it('builds the order shape with items and tracking', () => {
    const result = buildOrderSummary(order, 'https://admin.example.com/admin');
    expect(result.number).toBe('1042');
    expect(result.status).toBe('complete');
    expect(result.total).toBe('89.00 USD');
    expect(result.date).toBe('2026-07-30');
    expect(result.items).toEqual([
      { name: 'Blue Mug', quantity: 2, price: '40.00 USD' },
      { name: 'Red Mug', quantity: 1, price: '49.00 USD' },
    ]);
    expect(result.tracking).toEqual([
      { carrier: 'UPS', number: '1Z999' },
      { carrier: 'Shipment', number: 'NOCARRIER' },
    ]);
    expect(result.admin_url).toBe('https://admin.example.com/admin/orders/ord1');
  });
  it('reports canceled status', () => {
    expect(buildOrderSummary({ ...order, canceled: true }).status).toBe('canceled');
  });
});

describe('buildCustomerData', () => {
  it('builds the customer and orders payload', () => {
    const data = buildCustomerData({
      account,
      orders: [order],
      store: { admin_url: 'https://admin.example.com/' },
    });
    expect(data.customer).toMatchObject({
      swell_id: 'acc1',
      name: 'Jane Doe',
      email: 'jane@example.com',
      orders_count: 3,
      total_spent: '245.50 USD',
      since: '2025-02-10',
      admin_url: 'https://admin.example.com/admin/customers/acc1',
    });
    expect(data.orders).toHaveLength(1);
    expect(data).not.toHaveProperty('subscriptions');
  });
  it('tolerates empty inputs and falls back to the email as the name', () => {
    const data = buildCustomerData({
      account: { id: 'a', email: 'x@y.z' },
      store: {},
    });
    expect(data.orders).toEqual([]);
    expect(data.customer.name).toBe('x@y.z');
    expect(data.customer.admin_url).toBe('');
  });
});

describe('adminBaseUrl', () => {
  it('appends /admin and the env segment for non-live envs', () => {
    expect(adminBaseUrl({ admin_url: 'https://x.swell.store' })).toBe(
      'https://x.swell.store/admin',
    );
    expect(adminBaseUrl({ admin_url: 'https://x.swell.store/' }, 'test')).toBe(
      'https://x.swell.store/admin/test',
    );
    expect(adminBaseUrl({ admin_url: 'https://x.swell.store' }, 'live')).toBe(
      'https://x.swell.store/admin',
    );
    expect(adminBaseUrl({})).toBe('');
  });
});

describe('accountPhone', () => {
  it('prefers account.phone, falls back to shipping', () => {
    expect(accountPhone({ phone: '1', shipping: { phone: '2' } })).toBe('1');
    expect(accountPhone(account)).toBe('+15551234567');
    expect(accountPhone({})).toBeUndefined();
  });
});
