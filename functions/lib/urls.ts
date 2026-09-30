// Route functions are served by the Swell gateway on the store's swell.store
// host, never on store.url (a headless storefront's own domain). Callers must
// send the app public key in the Authorization header; the gateway uses it to
// resolve the installed app and the environment (test or live).

export function functionsBaseUrl(store: {
  id?: string;
  admin_url?: string;
}): string {
  if (store.admin_url) {
    try {
      return new URL(store.admin_url).origin;
    } catch {
      // fall through to the store id
    }
  }
  return store.id ? `https://${store.id}.swell.store` : '';
}

export function functionUrl(
  store: { id?: string; admin_url?: string },
  appId: string,
  name: string,
): string {
  return `${functionsBaseUrl(store)}/functions/${appId}/${name}`;
}
