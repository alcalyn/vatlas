import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The requester is checked at startup: without a valid one every VIES answer is unprovable and
 * lookups answer 503.
 *
 * The module is imported again per case because `config` is parsed once at import.
 */
async function loadConfig() {
  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('VIES_REQUESTER_VAT', () => {
  it('refuses to boot with VIES enabled and no requester, and names the variable', async () => {
    // Empty rather than deleted: dotenv would restore a deleted key from the file.
    vi.stubEnv('VIES_ENABLED', 'true');
    vi.stubEnv('VIES_REQUESTER_VAT', '');

    await expect(loadConfig()).rejects.toThrow(/VIES_REQUESTER_VAT: is required when VIES_ENABLED=true/);
  });

  it('refuses a requester that is not a valid VAT number', async () => {
    // Rejected here rather than by a slow INVALID_REQUESTER_INFO from VIES.
    vi.stubEnv('VIES_ENABLED', 'true');
    vi.stubEnv('VIES_REQUESTER_VAT', 'FR123');

    await expect(loadConfig()).rejects.toThrow(/VIES_REQUESTER_VAT: is not a valid VAT number/);
  });

  it('asks for nothing when VIES is switched off, since no call will be made', async () => {
    vi.stubEnv('VIES_ENABLED', 'false');
    vi.stubEnv('VIES_REQUESTER_VAT', '');

    const { config } = await loadConfig();

    expect(config.vies.requester).toBeUndefined();
  });

  it('hands it on already split, in the shape the SOAP call names its two fields', async () => {
    vi.stubEnv('VIES_ENABLED', 'true');
    vi.stubEnv('VIES_REQUESTER_VAT', 'fr 95 884 831 538');

    const { config } = await loadConfig();

    // Normalized on the way in, which also keeps the raw XML interpolation safe.
    expect(config.vies.requester).toEqual({ countryCode: 'FR', vatNumber: '95884831538' });
  });
});
