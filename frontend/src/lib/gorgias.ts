// Gorgias OAuth2 (https://developers.gorgias.com/docs/set-up-oauth2-app-store).
// Token, refresh and revoke calls authenticate with the app's client id and
// secret, so they only ever happen in this Worker.

import type { Env } from '../env';
import { fromBase64url } from './crypto';

export const SCOPES = [
  'offline',
  'account:read',
  'customers:read',
  'customers:write',
  'integrations:read',
  'integrations:write',
].join(' ');

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Accepts "acme", "acme.gorgias.com" or a pasted helpdesk URL. The result is
// used to build URLs the client secret is sent to, so anything else is refused.
export function normalizeSubdomain(input: unknown): string | null {
  let value = String(input ?? '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (value.endsWith('.gorgias.com')) {
    value = value.slice(0, -'.gorgias.com'.length);
  }
  return SUBDOMAIN.test(value) ? value : null;
}

export function authorizeUrl(
  env: Env,
  subdomain: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.GORGIAS_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${subdomain}.gorgias.com/oauth/authorize?${params}`;
}

export class OAuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(`Gorgias OAuth error ${status}: ${code}`);
    this.status = status;
    this.code = code;
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function clientAuth(env: Env): string {
  return `Basic ${btoa(`${env.GORGIAS_CLIENT_ID}:${env.GORGIAS_CLIENT_SECRET}`)}`;
}

async function oauthPost(
  env: Env,
  subdomain: string,
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const res = await fetch(`https://${subdomain}.gorgias.com${path}`, {
    method: 'POST',
    headers: {
      authorization: clientAuth(env),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new OAuthError(res.status, String(body?.error || 'request_failed'));
  }
  return body;
}

export async function exchangeCode(
  env: Env,
  subdomain: string,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const token = await oauthPost(env, subdomain, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  if (!token?.access_token || !token?.refresh_token) {
    throw new OAuthError(502, 'incomplete_token_response');
  }
  return token;
}

export async function refreshAccessToken(
  env: Env,
  subdomain: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const token = await oauthPost(env, subdomain, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (!token?.access_token) throw new OAuthError(502, 'incomplete_token_response');
  return token;
}

export async function revokeToken(
  env: Env,
  subdomain: string,
  refreshToken: string,
): Promise<void> {
  await oauthPost(env, subdomain, '/oauth/revoke', { token: refreshToken });
}

// Gorgias documents a 24-hour access token but its examples return
// expires_in: 0, so prefer the token's own exp claim when it's a JWT.
export function tokenExpiresAt(token: TokenResponse, now = Date.now()): string {
  try {
    const claims = JSON.parse(fromBase64url(token.access_token.split('.')[1]));
    if (typeof claims?.exp === 'number' && claims.exp * 1000 > now) {
      return new Date(claims.exp * 1000).toISOString();
    }
  } catch {
    // not a JWT
  }
  const seconds =
    token.expires_in && token.expires_in > 0 ? token.expires_in : 24 * 60 * 60;
  return new Date(now + seconds * 1000).toISOString();
}

// Best effort: removes what the app created in Gorgias before access is revoked.
export async function deleteResource(
  subdomain: string,
  accessToken: string,
  path: string,
): Promise<void> {
  const res = await fetch(`https://${subdomain}.gorgias.com${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    console.error(`Gorgias DELETE ${path} returned ${res.status}`);
  }
}
