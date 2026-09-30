import { describe, it, expect } from 'vitest';
import { functionUrl, functionsBaseUrl } from '../../functions/lib/urls';

describe('functionsBaseUrl', () => {
  it('uses the origin of admin_url, with or without an /admin suffix', () => {
    expect(functionsBaseUrl({ admin_url: 'https://acme.swell.store' })).toBe(
      'https://acme.swell.store',
    );
    expect(functionsBaseUrl({ admin_url: 'https://acme.swell.store/admin/' })).toBe(
      'https://acme.swell.store',
    );
  });
  it('falls back to the store id host', () => {
    expect(functionsBaseUrl({ id: 'acme' })).toBe('https://acme.swell.store');
    expect(functionsBaseUrl({ id: 'acme', admin_url: 'not a url' })).toBe(
      'https://acme.swell.store',
    );
  });
});

describe('functionUrl', () => {
  it('never uses the storefront url', () => {
    const store = {
      id: 'acme',
      url: 'https://shop.example.com',
      admin_url: 'https://acme.swell.store',
    };
    expect(functionUrl(store, 'gorgias', 'sync')).toBe(
      'https://acme.swell.store/functions/gorgias/sync',
    );
  });
});
