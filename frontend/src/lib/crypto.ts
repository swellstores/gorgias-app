const encoder = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

// Timing-safe comparison — avoids leaking secret length/content via early exit.
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

export function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

// OAuth `state`: a signed, expiring payload, so the stateless callback can
// trust where it sends the browser without a database lookup.
export async function signState(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyState<T extends { x: number }>(
  secret: string,
  state: string | undefined,
  now = Date.now(),
): Promise<T | null> {
  const [body, signature, extra] = String(state || '').split('.');
  if (!body || !signature || extra !== undefined) return null;
  if (!timingSafeEqual(signature, await hmacHex(secret, body))) return null;
  try {
    const payload = JSON.parse(fromBase64url(body)) as T;
    return typeof payload?.x === 'number' && payload.x > now ? payload : null;
  } catch {
    return null;
  }
}
