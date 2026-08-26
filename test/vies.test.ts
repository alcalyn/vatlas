import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indentXml } from '../src/lib/xml.js';
import {
  ViesSource,
  flushSourceCalls,
  parseCheckVatResponse,
  resetMemberStateCooldowns,
} from '../src/api/sources/live/europe-vies.js';
import { SourceTrace } from '../src/api/trace.js';
import { parseVatNumber } from '../src/vat/parse.js';

const answer = (valid: string, name = 'SARL JULIEN MAULNY EURL', address = '9 RUE DES COLONNES 75002 PARIS') => `
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:checkVatResponse xmlns:ns2="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
      <ns2:countryCode>FR</ns2:countryCode>
      <ns2:vatNumber>95884831538</ns2:vatNumber>
      <ns2:requestDate>2026-08-26+02:00</ns2:requestDate>
      <ns2:valid>${valid}</ns2:valid>
      <ns2:name>${name}</ns2:name>
      <ns2:address>${address}</ns2:address>
    </ns2:checkVatResponse>
  </soap:Body>
</soap:Envelope>`;

const fault = (faultstring: string) => `
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Header/>
  <env:Body>
    <env:Fault><faultcode>env:Server</faultcode><faultstring>${faultstring}</faultstring></env:Fault>
  </env:Body>
</env:Envelope>`;

describe('parseCheckVatResponse', () => {
  it('reads a positive answer', () => {
    expect(parseCheckVatResponse(answer('true'))).toEqual({
      kind: 'answer',
      valid: true,
      name: 'SARL JULIEN MAULNY EURL',
      address: '9 RUE DES COLONNES 75002 PARIS',
      viesConsultationNumber: null,
    });
  });

  it('reads a negative answer', () => {
    expect(parseCheckVatResponse(answer('false', '---', '---'))).toEqual({
      kind: 'answer',
      valid: false,
      name: null,
      address: null,
      viesConsultationNumber: null,
    });
  });

  it('keeps the address layout, trimming only the ends of each line', () => {
    // Line breaks and runs of spaces are separators for parseAddress, so inner spacing must survive.
    // Only the ends are trimmed.
    const parsed = parseCheckVatResponse(answer('true', 'ACME', 'LINE   ONE  \n   LINE TWO\n'));
    expect(parsed).toMatchObject({ address: 'LINE   ONE\nLINE TWO' });
  });

  it('collapses the name, which has no layout to preserve', () => {
    expect(parseCheckVatResponse(answer('true', 'ACME   LIMITED'))).toMatchObject({
      name: 'ACME LIMITED',
    });
  });

  // VIES answers faults with HTTP 200, so a fault must never be read as `valid: false`.
  it.each([
    'MS_MAX_CONCURRENT_REQ',
    'GLOBAL_MAX_CONCURRENT_REQ',
    'MS_UNAVAILABLE',
    'SERVICE_UNAVAILABLE',
    'INVALID_INPUT',
  ])('reports %s as a fault, never as a negative answer', (faultstring) => {
    expect(parseCheckVatResponse(fault(faultstring))).toEqual({ kind: 'fault', fault: faultstring });
  });

  it('refuses to guess when the body carries neither an answer nor a fault', () => {
    expect(parseCheckVatResponse('<html>gateway error</html>')).toEqual({
      kind: 'fault',
      fault: 'MALFORMED_RESPONSE',
    });
  });
});

// checkVatApprox names the caller. It returns the trader details under different element names,
// plus the consultation number, the proof that the check happened.
//
// The identifier is a UUID, captured from a real answer.
const approx = `
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:checkVatApproxResponse xmlns:ns2="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
      <ns2:countryCode>IT</ns2:countryCode>
      <ns2:vatNumber>00743110157</ns2:vatNumber>
      <ns2:requestDate>2026-08-31+02:00</ns2:requestDate>
      <ns2:valid>true</ns2:valid>
      <ns2:traderName>MOTOROLA SOLUTIONS ITALIA SRL</ns2:traderName>
      <ns2:traderAddress>LARGO FRANCESCO RICHINI 6\n20122 MILANO MI</ns2:traderAddress>
      <ns2:requestIdentifier>908a3b38-e0dc-4502-8b06-d057eeac6861</ns2:requestIdentifier>
    </ns2:checkVatApproxResponse>
  </soap:Body>
</soap:Envelope>`;

describe('parseCheckVatResponse, checkVatApprox', () => {
  it('reads the trader fields and the consultation number', () => {
    expect(parseCheckVatResponse(approx)).toEqual({
      kind: 'answer',
      valid: true,
      name: 'MOTOROLA SOLUTIONS ITALIA SRL',
      address: 'LARGO FRANCESCO RICHINI 6\n20122 MILANO MI',
      viesConsultationNumber: '908a3b38-e0dc-4502-8b06-d057eeac6861',
    });
  });

  // An unknown requester is a fault, not an answer without identifier.
  it('reports an invalid requester as a fault', () => {
    expect(parseCheckVatResponse(fault('INVALID_REQUESTER_INFO'))).toEqual({
      kind: 'fault',
      fault: 'INVALID_REQUESTER_INFO',
    });
  });
});

describe('indentXml', () => {
  it('lays out the envelope VIES sends on a single line', () => {
    const flat =
      '<?xml version="1.0"?><env:Envelope><env:Body><ns2:valid>true</ns2:valid>' +
      '<ns2:name>ACME</ns2:name></env:Body></env:Envelope>';

    expect(indentXml(flat)).toBe(
      [
        '<?xml version="1.0"?>',
        '<env:Envelope>',
        '  <env:Body>',
        '    <ns2:valid>true</ns2:valid>',
        '    <ns2:name>ACME</ns2:name>',
        '  </env:Body>',
        '</env:Envelope>',
      ].join('\n'),
    );
  });

  it('leaves text alone, so an address keeps the layout it is parsed on', () => {
    expect(indentXml('<a><b>LINE   ONE\nLINE TWO</b></a>')).toBe('<a>\n  <b>LINE   ONE\nLINE TWO</b>\n</a>');
  });

  it('does not nest on a self-closing tag', () => {
    expect(indentXml('<a><b/><c/></a>')).toBe('<a>\n  <b/>\n  <c/>\n</a>');
  });

  it('prints a fault that is not XML at all unchanged', () => {
    expect(indentXml('gateway timeout')).toBe('gateway timeout');
  });
});

describe('XML entities', () => {
  it('decodes the entities VIES escapes in company names', () => {
    // Sweden returns "H &amp; M Hennes &amp; Mauritz AB". The ampersands must come back.
    expect(parseCheckVatResponse(answer('true', 'H &amp; M Hennes &amp; Mauritz AB'))).toMatchObject({
      name: 'H & M Hennes & Mauritz AB',
    });
  });

  it('decodes numeric entities too', () => {
    expect(parseCheckVatResponse(answer('true', 'CAF&#201; &#x26; CO'))).toMatchObject({
      name: 'CAFÉ & CO',
    });
  });

  it('leaves an unknown entity untouched rather than mangling it', () => {
    expect(parseCheckVatResponse(answer('true', 'A &nope; B'))).toMatchObject({ name: 'A &nope; B' });
  });
});

/**
 * `ViesSource` itself: the retry ladder, the member state circuit breaker, and the
 * `log_source_call` row for each attempt.
 *
 * Freshness of stored answers is handled by the country adapter, tested in `lookup.test.ts`.
 */

/** Every row written to `log_source_call`, in order. */
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

const soapFault = (faultstring: string) =>
  new Response(fault(faultstring), { status: 200, headers: { 'content-type': 'text/xml' } });

function stubFetch(reply: () => Response | Promise<Response>): { calls: number } {
  const counter = { calls: 0 };
  vi.stubGlobal('fetch', async () => {
    counter.calls += 1;
    return reply();
  });
  return counter;
}

/** The source under test, with the retry settings of the case. */
function source(policy: { maxRetries?: number; timeoutMs?: number } = {}): ViesSource {
  return new ViesSource(policy);
}

function ask(vies: ViesSource, vatNumber: string, deadline = Date.now() + 20_000): ReturnType<ViesSource['fetch']> {
  return vies.fetch(parseVatNumber(vatNumber), { deadline, trace: new SourceTrace() });
}

describe('the member state circuit breaker', () => {
  beforeEach(() => {
    callLog.length = 0;
    resetMemberStateCooldowns();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stops calling a member state that has just said it is unavailable', async () => {
    const counter = stubFetch(() => soapFault('MS_UNAVAILABLE'));
    const vies = source();

    await ask(vies, 'IE3602284DH', Date.now() + 50);
    const afterFirst = counter.calls;
    await ask(vies, 'IE9590828H', Date.now() + 50);

    expect(afterFirst).toBeGreaterThan(0);
    // The second number costs nothing.
    expect(counter.calls).toBe(afterFirst);
  });

  it('keeps the fault name on the answers it short-circuits', async () => {
    stubFetch(() => soapFault('MS_UNAVAILABLE'));
    const vies = source();

    await ask(vies, 'IE3602284DH', Date.now() + 50);
    const answer = await ask(vies, 'IE9590828H', Date.now() + 50);

    expect(answer).toMatchObject({ status: 'unavailable', failure: { fault: 'MS_UNAVAILABLE', attempts: 0 } });
  });

  it('is shared between instances, an outage being a fact about the member state', async () => {
    // Denmark and Bulgaria have their own `ViesSource` instances. A member state that is down is down
    // for all of them.
    const counter = stubFetch(() => soapFault('MS_UNAVAILABLE'));

    await ask(source(), 'IE3602284DH', Date.now() + 50);
    const afterFirst = counter.calls;
    await ask(source({ maxRetries: 0 }), 'IE9590828H', Date.now() + 50);

    expect(counter.calls).toBe(afterFirst);
  });

  it('does not skip a country because one number was rejected', async () => {
    // INVALID_INPUT is about the number: it must not open the circuit for the whole member state.
    const counter = stubFetch(() => soapFault('INVALID_INPUT'));
    const vies = source();

    await ask(vies, 'IE3602284DH', Date.now() + 50);
    const afterFirst = counter.calls;
    await ask(vies, 'IE9590828H', Date.now() + 50);

    expect(counter.calls).toBeGreaterThan(afterFirst);
  });

  it('reopens the country as soon as it answers again', async () => {
    stubFetch(() => soapFault('MS_UNAVAILABLE'));
    await ask(source(), 'IE3602284DH', Date.now() + 50);

    const counter = stubFetch(async () => new Response(answer('true'), { status: 200 }));
    resetMemberStateCooldowns();
    await ask(source(), 'IE3602284DH');
    await ask(source(), 'IE9590828H');

    expect(counter.calls).toBe(2);
  });

  it('opens on a member state that never answers at all', async () => {
    // A member state that times out sends no fault, so NO_RESPONSE must open the circuit too.
    const counter = stubFetch(() => {
      throw new Error('The operation was aborted due to timeout');
    });
    const vies = source({ maxRetries: 0 });

    await ask(vies, 'DK29979812', Date.now() + 1_000);
    const afterFirst = counter.calls;
    const second = await ask(vies, 'DK41853816', Date.now() + 1_000);

    expect(afterFirst).toBe(1);
    expect(counter.calls).toBe(afterFirst);
    expect(second).toMatchObject({ status: 'unavailable', failure: { fault: 'NO_RESPONSE', attempts: 0 } });
  });
});

describe('the retry ladder', () => {
  beforeEach(() => {
    callLog.length = 0;
    resetMemberStateCooldowns();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('gives up on a transient fault rather than overrunning the deadline', async () => {
    // GLOBAL_MAX_CONCURRENT_REQ is transient: without a budget this would run the full ladder (four
    // calls, six seconds).
    const counter = stubFetch(() => soapFault('GLOBAL_MAX_CONCURRENT_REQ'));

    const started = Date.now();
    await ask(source(), 'FR95884831538', Date.now() + 50);

    expect(counter.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still retries a transient fault while the budget allows it', async () => {
    const counter = stubFetch(() => soapFault('SERVER_BUSY'));

    await ask(source(), 'FR95884831538', Date.now() + 1_000);

    // One retry fits in the budget, the second backoff does not.
    expect(counter.calls).toBe(2);
  });

  it('asks once when the country says once, however transient the fault', async () => {
    // Denmark's setting: SERVER_BUSY is transient, but retrying a member state that rarely answers only
    // costs time.
    const counter = stubFetch(() => soapFault('SERVER_BUSY'));

    await ask(source({ maxRetries: 0 }), 'DK29979812', Date.now() + 10_000);

    expect(counter.calls).toBe(1);
  });

  it('reports the attempts the country actually authorised, not the default ladder', async () => {
    // `log_lookup.attempts` must reflect the allowed attempts.
    stubFetch(() => {
      throw new Error('socket hang up');
    });

    const answer = await ask(source({ maxRetries: 0 }), 'DK29979812', Date.now() + 10_000);

    expect(answer).toMatchObject({ status: 'unavailable', failure: { fault: 'NO_RESPONSE', attempts: 1 } });
  });

  it('caps one attempt at the timeout the country asked for, not VIES_TIMEOUT_MS', async () => {
    // A member state that never replies. VIES_TIMEOUT_MS is ten seconds, so only the country's ceiling
    // can end this in a tenth of a second.
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const started = Date.now();
    const answer = await ask(source({ maxRetries: 0, timeoutMs: 100 }), 'BG000670602');
    const elapsed = Date.now() - started;

    expect(answer.status).toBe('unavailable');
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('never lets that timeout outlive the lookup deadline', async () => {
    const counter = stubFetch(() => soapFault('MS_MAX_CONCURRENT_REQ'));

    // 5 s per attempt, 50 ms of budget: the budget stops the ladder.
    const started = Date.now();
    await ask(source({ maxRetries: 1, timeoutMs: 5_000 }), 'BG000670602', Date.now() + 50);

    expect(counter.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('what a VIES answer becomes', () => {
  beforeEach(() => {
    callLog.length = 0;
    resetMemberStateCooldowns();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps a positive answer to a company record, address split out of the one line', async () => {
    stubFetch(async () => new Response(answer('true'), { status: 200 }));

    const result = await ask(source(), 'FR95884831538');

    expect(result).toMatchObject({
      status: 'found',
      record: { vatNumber: 'FR95884831538', name: 'SARL JULIEN MAULNY EURL', status: 'active' },
    });
  });

  it('reports a negative answer as not-registered rather than as a miss', async () => {
    // VIES answered correctly. A miss would mean the number was never checked.
    stubFetch(async () => new Response(answer('false', '---', '---'), { status: 200 }));

    expect(await ask(source(), 'FR95884831538')).toMatchObject({ status: 'not-registered' });
  });

  it('never turns a missing consultation number into a failure', async () => {
    // VIES issues no identifier for an unregistered number, so this must not be treated as an outage.
    stubFetch(async () => new Response(answer('false', '---', '---'), { status: 200 }));

    const result = await ask(source(), 'FR95884831538');

    expect(result.status).toBe('not-registered');
    if (result.status !== 'not-registered') return;
    expect(result.proof).toBeUndefined();
  });
});

describe('the source call log', () => {
  beforeEach(() => {
    callLog.length = 0;
    resetMemberStateCooldowns();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('writes one row per attempt, not one per lookup', async () => {
    stubFetch(() => soapFault('MS_MAX_CONCURRENT_REQ'));

    await ask(source({ maxRetries: 2 }), 'BG000670602', Date.now() + 5_000);
    await flushSourceCalls();

    expect(callLog).toHaveLength(3);
    expect(callLog.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(callLog.every((row) => row.outcome === 'fault' && row.error === true)).toBe(true);
    expect(callLog[0]).toMatchObject({
      source: 'VIES',
      vatNumber: 'BG000670602',
      fault: 'MS_MAX_CONCURRENT_REQ',
    });
  });

  it('records a number VIES has never heard of as an answer, not as an error', async () => {
    stubFetch(async () => new Response(answer('false', '---', '---'), { status: 200 }));

    await ask(source(), 'FR95884831538');
    await flushSourceCalls();

    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toMatchObject({
      outcome: 'not-registered',
      error: false,
      httpStatus: 200,
      hasName: false,
      hasAddress: false,
      hasProof: false,
    });
  });

  it('measures the completeness of a positive answer', async () => {
    stubFetch(async () => new Response(answer('true'), { status: 200 }));

    await ask(source(), 'FR95884831538');
    await flushSourceCalls();

    expect(callLog[0]).toMatchObject({
      source: 'VIES',
      outcome: 'valid',
      error: false,
      hasName: true,
      hasAddress: true,
      hasProof: false,
    });
    expect(callLog[0]!.calledAt).toBeInstanceOf(Date);
    expect(callLog[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tells a timeout from a refused connection, since nothing comes back from either', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            reject(error);
          });
        }),
    );

    await ask(source({ maxRetries: 0, timeoutMs: 50 }), 'BG000670602');
    await flushSourceCalls();

    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toMatchObject({ outcome: 'timeout', error: true, httpStatus: null });

    callLog.length = 0;
    resetMemberStateCooldowns();
    stubFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });

    await ask(source({ maxRetries: 0 }), 'BG000670602');
    await flushSourceCalls();

    expect(callLog[0]).toMatchObject({ outcome: 'network-error', error: true });
  });
});
