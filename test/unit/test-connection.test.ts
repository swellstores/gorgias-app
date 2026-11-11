import { describe, it, expect, afterEach, vi } from 'vitest';
import testConnection from '../../functions/test-connection';
import { BASIC_AUTH, CONNECTION, createAppRequest, createFakeSwell, mockFetch } from '../helpers/fakes';

function run(connection: SwellData) {
  const { swell } = createFakeSwell({ settings: { connection } });
  return testConnection(createAppRequest({ swell }));
}

describe('test-connection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the helpdesk it reached', async () => {
    const { calls } = mockFetch();
    await expect(run(CONNECTION)).resolves.toEqual({ message: 'Connected to Gorgias acme.gorgias.com.' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://acme.gorgias.com/api/account');
    expect(calls[0].headers.Authorization).toBe(BASIC_AUTH);
  });

  it('asks for missing settings without calling Gorgias', async () => {
    const { calls } = mockFetch();
    await expect(run({ subdomain: 'acme' })).rejects.toMatchObject({
      status: 400,
      message: 'Add the agent email and API key and save the settings first.',
    });
    expect(calls).toHaveLength(0);
  });

  it('tells an unknown subdomain apart from rejected credentials', async () => {
    mockFetch(() => new Response('<h1>Not Found</h1>', { status: 404 }));
    await expect(run(CONNECTION)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('no helpdesk at acme.gorgias.com'),
    });

    mockFetch(() => new Response('{"error": {"msg": "Unauthorized."}}', { status: 401 }));
    await expect(run(CONNECTION)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("didn't accept the agent email or API key"),
    });
  });

  it('says when Gorgias cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await expect(run(CONNECTION)).rejects.toMatchObject({
      status: 400,
      message: "Couldn't reach Gorgias. Try again in a minute.",
    });
  });
});
