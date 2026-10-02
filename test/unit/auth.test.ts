import { describe, it, expect } from 'vitest';
import {
  appSecrets,
  timingSafeEqual,
  verifySecretHeader,
  sha256Hex,
} from '../../functions/lib/auth';

describe('timingSafeEqual', () => {
  it('matches equal strings', () => {
    expect(timingSafeEqual('secret-123', 'secret-123')).toBe(true);
  });
  it('rejects different strings and lengths', () => {
    expect(timingSafeEqual('secret-123', 'secret-124')).toBe(false);
    expect(timingSafeEqual('secret', 'secret-123')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});

describe('verifySecretHeader', () => {
  const secret = 'abc123';
  it('accepts the secret via the X-Swell-Gorgias-Secret header', () => {
    const headers = new Headers({ 'X-Swell-Gorgias-Secret': secret });
    expect(verifySecretHeader(headers, secret)).toBe(true);
  });
  it('rejects wrong or missing secrets', () => {
    expect(
      verifySecretHeader(new Headers({ 'X-Swell-Gorgias-Secret': 'nope' }), secret),
    ).toBe(false);
    expect(verifySecretHeader(new Headers(), secret)).toBe(false);
  });
  it('rejects everything when no secret is configured', () => {
    const headers = new Headers({ 'X-Swell-Gorgias-Secret': '' });
    expect(verifySecretHeader(headers, undefined)).toBe(false);
    expect(verifySecretHeader(headers, '')).toBe(false);
  });
});

describe('appSecrets', () => {
  const connection = { subdomain: 'acme', email: 'a@b.c', apiKey: 'key123' };
  it('derives stable, distinct secrets from the API key', async () => {
    const a = await appSecrets(connection, 'store1');
    expect(a.events).toMatch(/^[0-9a-f]{64}$/);
    expect(a.internal).toMatch(/^[0-9a-f]{64}$/);
    expect(a.events).not.toBe(a.internal);
    expect(await appSecrets(connection, 'store1')).toEqual(a);
  });
  it('changes with the API key, the helpdesk and the store', async () => {
    const base = await appSecrets(connection, 'store1');
    for (const other of [
      await appSecrets({ ...connection, apiKey: 'other' }, 'store1'),
      await appSecrets({ ...connection, subdomain: 'other' }, 'store1'),
      await appSecrets(connection, 'store2'),
    ]) {
      expect(other.events).not.toBe(base.events);
      expect(other.internal).not.toBe(base.internal);
    }
  });
  it('does not contain the API key', async () => {
    const secrets = await appSecrets(connection, 'store1');
    expect(JSON.stringify(secrets)).not.toContain('key123');
  });
});

describe('sha256Hex', () => {
  it('hashes like SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
