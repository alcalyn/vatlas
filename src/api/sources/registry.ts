import { sireneBulk } from './bulk/fr-sirene.js';
import { kboBulk } from './bulk/be-kbo.js';
import { rikBulk } from './bulk/ee-rik.js';
import { latviaBulk } from './bulk/lv-urvid.js';
import { cvrBulk } from './bulk/dk-cvr.js';
import { prhBulk } from './bulk/fi-prh.js';
import { peppolBulk } from './bulk/de-peppol.js';
import { sudregBulk } from './bulk/hr-sudreg.js';
import { abrBulk } from './bulk/au-abr.js';
import { acraBulk } from './bulk/sg-acra.js';
import { invoiceRegistryBulk } from './bulk/jp-invoice.js';
import { cnpjBulk } from './bulk/br-cnpj.js';
import { sunatBulk } from './bulk/pe-sunat.js';
import { corporationsCanadaBulk } from './bulk/ca-corporations.js';
import { rsmpBulk } from './bulk/ru-rsmp.js';
import { edrBulk } from './bulk/ua-edr.js';
import { vies } from './live/europe-vies.js';
import { whiteList } from './live/pl-mfwl.js';
import { ares } from './live/cz-ares.js';
import { anaf } from './live/ro-anaf.js';
import { aade } from './live/el-aade.js';
import { gemi } from './live/el-gemi.js';
import { cvr } from './live/dk-cvr.js';
import { prh } from './live/fi-prh.js';
import { peppol } from './live/de-peppol.js';
import { sudreg } from './live/hr-sudreg.js';
import { gcis } from './live/tw-gcis.js';
import { rasham } from './live/il-registrar.js';
import { hacienda } from './live/cr-hacienda.js';
import { nzbn } from './live/nz-nzbn.js';
import { brreg } from './live/no-brreg.js';
import { uid } from './live/ch-uid.js';
import { vietqr } from './live/vn-vietqr.js';
import { firs } from './live/ng-firs.js';
import { sri } from './live/ec-sri.js';
import { greenlandCvr } from './live/gl-cvr.js';
import type { BulkSourceAdapterInterface, LiveSourceAdapterInterface } from './types.js';

/**
 * Every source, listed once.
 *
 * Countries reference the instances directly. This registry is for the other direction: the CLI
 * naming a source, code holding a source id from the database, and one place listing all sources.
 *
 * Four registers appear in both lists under one `id` (PRH has a file and an API, sharing one
 * history).
 */
export const BULK_SOURCES: BulkSourceAdapterInterface[] = [
  sireneBulk,
  kboBulk,
  rikBulk,
  latviaBulk,
  cvrBulk,
  prhBulk,
  peppolBulk,
  sudregBulk,
  abrBulk,
  acraBulk,
  invoiceRegistryBulk,
  cnpjBulk,
  sunatBulk,
  corporationsCanadaBulk,
  rsmpBulk,
  edrBulk,
];

export const LIVE_SOURCES: LiveSourceAdapterInterface[] = [
  vies,
  whiteList,
  ares,
  anaf,
  aade,
  gemi,
  cvr,
  prh,
  peppol,
  sudreg,
  gcis,
  rasham,
  hacienda,
  nzbn,
  brreg,
  uid,
  vietqr,
  firs,
  sri,
  greenlandCvr,
];

/**
 * The live adapter for a source id, case-insensitive. Undefined for a bulk-only or unknown id.
 *
 * No bulk equivalent: imports are driven by country.
 */
export function getLiveSource(id: string): LiveSourceAdapterInterface | undefined {
  const wanted = id.trim().toUpperCase();
  return LIVE_SOURCES.find((source) => source.id === wanted);
}
