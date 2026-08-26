import type { CompanyStatus } from '../generated/prisma/enums.js';

// Declared in prisma/schema.prisma.
export type { CompanyStatus };

/**
 * Normalized company identity, the same for every country and source.
 *
 * No provenance: a mapper only sees one row or JSON body. The source adapter adds provenance on
 * the way to the database.
 */
export interface CompanyRecord {
  /**
   * The full VAT number with its prefix, e.g. `FR95884831538` (EL for Greece, XI for Northern
   * Ireland).
   */
  vatNumber: string;
  /** National business identifier (SIREN, NIP, Y-tunnus, registrikood, reg. nr...). */
  nationalId: string | null;
  /**
   * Null only for a `not_registered` answer, which has no identity. Anything else without a name is
   * not stored.
   */
  name: string | null;
  legalForm: string | null;
  status: CompanyStatus;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  /** Country of the address, not always the country of the VAT number. */
  addressCountry: string | null;
  /**
   * When the source itself last updated the record, if it publishes that (SIRENE and the Polish White
   * List do).
   */
  companyLastUpdatedAt: Date | null;
}

/**
 * What a source said on one day: the input of the history.
 *
 * One date, since that is all an adapter knows. The storage layer turns it into a plateau.
 */
export interface StatementInput extends CompanyRecord {
  /** The register: SIRENE, KBO, PRH, PEPPOL, VIES... */
  source: string;
  /**
   * The day the source said it: file date for bulk, call date for live. Date only, normalize with
   * `asDay()`.
   */
  date: Date;
  /** The `bulk` row this was read from. Null for live answers. */
  bulkId: bigint | null;
  /** The verification code of an official consultation. Only VIES issues one. */
  proof: string | null;
}

/**
 * One row of `company`: a period during which one source said the same thing about one number.
 *
 * `dateStart` is since when, `dateEnd` the last day the source was seen saying it (used for
 * freshness).
 *
 * A gap between one plateau's `dateEnd` and the next one's `dateStart` means nothing was read in
 * between.
 */
export interface CompanyStatement extends CompanyRecord {
  /** The register: SIRENE, KBO, PRH, PEPPOL, VIES... */
  source: string;
  /** First day this source was seen saying this. */
  dateStart: Date;
  /** Last day it was seen saying this. Equal to `dateStart` for a plateau seen once. */
  dateEnd: Date;
  /** The `bulk` row that opened the plateau. Null for live answers. */
  bulkId: bigint | null;
  /** The verification code of an official consultation. Only VIES issues one. */
  proof: string | null;
}

/** A stored statement with its source file resolved, joined once on read. */
export interface StoredStatement extends CompanyStatement {
  bulk: BulkArtefactRow | null;
}

/** One row of `bulk`: a file imported at least once. */
export interface BulkArtefactRow {
  id: bigint;
  source: string;
  url: string;
  fileName: string;
  /** The file's publication date, not the download date. */
  date: Date;
}

/**
 * Midnight UTC of the day: the only form plateau dates are written in.
 *
 * DATE and DateTime columns do not round-trip the same way through Prisma, and statements written
 * at 23:00 and 01:00 local time must land on the same day.
 */
export function asDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** Today, as plateau dates are written. */
export function today(): Date {
  return asDay(new Date());
}
