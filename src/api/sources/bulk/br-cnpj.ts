import { streamCsvRows } from '../../../lib/csv.js';
import { parseUtcCompactDate } from '../../../lib/time.js';
import { openZipEntry } from '../../../lib/zip.js';
import type { CompanyRecord } from '../../types.js';
import { BulkSource, type BulkArtefact, type Counters, type ImportContext } from '../types.js';
import {
  loadBrazilCompanies,
  resetBrazilCompanies,
  stageBrazilCompanies,
  type BrazilCompany,
} from './brazilStaging.js';

/**
 * The Receita Federal's open CNPJ data: every company in Brazil, as twenty zipped CSVs per month,
 * with every month since May 2023 still available. `--history` works here. Each edition is 6.7 GB
 * and about 118 million rows.
 *
 * Files are on a public Nextcloud share speaking WebDAV (share token as user name, no password):
 * a PROPFIND lists editions and each file is a plain GET.
 *
 * `Empresas` holds the razão social, sorted by CNPJ root. `Estabelecimentos` holds the address,
 * the status and the rest of the number, and is not sorted. Names (55 million) are staged in MySQL
 * (`brazilStaging.ts`) and read back in batches, so every row is complete when written.
 */
const SHARE = 'https://arquivos.receitafederal.gov.br/public.php/webdav';
const SHARE_TOKEN = 'YggdBLfdninEJX9';

/** Basic auth with the share token as user and no password. */
const SHARE_AUTH = `Basic ${Buffer.from(`${SHARE_TOKEN}:`).toString('base64')}`;

const PARTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

const COMPANY_SLOTS = PARTS.map((part) => `br_empresas_${part}.zip`);
const ESTABLISHMENT_SLOTS = PARTS.map((part) => `br_estabelecimentos_${part}.zip`);
const NATURE_SLOT = 'br_naturezas.zip';
const CITY_SLOT = 'br_municipios.zip';

export const SOURCE = 'CNPJ';

/** CSV format: `;`, latin-1, quoted, no header. */
const CSV = { delimiter: ';', encoding: 'latin1' as const, bom: false };

/** Column positions of `Empresas`, from the published layout. */
const EMPRESA = { cnpjBasico: 0, razaoSocial: 1, naturezaJuridica: 2 } as const;

/** Column positions of `Estabelecimentos`. */
const ESTABELECIMENTO = {
  cnpjBasico: 0,
  cnpjOrdem: 1,
  cnpjDv: 2,
  situacaoCadastral: 5,
  dataSituacaoCadastral: 6,
  tipoLogradouro: 13,
  logradouro: 14,
  numero: 15,
  complemento: 16,
  bairro: 17,
  cep: 18,
  uf: 19,
  municipio: 20,
} as const;

/** `02` is ATIVA. 01 NULA, 03 SUSPENSA, 04 INAPTA and 08 BAIXADA are not trading. */
const ACTIVE = '02';

const cell = (row: string[], index: number): string | null => {
  const value = row[index]?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

const join = (parts: (string | null)[], separator = ' '): string | null => {
  const text = parts
    .filter((part): part is string => Boolean(part))
    .join(separator)
    .trim();
  return text.length > 0 ? text : null;
};

/** The edition's reference tables: code to label. */
export type Labels = Map<string, string>;

/**
 * Maps one establishment with its company.
 *
 * Null when the root is not staged: a row without the razão social would be useless.
 */
export function mapEstablishmentRow(
  row: string[],
  company: BrazilCompany | undefined,
  natures: Labels,
  cities: Labels,
): CompanyRecord | null {
  const basico = cell(row, ESTABELECIMENTO.cnpjBasico);
  const ordem = cell(row, ESTABELECIMENTO.cnpjOrdem);
  const dv = cell(row, ESTABELECIMENTO.cnpjDv);
  if (!basico || !ordem || !dv || !company) return null;

  const cnpj = `${basico.padStart(8, '0')}${ordem.padStart(4, '0')}${dv.padStart(2, '0')}`;
  if (!/^[0-9]{14}$/.test(cnpj)) return null;

  const municipio = cell(row, ESTABELECIMENTO.municipio);
  const uf = cell(row, ESTABELECIMENTO.uf);
  const city = municipio ? (cities.get(municipio) ?? null) : null;
  const nature = company.naturezaJuridica;

  return {
    vatNumber: `BR${cnpj}`,
    nationalId: cnpj,
    name: company.razaoSocial,
    legalForm: nature ? (natures.get(nature) ?? null) : null,
    status: cell(row, ESTABELECIMENTO.situacaoCadastral) === ACTIVE ? 'active' : 'inactive',
    addressLine1: join(
      [
        join([cell(row, ESTABELECIMENTO.tipoLogradouro), cell(row, ESTABELECIMENTO.logradouro)]),
        cell(row, ESTABELECIMENTO.numero),
      ],
      ', ',
    ),
    addressLine2: join([cell(row, ESTABELECIMENTO.complemento), cell(row, ESTABELECIMENTO.bairro)], ', '),
    postalCode: cell(row, ESTABELECIMENTO.cep),
    // Written as "São Paulo - SP": the code table has hundreds of homonyms only the state separates.
    city: join([city, uf], ' - '),
    addressCountry: 'BR',
    // Last change of the situação cadastral, the only date on a row.
    companyLastUpdatedAt: parseUtcCompactDate(cell(row, ESTABELECIMENTO.dataSituacaoCadastral)),
  };
}

/** A two-column reference table: `"4014";"EMPRESA INDIVIDUAL..."`. */
export async function readLabels(rows: AsyncIterable<string[]>): Promise<Labels> {
  const labels: Labels = new Map();
  for await (const row of rows) {
    const code = cell(row, 0);
    const label = cell(row, 1);
    if (code && label) labels.set(code, label);
  }
  return labels;
}

/** The month folders on the share, newest last, from a WebDAV listing. */
export function parseEditionFolders(xml: string): { name: string; date: Date }[] {
  const editions: { name: string; date: Date }[] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/g)) {
    const href = match[1] ?? '';
    const folder = /\/(\d{4})-(\d{2})\/$/.exec(href);
    if (!folder) continue;
    editions.push({
      name: `${folder[1]}-${folder[2]}`,
      // Dated by the month of the edition, from the folder name: the twenty files have different
      // `Last-Modified` dates.
      date: new Date(Date.UTC(Number(folder[1]), Number(folder[2]) - 1, 1)),
    });
  }
  return editions.sort((left, right) => left.date.getTime() - right.date.getTime());
}

export class CnpjBulkSource extends BulkSource {
  readonly id = SOURCE;
  readonly name = 'Cadastro Nacional da Pessoa Jurídica (Receita Federal)';
  readonly countryCode = 'BR';
  override readonly slots = [...COMPANY_SLOTS, ...ESTABLISHMENT_SLOTS, NATURE_SLOT, CITY_SLOT];

  protected override async editions(context: ImportContext): Promise<BulkArtefact[]> {
    const folders = parseEditionFolders(await this.propfind(`${SHARE}/`));
    context.logger.info({ available: folders.length }, 'Brazil: monthly editions on offer');

    return folders.map((folder) => ({
      url: `${SHARE}/${folder.name}/`,
      // The artefact is the folder: twenty files read as one edition under one date.
      fileName: `dados_abertos_cnpj/${folder.name}`,
      date: folder.date,
    }));
  }

  protected async run(context: ImportContext, counters: Counters, edition: BulkArtefact | null): Promise<void> {
    // A run with local files does not list the share.
    const chosen = context.options.localFiles
      ? this.localEdition(context)
      : (edition ?? (await this.editions(context)).at(-1));
    if (!chosen) throw new Error('the CNPJ share offers no edition');

    await context.useArtefact({
      url: chosen.url,
      fileName: chosen.fileName,
      date: this.published(chosen.date, context),
    });

    try {
      const natures = await this.labels(context, chosen, 'Naturezas.zip', NATURE_SLOT);
      const cities = await this.labels(context, chosen, 'Municipios.zip', CITY_SLOT);
      await this.stage(context, chosen);
      await this.establishments(context, counters, chosen, natures, cities);
    } finally {
      // Always emptied, so a failed run leaves nothing for the next one.
      await resetBrazilCompanies();
    }
  }

  /**
   * Pass one: every `Empresas` file into `br_empresa`.
   *
   * `--limit` does not shorten it: establishments are unsorted, so their names can be anywhere.
   */
  private async stage(context: ImportContext, edition: BulkArtefact): Promise<void> {
    await resetBrazilCompanies();
    let staged = 0;

    for (const [part, slot] of COMPANY_SLOTS.entries()) {
      const rows = await this.table(context, edition, `Empresas${part}.zip`, slot);
      let pending: [string, string, string | null][] = [];
      for await (const row of rows) {
        const basico = cell(row, EMPRESA.cnpjBasico);
        const name = cell(row, EMPRESA.razaoSocial);
        if (!basico || !name) continue;
        pending.push([basico.padStart(8, '0'), name, cell(row, EMPRESA.naturezaJuridica)]);
        if (pending.length >= 50_000) {
          await stageBrazilCompanies(pending);
          staged += pending.length;
          pending = [];
        }
      }
      if (pending.length > 0) {
        await stageBrazilCompanies(pending);
        staged += pending.length;
      }
      context.logger.info({ file: `Empresas${part}.zip`, staged }, 'Brazil: company names staged');
    }
  }

  /** Pass two: establishments, joined in batches against pass one. */
  private async establishments(
    context: ImportContext,
    counters: Counters,
    edition: BulkArtefact,
    natures: Labels,
    cities: Labels,
  ): Promise<void> {
    const batch = this.batch(context, counters);
    // Joined per batch: one indexed query per thousand establishments.
    let pending: string[][] = [];

    const flush = async (): Promise<boolean> => {
      const companies = await loadBrazilCompanies(
        pending.map((row) => cell(row, ESTABELECIMENTO.cnpjBasico)?.padStart(8, '0') ?? ''),
      );
      for (const row of pending) {
        const basico = cell(row, ESTABELECIMENTO.cnpjBasico)?.padStart(8, '0') ?? '';
        const record = mapEstablishmentRow(row, companies.get(basico), natures, cities);
        // Skip nameless rows.
        await batch.add(record?.name ? record : null);
        if (batch.full) return true;
      }
      pending = [];
      return false;
    };

    for (const [part, slot] of ESTABLISHMENT_SLOTS.entries()) {
      const rows = await this.table(context, edition, `Estabelecimentos${part}.zip`, slot);
      for await (const row of rows) {
        pending.push(row);
        if (pending.length < 1_000) continue;
        if (await flush()) {
          context.logger.info({ limit: context.options.limit }, 'Brazil: sample limit reached, stopping');
          await batch.flush();
          return;
        }
      }
      context.logger.info({ file: `Estabelecimentos${part}.zip` }, 'Brazil: establishments read');
    }

    if (pending.length > 0) await flush();
    await batch.flush();
  }

  /**
   * The edition of a `--file` run, derived from `--date`.
   *
   * The folder URL still points to the share, so missing reference tables can be downloaded. For a
   * month no longer on the share that 404s: use `--file br_naturezas.zip=...`.
   */
  private localEdition(context: ImportContext): BulkArtefact {
    const date = this.published(null, context);
    const month = date.toISOString().slice(0, 7);
    return {
      url: `${SHARE}/${month}/`,
      fileName: `dados_abertos_cnpj/${month}`,
      date,
    };
  }

  /** One of the two small code tables of an edition. */
  private async labels(context: ImportContext, edition: BulkArtefact, fileName: string, slot: string): Promise<Labels> {
    return readLabels(await this.table(context, edition, fileName, slot));
  }

  /** One zipped CSV, streamed as positional rows. */
  private async table(
    context: ImportContext,
    edition: BulkArtefact,
    fileName: string,
    slot: string,
  ): Promise<AsyncIterable<string[]>> {
    const archive = await this.download(context, `${edition.url}${fileName}`, slot, {
      headers: { authorization: SHARE_AUTH },
    });
    const entry = await openZipEntry(archive.path, () => true);
    return streamCsvRows(entry, CSV);
  }

  /**
   * A `Depth: 1` listing of one collection.
   *
   * Network failures are re-raised with the share's name, since `fetch` only says "fetch failed".
   */
  private async propfind(url: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PROPFIND',
        headers: { authorization: SHARE_AUTH, depth: '1' },
      });
    } catch (error) {
      throw new Error(`the CNPJ share could not be reached for a listing of ${url}`, { cause: error });
    }
    if (!response.ok && response.status !== 207) {
      throw new Error(`the CNPJ share refused a listing of ${url}: HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
}

export const cnpjBulk = new CnpjBulkSource();
