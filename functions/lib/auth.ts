import type { Connection } from './gorgias';

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

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message)));
}

export interface AppSecrets {
  // Sent by Gorgias to gorgias-events (set in the integration's headers)
  events: string;
  // Sent only by the app's own functions to sync
  internal: string;
}

// The app's secrets are derived from the merchant's Gorgias API key instead of
// being stored: anything an app writes through the Swell API is kept in the
// store's request logs, which every installed app can read. Changing the API
// key or the helpdesk changes them, which also revokes the old ones, and
// clearing the connection settings leaves nothing to accept.
export async function appSecrets(
  connection: Connection,
  storeId: string,
): Promise<AppSecrets> {
  const scope = `${storeId}|${connection.subdomain}`;
  const [events, internal] = await Promise.all([
    hmacHex(connection.apiKey, `gorgias-events|${scope}`),
    hmacHex(connection.apiKey, `sync|${scope}`),
  ]);
  return { events, internal };
}
