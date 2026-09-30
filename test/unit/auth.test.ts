import { describe, it, expect } from 'vitest';
import {
  timingSafeEqual,
  verifySecretHeader,
  randomHex,
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

describe('randomHex', () => {
  it('returns unique hex strings of the requested byte length', () => {
    const a = randomHex(24);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(randomHex(24)).not.toBe(a);
  });
});

describe('sha256Hex', () => {
  it('hashes like SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
