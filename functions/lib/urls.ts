// Public function invocation on hosted Swell requires the app's public key in
// the Authorization header; the gateway uses it to resolve the environment and
// the installed app.

export function functionsBaseUrl(store: {
  url?: string;
  admin_url?: string;
}): string {
  const base = store.url || (store.admin_url || '').replace(/\/admin.*$/, '');
  return base.replace(/\/$/, '');
}

export function functionUrl(
  store: { url?: string; admin_url?: string },
  appId: string,
  name: string,
): string {
  return `${functionsBaseUrl(store)}/functions/${appId}/${name}`;
}
