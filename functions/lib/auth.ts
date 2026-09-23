// Timing-safe comparison — avoids leaking secret length/content via early exit.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

// Params reach a function as req.query when invoked directly (local dev) but
// as req.data when routed through the platform gateway ($call.data) — read both.
export function requestParams(req: {
  query?: { [key: string]: string };
  data?: unknown;
}): { [key: string]: string } {
  const data =
    typeof req.data === 'object' && req.data !== null ? req.data : {};
  return { ...req.query, ...(data as { [key: string]: string }) };
}

// Accepts the secret via header (set on the Gorgias integration/buttons) or ?key= param.
export function verifySharedSecret(
  req: {
    headers: Headers;
    query?: { [key: string]: string };
    data?: unknown;
  },
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const provided =
    req.headers.get('x-swell-gorgias-secret') || requestParams(req).key || '';
  return provided.length > 0 && timingSafeEqual(provided, secret);
}

export async function hmacSha256Hex(
  secret: string,
  payload: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Gorgias signs HTTP-integration requests with the integration's hmac_secret.
// Verified only when the signature header is present; the shared-secret header
// is the primary gate.
export async function verifyGorgiasHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return true;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(signatureHeader.toLowerCase(), expected);
}
