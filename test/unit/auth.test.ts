import { describe, it, expect } from 'vitest';
import {
  timingSafeEqual,
  verifySharedSecret,
  hmacSha256Hex,
  verifyGorgiasHmac,
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

describe('verifySharedSecret', () => {
  const secret = 'abc123';
  it('accepts the secret via header', () => {
    const req = {
      headers: new Headers({ 'X-Swell-Gorgias-Secret': secret }),
      query: {},
    };
    expect(verifySharedSecret(req, secret)).toBe(true);
  });
  it('accepts the secret via ?key=', () => {
    const req = { headers: new Headers(), query: { key: secret } };
    expect(verifySharedSecret(req, secret)).toBe(true);
  });
  it('accepts the secret via data.key (gateway $call.data path)', () => {
    const req = { headers: new Headers(), query: {}, data: { key: secret } };
    expect(verifySharedSecret(req, secret)).toBe(true);
  });
  it('rejects wrong or missing secrets', () => {
    expect(
      verifySharedSecret({ headers: new Headers(), query: { key: 'nope' } }, secret),
    ).toBe(false);
    expect(verifySharedSecret({ headers: new Headers(), query: {} }, secret)).toBe(false);
  });
  it('rejects everything when no secret is configured', () => {
    const req = { headers: new Headers(), query: { key: '' } };
    expect(verifySharedSecret(req, undefined)).toBe(false);
    expect(verifySharedSecret(req, '')).toBe(false);
  });
});

describe('verifyGorgiasHmac', () => {
  it('verifies a valid signature', async () => {
    const body = '{"ticket":1}';
    const sig = await hmacSha256Hex('topsecret', body);
    expect(await verifyGorgiasHmac(body, sig, 'topsecret')).toBe(true);
    expect(await verifyGorgiasHmac(body, sig.toUpperCase(), 'topsecret')).toBe(true);
  });
  it('rejects a bad signature', async () => {
    expect(await verifyGorgiasHmac('{"a":1}', 'deadbeef', 'topsecret')).toBe(false);
  });
  it('passes when no signature header is present', async () => {
    expect(await verifyGorgiasHmac('body', null, 'topsecret')).toBe(true);
  });
});
