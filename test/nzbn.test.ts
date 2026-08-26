import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceTrace } from '../src/api/trace.js';
import { parseVatNumber } from '../src/vat/parse.js';

/**
 * How the NZBN gateway says "no such number": a 400 with a sentence, the same status as a refused
 * request. Only valid thirteen-digit numbers reach the gateway, so most 400s are this one.
 */
const NOT_FOUND = JSON.stringify({
  status: '400',
  errorDescription: 'Could not find NZBN Number',
  errorCode: 'error.invalid.request',
  list: [],
});

const REFUSED = JSON.stringify({
  statusCode: 401,
  message: 'Access denied due to invalid subscription key.',
});

const callLog: Record<string, unknown>[] = [];

vi.mock('../src/db/prisma.js', () => ({
  getPrisma: () => ({
    sourceCallLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        callLog.push(data);
      },
    },
  }),
}));

function stubFetch(reply: () => Response): { calls: number } {
  const counter = { calls: 0 };
  vi.stubGlobal('fetch', async () => {
    counter.calls += 1;
    return reply();
  });
  return counter;
}

async function ask(vatNumber = 'NZ9429034042984') {
  const { nzbn } = await import('../src/api/sources/live/nz-nzbn.js');
  return nzbn.fetch(parseVatNumber(vatNumber), {
    deadline: Date.now() + 20_000,
    trace: new SourceTrace(),
  });
}

describe('the NZBN gateway, which has no 404', () => {
  beforeEach(() => {
    callLog.length = 0;
    vi.resetModules();
    vi.stubEnv('NZBN_API_KEY', 'test-subscription-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reads a 400 that says the number is unknown as a miss', async () => {
    const counter = stubFetch(() => new Response(NOT_FOUND, { status: 400 }));

    await expect(ask()).resolves.toEqual({ status: 'not-found' });
    // A refusal is never retried.
    expect(counter.calls).toBe(1);
  });

  it('keeps a refused key an outage rather than turning it into a miss', async () => {
    stubFetch(() => new Response(REFUSED, { status: 401 }));

    await expect(ask()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('keeps any other 400 an outage too', async () => {
    const refusedRequest = JSON.stringify({
      status: '400',
      errorDescription: 'One or more values not recognized',
      errorCode: 'error.invalid.request',
    });
    stubFetch(() => new Response(refusedRequest, { status: 400 }));

    await expect(ask()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('maps the entity when the gateway has one', async () => {
    const entity = JSON.stringify({
      nzbn: '9429034042984',
      entityName: 'XERO LIMITED',
      entityStatusCode: '50',
      entityTypeDescription: 'NZ Limited Company',
      addresses: {
        addressList: [
          {
            addressType: 'REGISTERED',
            address1: '19-23 Taranaki St, Te Aro',
            address3: 'Wellington',
            postCode: '6011',
            countryCode: 'NZ',
            endDate: null,
          },
        ],
      },
    });
    stubFetch(() => new Response(entity, { status: 200 }));

    await expect(ask()).resolves.toMatchObject({
      status: 'found',
      record: { vatNumber: 'NZ9429034042984', name: 'XERO LIMITED', city: 'Wellington' },
    });
  });

  it('answers unavailable, and calls nothing, without a key', async () => {
    vi.stubEnv('NZBN_API_KEY', '');
    const counter = stubFetch(() => new Response(NOT_FOUND, { status: 400 }));

    await expect(ask()).resolves.toMatchObject({
      status: 'unavailable',
      failure: { fault: 'SOURCE_NOT_CONFIGURED' },
    });
    expect(counter.calls).toBe(0);
  });
});
