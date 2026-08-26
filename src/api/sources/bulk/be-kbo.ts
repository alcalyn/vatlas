import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../../../config.js';
import { downloadFile, type DownloadResult } from '../../../lib/download.js';
import { readColumn, streamCsv, type CsvRow } from '../../../lib/csv.js';
import { parseUtcDate } from '../../../lib/time.js';
import { openZipEntry } from '../../../lib/zip.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, EditionUnavailableError, type BulkArtefact, type Counters, type ImportContext } from '../types.js';

/**
 * KBO / BCE open data, the Crossroads Bank for Enterprises. The Belgian VAT number is `BE` + the
 * enterprise number, so all ~1.9 M entities are reachable directly.
 *
 * Access needs a free account:
 *
 * - It is a Spring Security form login, not HTTP Basic, and a language must be chosen first. An
 *   `Authorization` header gets a 302 to the login page, which a naive downloader would save as
 *   the zip. Hence the cookie jar and the ZIP magic bytes check.
 *
 *   The session also expires during long runs (31 editions take about eleven hours and 10 GB):
 *   the portal then answers downloads with its login page, as HTTP 200. `run` reconnects and asks
 *   for the same edition again.
 * - The full file is published daily and kept 31 days. Its name has a sequence number
 *   (`KboOpenData_0463_2026_08_26_Full.zip`), so it is read from the list at
 *   `/affiliation/xml/?files`.
 *
 * Without `KBO_USER` / `KBO_PASSWORD`, Belgian numbers go to VIES.
 * The same files are available over SFTP on request to kbo-bce-webservice@economie.fgov.be.
 */
const PORTAL = 'https://kbopub.economie.fgov.be/kbo-open-data';
const LOGIN_URL = `${PORTAL}/static/j_spring_security_check`;

/**
 * Minimum wait between two downloads, and before retrying a refused one. Small next to an edition
 * (312 MB, about ten minutes), but it paces long history runs.
 */
const EDITION_PAUSE_MS = 30_000;
const RETRY_PAUSE_MS = 60_000;

export const SOURCE = 'KBO';

/**
 * The name `--file <slot>=<path>` takes for Belgium.
 *
 * Download slots are named after the edition (`be_kbo_KboOpenData_0451_2026_08_14_Full.zip`), so
 * this alias means "the full extract to read". The artefact is recorded under the file's own name.
 */
const LOCAL_SLOT = 'be_kbo_full';

/** True when an account is configured. */
function kboCredentials(): { user: string; password: string } | null {
  const { user, password } = config.sources.kbo;
  return user && password ? { user, password } : null;
}

/**
 * Preferred language, best first: French, Dutch, German, English.
 *
 * The file is inconsistent: `denomination.csv` writes the language as a digit (1 FR, 2 NL, 3 DE,
 * 4 EN, 0 undetermined), `code.csv` as letters. Both are ranked here, otherwise `code.csv` rows tie
 * and the first one listed (German, alphabetically) wins.
 *
 * Anything unknown, including the ~831k names under 0, ranks last but beats no name.
 */
const LANGUAGE_RANK: Record<string, number> = {
  '1': 0,
  FR: 0,
  '2': 1,
  NL: 1,
  '3': 2,
  DE: 2,
  '4': 3,
  EN: 3,
};
const UNRANKED = Object.keys(LANGUAGE_RANK).length;

export function languageRank(value: string | null): number {
  return LANGUAGE_RANK[(value ?? '').toUpperCase()] ?? UNRANKED;
}

/** A cookie jar: `fetch` keeps none and the portal needs six cookies over three requests. */
export class Session {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get size(): number {
    return this.cookies.size;
  }
}

/**
 * Signs in and returns the session.
 *
 * The login page is visited first because it sets a `locale` cookie, without which the portal
 * redirects to its language picker (`taalkeuze`) or answers 400. A successful login redirects away
 * from `/login` and a failed one back to it, so the target matters, not the 302.
 */
export async function login(user: string, password: string): Promise<Session> {
  const session = new Session();
  session.absorb(await fetch(`${PORTAL}/login?lang=fr`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }));

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.header },
    body: new URLSearchParams({ j_username: user, j_password: password }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  session.absorb(response);

  const location = response.headers.get('location') ?? '';
  if (location.includes('login')) {
    throw new Error('KBO login rejected: check KBO_USER and KBO_PASSWORD');
  }
  if (session.size === 0) throw new Error('KBO login returned no session cookie');
  return session;
}

/**
 * Picks the newest full extract from the portal's download page. Each day publishes a pair, kept
 * 31 days:
 *
 *     KboOpenData_0462_2026_08_25_Full.zip   KboOpenData_0462_2026_08_25_Update.zip
 *     KboOpenData_0463_2026_08_26_Full.zip   KboOpenData_0463_2026_08_26_Update.zip
 *
 * Only full extracts are used. Sorted on the embedded date, not on the sequence number.
 */
const FULL_FILE = /^KboOpenData_\d+_(\d{4})_(\d{2})_(\d{2})_Full\.zip$/i;

/** Every full extract listed, oldest first: the archive `--history` walks. */
export function listFullFiles(html: string): { name: string; date: Date }[] {
  const names = [...html.matchAll(/href="[^"]*?\/([^/"]+\.zip)"/gi)].map((match) => match[1] ?? '');

  return names
    .flatMap((name) => {
      const date = fullFileDate(name);
      return date ? [{ name, date }] : [];
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function pickFullFile(html: string): string | null {
  return listFullFiles(html).at(-1)?.name ?? null;
}

async function fetchFileList(session: Session): Promise<{ name: string; date: Date }[]> {
  // The trailing slash and `?files` are both required, otherwise the portal answers 400.
  const response = await fetch(`${PORTAL}/affiliation/xml/?files`, {
    headers: { cookie: session.header },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`KBO file list unavailable: HTTP ${response.status} ${response.statusText}`);
  }

  const files = listFullFiles(await response.text());
  if (files.length === 0) {
    throw new Error(
      'No KboOpenData_..._Full.zip found on the KBO download page: the session expired, or the ' +
        'page changed shape. Check the markup at /kbo-open-data/affiliation/xml/?files.',
    );
  }
  return files;
}

/** The extract's date, read from its name. */
export function fullFileDate(fileName: string): Date | null {
  const match = FULL_FILE.exec(fileName);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
}

/** `0200.065.765` in the file, `0200065765` in a VAT number. */
export function kboVatNumber(entityNumber: string | null): string | null {
  if (!entityNumber) return null;
  const digits = entityNumber.replace(/[^0-9]/g, '');
  // Establishment numbers start with 2 and have no VAT number.
  return /^[01][0-9]{9}$/.test(digits) ? digits : null;
}

/**
 * Maps one `enterprise.csv` row, with the names, labels and addresses gathered by earlier passes.
 *
 * The address is joined here, before writing, so each row is complete when stored.
 */
export function mapBelgianEnterprise(
  row: CsvRow,
  names: Map<string, string>,
  labels: Map<string, string>,
  addresses: Map<string, BelgianAddress>,
): CompanyRecord | null {
  const vatNumber = kboVatNumber(readColumn(row, ['EnterpriseNumber']));
  if (!vatNumber) return null;

  const juridicalForm = readColumn(row, ['JuridicalForm']);
  const status = readColumn(row, ['Status']);

  return {
    vatNumber: `BE${vatNumber}`,
    nationalId: vatNumber,
    name: names.get(vatNumber) ?? null,
    legalForm: juridicalForm ? (labels.get(`JuridicalForm:${juridicalForm}`) ?? juridicalForm) : null,
    // "AC" is the only active status.
    status: status === 'AC' ? 'active' : 'inactive',
    ...(addresses.get(vatNumber) ?? { addressLine1: null, addressLine2: null, postalCode: null, city: null }),
    addressCountry: 'BE',
    companyLastUpdatedAt: parseUtcDate(toIsoDate(readColumn(row, ['StartDate']))),
  };
}

/** The four address columns, keyed by VAT number. */
export type BelgianAddress = Pick<CompanyRecord, 'addressLine1' | 'addressLine2' | 'postalCode' | 'city'>;

/** Maps one `address.csv` row, returning the VAT number as join key. */
export function mapBelgianAddress(row: CsvRow): { vatNumber: string; address: BelgianAddress } | null {
  const vatNumber = kboVatNumber(readColumn(row, ['EntityNumber']));
  if (!vatNumber) return null;
  // "REGO" is the registered office. An entity may also have a mailing address.
  const type = readColumn(row, ['TypeOfAddress']);
  if (type && type !== 'REGO') return null;

  const street = readColumn(row, ['StreetFR', 'StreetNL', 'StreetDE']);
  const houseNumber = readColumn(row, ['HouseNumber']);
  const box = readColumn(row, ['Box']);
  const line1 = [street, houseNumber].filter(Boolean).join(' ').trim();

  return {
    vatNumber,
    address: {
      addressLine1: line1.length > 0 ? line1 : null,
      addressLine2: box ? `bte ${box}` : null,
      postalCode: readColumn(row, ['Zipcode']),
      city: readColumn(row, ['MunicipalityFR', 'MunicipalityNL', 'MunicipalityDE']),
    },
  };
}

/** Dates are `dd-mm-yyyy`. */
function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^([0-9]{2})-([0-9]{2})-([0-9]{4})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

/** Keeps the best-language name for each entity, in one pass. */
async function loadDenominations(path: string, logger: ImportContext['logger']): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const languageOf = new Map<string, number>();

  for await (const row of streamCsv(createReadStream(path), { delimiter: ',' })) {
    const vatNumber = kboVatNumber(readColumn(row, ['EntityNumber']));
    const denomination = readColumn(row, ['Denomination']);
    if (!vatNumber || !denomination) continue;

    // TypeOfDenomination 001 is the legal name, 002 an abbreviation, 003 a trading name.
    if (readColumn(row, ['TypeOfDenomination']) !== '001') continue;

    const score = languageRank(readColumn(row, ['Language']));
    if ((languageOf.get(vatNumber) ?? Number.MAX_SAFE_INTEGER) <= score) continue;

    names.set(vatNumber, denomination);
    languageOf.set(vatNumber, score);
  }

  logger.info({ denominations: names.size }, 'Belgium: denominations loaded');
  return names;
}

/** `code.csv` translates every code in the file. Only legal forms are needed. */
async function loadLabels(path: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const languageOf = new Map<string, number>();

  for await (const row of streamCsv(createReadStream(path), { delimiter: ',' })) {
    const category = readColumn(row, ['Category']);
    if (category !== 'JuridicalForm') continue;

    const code = readColumn(row, ['Code']);
    const description = readColumn(row, ['Description']);
    if (!code || !description) continue;

    const key = `${category}:${code}`;
    const score = languageRank(readColumn(row, ['Language']));
    if ((languageOf.get(key) ?? Number.MAX_SAFE_INTEGER) <= score) continue;

    labels.set(key, description);
    languageOf.set(key, score);
  }

  return labels;
}

/** Reads `address.csv` into a map keyed by VAT number. */
async function loadAddresses(path: string, logger: ImportContext['logger']): Promise<Map<string, BelgianAddress>> {
  const addresses = new Map<string, BelgianAddress>();

  for await (const row of streamCsv(createReadStream(path), { delimiter: ',' })) {
    const mapped = mapBelgianAddress(row);
    if (mapped) addresses.set(mapped.vatNumber, mapped.address);
  }

  logger.info({ addresses: addresses.size }, 'Belgium: addresses loaded');
  return addresses;
}

export class KboBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'KBO / BCE open data';
  readonly countryCode = 'BE';
  override readonly slots = [LOCAL_SLOT];

  override get available(): boolean {
    return kboCredentials() !== null;
  }

  protected override get unavailableReason(): string {
    return 'the KBO open data download requires a free account; set KBO_USER and KBO_PASSWORD to enable it';
  }

  /** Kept for one import, so a multi-edition run logs in once. */
  private session: Session | null = null;

  /** End of the last download, for the pause between editions. */
  private lastDownloadAt = 0;

  private async signIn(): Promise<Session> {
    const { user, password } = kboCredentials()!;
    this.session ??= await login(user, password);
    return this.session;
  }

  /** Drops the session and logs in again. */
  private async reconnect(): Promise<Session> {
    this.session = null;
    return this.signIn();
  }

  /** The 31 daily extracts the portal keeps. */
  protected override async editions(context: ImportContext): Promise<BulkArtefact[]> {
    const files = await fetchFileList(await this.signIn());
    context.logger.info({ available: files.length }, 'Belgium: full extracts on offer');

    return files.map((file) => ({
      url: `${PORTAL}/affiliation/xml/files/${file.name}`,
      fileName: file.name,
      date: file.date,
    }));
  }

  protected async run(context: ImportContext, counters: Counters, edition: BulkArtefact | null): Promise<void> {
    const local = context.options.localFiles?.get(LOCAL_SLOT);
    // A local file needs no portal: the operator gave the file and `--date`.
    const artefact = local
      ? this.artefactOf(context, LOCAL_SLOT, { url: '', fileName: basename(local), date: null })
      : // No sign-in of its own: both the edition list and the download ask for the session, and
        // Established once for the whole run.
        (edition ?? (await this.editions(context)).at(-1)!);
    context.logger.info({ fileName: artefact.fileName }, 'Belgium: full extract selected');

    const archive = local
      ? await this.download(context, artefact.url, LOCAL_SLOT)
      : await this.fetchEdition(artefact, context);
    // The file name carries its date, so it is authoritative and the HTTP header is a fallback.
    await context.useArtefact({
      url: artefact.url,
      fileName: artefact.fileName,
      date: this.published(artefact.date ?? archive.lastModified, context),
    });

    // `openZipEntry` streams one entry at a time and an enterprise is spread over four files, so each
    // pass is extracted separately.
    const labels = await loadLabels(await extract(archive.path, 'code.csv'));
    const names = await loadDenominations(await extract(archive.path, 'denomination.csv'), context.logger);
    const addresses = await loadAddresses(await extract(archive.path, 'address.csv'), context.logger);

    const batch = this.batch(context, counters);
    const enterprises = await openZipEntry(archive.path, (name) => name.endsWith('enterprise.csv'));
    for await (const row of streamCsv(enterprises, { delimiter: ',' })) {
      const record = mapBelgianEnterprise(row, names, labels, addresses);
      // Skip nameless rows.
      await batch.add(record?.name ? record : null);
      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Belgium: sample limit reached, stopping');
        break;
      }
    }
    await batch.flush();
  }

  /**
   * Downloads one edition, reconnecting once if the portal returns its login page.
   *
   * That page comes back as 6 KB of HTML with HTTP 200. It is deleted with its sidecar, otherwise the
   * next run and the retry would reuse it from the cache.
   */
  private async fetchEdition(artefact: BulkArtefact, context: ImportContext): Promise<DownloadResult> {
    const attempt = async (): Promise<DownloadResult> => {
      await this.pace();
      // Named after the edition so several can be cached side by side and a history run can resume.
      const result = await downloadFile(artefact.url, `be_kbo_${artefact.fileName}`, context.logger, {
        headers: { cookie: (await this.signIn()).header },
      });
      // A cached file did not hit the portal, so no pause after it.
      if (!result.fromCache) this.lastDownloadAt = Date.now();
      return result;
    };

    const first = await attempt();
    if (await isZipFile(first.path)) return first;

    await discardDownload(first.path);
    context.logger.warn(
      { fileName: artefact.fileName, bytes: first.bytes },
      'KBO answered with its login page rather than the zip: the session expired, reconnecting',
    );
    await sleep(RETRY_PAUSE_MS);
    await this.reconnect();

    const second = await attempt();
    if (await isZipFile(second.path)) return second;

    await discardDownload(second.path);
    throw new EditionUnavailableError(
      `KBO served its login page instead of ${artefact.fileName}, twice, the second time on a ` +
        'freshly established session. The credentials are not the problem - a wrong password is ' +
        'refused at login. The portal is declining this download; try again later, or ask ' +
        'kbo-bce-webservice@economie.fgov.be for the SFTP access that sidesteps this portal.',
    );
  }

  /** Spaces two downloads of one run. */
  private async pace(): Promise<void> {
    const waited = Date.now() - this.lastDownloadAt;
    if (this.lastDownloadAt > 0 && waited < EDITION_PAUSE_MS) await sleep(EDITION_PAUSE_MS - waited);
  }
}

export const kboBulk = new KboBulkSource();

/** Whether the download is really a zip. An expired session returns the login page as HTML. */
export async function isZipFile(path: string): Promise<boolean> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return buffer.toString('latin1') === 'PK';
  } finally {
    await handle.close();
  }
}

/**
 * Removes a download and its validator sidecar. Otherwise the next request would be conditional,
 * and a 304 would serve the cached login page.
 */
export async function discardDownload(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path, { force: true });
  await rm(`${path}.validators.json`, { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts one archive entry next to it, so it can be read more than once. */
async function extract(zipPath: string, suffix: string): Promise<string> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const destination = `${zipPath}.${suffix}`;
  const entry = await openZipEntry(zipPath, (name) => name.endsWith(suffix));
  await pipeline(entry, createWriteStream(destination));
  return destination;
}
