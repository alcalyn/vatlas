export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /**
   * Epoch milliseconds after which no attempt is made. Without it a national register could spend
   * three full timeouts on top of the VIES retries. Importers pass nothing and keep all retries.
   */
  deadline?: number;
}

export interface PostXmlOptions extends FetchJsonOptions {
  /** The `SOAPAction` header, required by WCF services. */
  soapAction: string;
}

/**
 * Shared by both loops: the timeout for the next attempt, or null when the deadline leaves no room.
 * Stops before waiting, since a backoff past the budget is wasted.
 */
function attemptBudget(deadline: number | undefined, timeoutMs: number, backoff: number): number | null {
  if (deadline === undefined) return timeoutMs;
  if (Date.now() + backoff >= deadline) return null;
  return Math.min(timeoutMs, Math.max(1, deadline - Date.now() - backoff));
}

/**
 * A refusal that would happen again: 4xx except 408 and 429. Retrying only repeats it, and behind a
 * bot filter (Costa Rica's Akamai) makes the next call more likely to be refused.
 */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** The body of a refused response, for the error. Read errors are ignored. */
async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return '';
  }
}

/** The GET loop. `emptyAsNull` decides what an empty 200 body means. */
async function getJson<T>(url: string, options: FetchJsonOptions, emptyAsNull: boolean): Promise<T | null> {
  const { timeoutMs = 30_000, retries = 3, headers = {}, deadline } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const backoff = attempt > 0 ? 2 ** (attempt - 1) * 500 : 0;
    const budget = attemptBudget(deadline, timeoutMs, backoff);
    if (budget === null) break;
    if (backoff > 0) await delay(backoff);

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(budget),
      });

      if (response.status === 404) {
        throw new HttpNotFoundError(url);
      }
      if (!response.ok) {
        const failure = new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
        if (isPermanent(response.status)) {
          throw new HttpPermanentError(failure.message, response.status, await readBody(response));
        }
        throw failure;
      }
      const body = await response.text();
      if (body.trim().length === 0) {
        if (emptyAsNull) return null;
        throw new Error(`GET ${url} returned an empty body`);
      }
      return JSON.parse(body) as T;
    } catch (error) {
      if (error instanceof HttpNotFoundError || error instanceof HttpPermanentError) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`GET ${url} failed`);
}

/** GET a JSON document, with timeout and exponential backoff on transient failures. */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  return (await getJson<T>(url, options, false)) as T;
}

/**
 * Same, for registers that answer "nothing here" with an empty 200 instead of a 404 (Taiwan's GCIS).
 * Otherwise the miss would be a parse failure, retried and reported as an outage.
 */
export async function fetchJsonOrNull<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  return getJson<T>(url, options, true);
}

/**
 * POST JSON and read JSON back, with the same timeout and backoff. Some registers (ANAF, AADE) only
 * offer POST.
 */
export async function postJson<T>(url: string, body: unknown, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, retries = 3, headers = {}, deadline } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const backoff = attempt > 0 ? 2 ** (attempt - 1) * 500 : 0;
    const budget = attemptBudget(deadline, timeoutMs, backoff);
    if (budget === null) break;
    if (backoff > 0) await delay(backoff);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budget),
      });

      if (response.status === 404) {
        throw new HttpNotFoundError(url);
      }
      if (!response.ok) {
        const failure = new Error(`POST ${url} failed: HTTP ${response.status} ${response.statusText}`);
        if (isPermanent(response.status)) {
          throw new HttpPermanentError(failure.message, response.status, await readBody(response));
        }
        throw failure;
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof HttpNotFoundError || error instanceof HttpPermanentError) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`POST ${url} failed`);
}

/**
 * A 4xx refusing the request, raised without retrying.
 *
 * Carries the status and body: the NZBN gateway says "no such number" with a 400 and a sentence,
 * which must be told apart from a refused key.
 */
export class HttpPermanentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpPermanentError';
  }
}

export class HttpNotFoundError extends Error {
  constructor(url: string) {
    super(`GET ${url} returned 404`);
    this.name = 'HttpNotFoundError';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a SOAP envelope and read the raw XML back, with the same timeout, backoff and deadline.
 *
 * The body is returned as text: SOAP sources read a few fields with `extractTag`. A SOAP fault is
 * an HTTP 500 with an envelope, so 500 is returned rather than retried: it tells "the register said
 * no" from "the register is down".
 */
export async function postXml(url: string, envelope: string, options: PostXmlOptions): Promise<string> {
  const { timeoutMs = 30_000, retries = 2, headers = {}, deadline, soapAction } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const backoff = attempt > 0 ? 2 ** (attempt - 1) * 500 : 0;
    const budget = attemptBudget(deadline, timeoutMs, backoff);
    if (budget === null) break;
    if (backoff > 0) await delay(backoff);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'text/xml',
          'content-type': 'text/xml; charset=utf-8',
          soapaction: soapAction,
          ...headers,
        },
        body: envelope,
        signal: AbortSignal.timeout(budget),
      });

      if (response.status === 500) return await response.text();
      if (!response.ok) {
        const failure = new Error(`POST ${url} failed: HTTP ${response.status} ${response.statusText}`);
        if (isPermanent(response.status)) {
          throw new HttpPermanentError(failure.message, response.status, await readBody(response));
        }
        throw failure;
      }
      return await response.text();
    } catch (error) {
      if (error instanceof HttpPermanentError) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`POST ${url} failed`);
}
