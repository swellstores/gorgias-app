import { GorgiasClient, GorgiasError, connectionFromSettings } from './lib/gorgias';

export const config: SwellConfig = {
  description: 'Check the Gorgias subdomain, agent email and API key',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  const conn = settings?.connection || {};
  const missing = [
    !String(conn.subdomain || '').trim() && 'Gorgias subdomain',
    !String(conn.email || '').trim() && 'agent email',
    !String(conn.api_key || '').trim() && 'API key',
  ].filter(Boolean);
  if (missing.length) {
    const last = missing.pop();
    fail(`Add the ${missing.length ? `${missing.join(', ')} and ` : ''}${last} and save the settings first.`);
  }

  const connection = connectionFromSettings(settings);
  if (!connection) {
    fail('The Gorgias subdomain should be just the "acme" in acme.gorgias.com.');
  }

  const helpdesk = `${connection.subdomain}.gorgias.com`;
  try {
    await new GorgiasClient(connection).checkAuth();
  } catch (err) {
    if (err instanceof GorgiasError) {
      if (err.status === 404) {
        fail(`Gorgias has no helpdesk at ${helpdesk}. Check the subdomain.`);
      }
      if (err.status === 401 || err.status === 403) {
        fail(
          `Gorgias didn't accept the agent email or API key for ${helpdesk}. Check that the API key belongs to that agent.`,
        );
      }
      fail(`Gorgias returned an error (${err.status}). Try again in a minute.`);
    }
    fail("Couldn't reach Gorgias. Try again in a minute.");
  }

  return { message: `Connected to Gorgias ${helpdesk}.` };
}
