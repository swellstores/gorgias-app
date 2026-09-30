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

export const SECRET_HEADER = 'x-swell-gorgias-secret';

// Header only: secrets in URLs end up in access logs. Gorgias can't be verified
// by HMAC here because the gateway re-serializes the body before the function
// sees it, so this header is the only gate.
export function verifySecretHeader(
  headers: Headers,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const provided = headers.get(SECRET_HEADER) || '';
  return provided.length > 0 && timingSafeEqual(provided, secret);
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
