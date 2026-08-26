import { fetchJson } from '../../../lib/http.js';
import { parseZonedDateTime } from '../../../lib/time.js';
import {
  accessToken,
  API_BASE,
  mapCroatianSubject,
  SOURCE,
  sudregCredentials,
  TIME_ZONE,
  type SudregSeat,
  type SudregSubject,
} from '../live/hr-sudreg.js';
import { BulkSource, type Counters, type ImportContext } from '../types.js';

/**
 * The whole Croatian court register, assembled table by table.
 *
 * The v3 API exposes the register's tables one by one: `/subjekti` has no name, address or legal
 * form, so the import joins `/tvrtke`, `/skracene_tvrtke`, `/sjedista` and `/pravni_oblici` on MBS.
 * `/detalji_subjekta` returns a full subject but needs an identifier, so it is only used for
 * lookups.
 */
/** 20,000 rows per page. */
const PAGE_SIZE = 20_000;
const BATCH_SIZE = 1000;

/** Code lists are small and come in one response. */
async function loadCodeList<T>(table: string, query: string, headers: Record<string, string>): Promise<T[]> {
  const rows = await fetchJson<T[]>(`${API_BASE}/${table}?${query}`, { headers, timeoutMs: 30_000, retries: 2 });
  // An error envelope is an object, so return an empty list rather than fail on iteration.
  return Array.isArray(rows) ? rows : [];
}

/** Reads a whole table page by page. */
async function loadTable<T>(
  table: string,
  query: string,
  headers: Record<string, string>,
  onRow: (row: T) => void,
): Promise<void> {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchJson<T[]>(`${API_BASE}/${table}?${query}&offset=${offset}&limit=${PAGE_SIZE}`, {
      headers,
      timeoutMs: 120_000,
      retries: 2,
    });
    if (!Array.isArray(page) || page.length === 0) return;
    for (const row of page) onRow(row);
    if (page.length < PAGE_SIZE) return;
  }
}

export class SudregBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Sudski registar (sudreg open data)';
  readonly countryCode = 'HR';

  override get available(): boolean {
    return sudregCredentials() !== null;
  }

  protected override get unavailableReason(): string {
    return 'the sudreg open data API requires a free account; set SUDREG_CLIENT_ID and SUDREG_CLIENT_SECRET to enable it';
  }

  protected async run(context: ImportContext, counters: Counters): Promise<void> {
    const { clientId, clientSecret } = sudregCredentials()!;
    const token = await accessToken(clientId, clientSecret);
    const headers = { authorization: `Bearer ${token}` };

    // The register keeps a few daily snapshots. Pinning one for every request keeps the join
    // consistent across a rotation, and dates the import.
    const snapshots = await loadCodeList<{ id: number; timestamp: string }>('snapshots', '', headers);
    const snapshot = snapshots.reduce<{ id: number; timestamp: string } | null>(
      (latest, current) => (latest === null || current.id > latest.id ? current : latest),
      null,
    );
    if (!snapshot) throw new Error('sudreg published no snapshot to import');
    const query = `snapshot_id=${snapshot.id}`;
    await context.useArtefact({
      url: `${API_BASE}/subjekti`,
      fileName: `snapshot-${snapshot.id}`,
      date: this.published(parseZonedDateTime(snapshot.timestamp, TIME_ZONE), context),
    });

    // The join tables have one row per subject (about 185,000 each), small enough to hold in memory.
    const names = new Map<number, string>();
    const shortNames = new Map<number, string>();
    const seats = new Map<number, SudregSeat>();
    const legalFormIds = new Map<number, number>();
    const legalFormNames = new Map<number, string>();
    const countries = new Map<number, string>();

    await loadTable<{ mbs: number; ime?: string }>('tvrtke', query, headers, (row) => {
      if (row.ime) names.set(row.mbs, row.ime);
    });
    await loadTable<{ mbs: number; ime?: string }>('skracene_tvrtke', query, headers, (row) => {
      if (row.ime) shortNames.set(row.mbs, row.ime);
    });
    await loadTable<SudregSeat & { mbs: number }>('sjedista', query, headers, (row) => {
      seats.set(row.mbs, row);
    });
    await loadTable<{ mbs: number; vrsta_pravnog_oblika_id?: number }>('pravni_oblici', query, headers, (row) => {
      const id = row.vrsta_pravnog_oblika_id;
      if (id !== undefined) legalFormIds.set(row.mbs, id);
    });
    // Two code lists: legal forms and countries.
    for (const form of await loadCodeList<{ id: number; naziv?: string }>('vrste_pravnih_oblika', query, headers)) {
      if (form.naziv) legalFormNames.set(form.id, form.naziv);
    }
    for (const country of await loadCodeList<{ id: number; oznaka_2?: string }>('drzave', query, headers)) {
      if (country.oznaka_2) countries.set(country.id, country.oznaka_2);
    }

    context.logger.info({ snapshot: snapshot.id, names: names.size, seats: seats.size }, 'Croatia: join tables loaded');

    const batch = this.batch(context, counters, BATCH_SIZE);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await fetchJson<SudregSubject[]>(
        `${API_BASE}/subjekti?${query}&offset=${offset}&limit=${PAGE_SIZE}`,
        { headers, timeoutMs: 120_000, retries: 2 },
      );
      if (!Array.isArray(page) || page.length === 0) break;

      for (const subject of page) {
        // Checked per row, so a `--limit 200` run stops at 200.
        if (batch.full) break;
        const mbs = subject.mbs;
        const seat = mbs === undefined ? null : (seats.get(mbs) ?? null);
        const legalFormId = mbs === undefined ? undefined : legalFormIds.get(mbs);
        const record = mapCroatianSubject(subject, {
          name: mbs === undefined ? null : (names.get(mbs) ?? null),
          shortName: mbs === undefined ? null : (shortNames.get(mbs) ?? null),
          legalForm: legalFormId === undefined ? null : (legalFormNames.get(legalFormId) ?? null),
          seat,
          addressCountry: (seat?.drzava_id === undefined ? undefined : countries.get(seat.drzava_id)) ?? 'HR',
        });
        await batch.add(record?.name ? record : null);
      }
      await batch.flush();

      if (batch.full) {
        context.logger.info({ limit: context.options.limit }, 'Croatia: sample limit reached, stopping');
        break;
      }
      if (page.length < PAGE_SIZE) break;
    }

    await batch.flush();
  }
}

export const sudregBulk = new SudregBulkSource();
