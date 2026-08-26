import { getPrisma } from '../db/prisma.js';

/**
 * Everything held about one account holder, collected in one place.
 *
 * GDPR Articles 15 and 20 both ask what we hold. The console's `/data` page and the two exports are
 * built from this one function, so they cannot disagree.
 *
 * Rule when adding a table: if it has `user_id`, it belongs here. `test/personalData.test.ts` checks
 * this against the schema. The prose for each section (why, legal basis, retention) is in
 * `locales/*.json` under `data.*`, consistent with the privacy policy.
 */

/** The inventory sections, in the order the page and exports show them. */
export const SECTION_IDS = [
  'identity',
  'consent',
  'billing',
  'payment',
  'keys',
  'sessions',
  'links',
  'signins',
  'callbacks',
  'monitors',
  'async',
  'deliveries',
  'audit',
  'usage',
  'logs',
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/**
 * What a section is, under GDPR Article 4(1).
 *
 * Collecting everything with a `user_id` is right for an export, but most of it is contract terms,
 * timestamps or data about other companies. About eleven fields are clearly personal data
 * (eighteen for a sole trader), and about fifty are not.
 *
 * So the page sorts them:
 *
 * - `personal`: data about the holder as a natural person: address, IP addresses (CJEU Breyer,
 *   C-582/14), user agent, sign-in times, Terms acceptance. Billing details are here
 *   conditionally: personal for a sole trader, a legal person's data for a company (recital 14).
 * - `account`: contractual and technical (plan, quota, counters, keys). Personal only because they
 *   belong to an identified holder (WP29 WP136).
 * - `others`: about the companies looked up. Mostly legal persons, outside the Regulation; personal
 *   data of a third party when the company is a sole trader (Article 14, privacy policy §11).
 * - `null`: exported but not shown. Delivery records and callback configuration, editable on the
 *   monitor and async lookup pages.
 */
export type Tier = 'personal' | 'account' | 'others';

export const TIERS: readonly Tier[] = ['personal', 'account', 'others'];

export const SECTION_TIER: Record<SectionId, Tier | null> = {
  identity: 'personal',
  consent: 'personal',
  billing: 'personal',
  payment: 'personal',
  sessions: 'personal',
  links: 'personal',
  signins: 'personal',
  keys: 'account',
  usage: 'account',
  logs: 'account',
  monitors: 'others',
  async: 'others',
  audit: 'others',
  callbacks: null,
  deliveries: null,
};

/**
 * Rows shown per collection before "and N more". The exports have everything up to
 * {@link EXPORT_ROW_CAP}.
 */
export const PAGE_ROW_CAP = 5;

/**
 * Fields exported but not shown: row mechanics (update timestamps, derived expiries, internal ids,
 * retry counters).
 */
const PAGE_HIDDEN_FIELDS = new Set(['updatedAt', 'expiresAt', 'inactivityWarnedAt', 'attempts', 'attempt', 'id']);

/**
 * The inventory as the page shows it: sections with a tier, in tier order, without row mechanics,
 * each collection cut to {@link PAGE_ROW_CAP}. `total` is kept so the page can say how many rows are
 * hidden.
 *
 * The input is not modified: the exports use the same object.
 */
export function pageSections(record: PersonalDataRecord): Section[] {
  const shown: Section[] = [];
  for (const tier of TIERS) {
    for (const section of record.sections) {
      if (SECTION_TIER[section.id] !== tier) continue;
      shown.push({
        ...section,
        ...(section.fields
          ? {
              fields: Object.fromEntries(
                Object.entries(section.fields).filter(([name]) => !PAGE_HIDDEN_FIELDS.has(name)),
              ),
            }
          : {}),
        ...(section.rows
          ? {
              rows: section.rows
                .slice(0, PAGE_ROW_CAP)
                .map((row) =>
                  Object.fromEntries(Object.entries(row).filter(([name]) => !PAGE_HIDDEN_FIELDS.has(name))),
                ),
            }
          : {}),
      });
    }
  }
  return shown;
}

/** What a field can hold. Dates are ISO strings, so JSON and text agree. */
export type FieldValue = string | number | boolean | null;

export type Fields = Record<string, FieldValue>;

/**
 * One section, in one of three shapes:
 *
 * - `fields`: one record, such as the account;
 * - `rows`: a collection, such as keys or sessions;
 * - `summary`: a count and the period it spans, for tables too large to list
 */
export interface Section {
  id: SectionId;
  kind: 'fields' | 'rows' | 'summary';
  fields?: Fields;
  rows?: Fields[];
  /** Total number of rows. Equal to `rows.length` unless the listing was capped. */
  total?: number;
  /** Oldest and newest row, as ISO strings. Set on a summary and on a capped listing. */
  from?: string | null;
  to?: string | null;
}

export interface PersonalDataRecord {
  /** The address the export is about. */
  email: string;
  generatedAt: string;
  sections: Section[];
}

/**
 * Rows per collection in an export. A Pro audit trail can hold two years of calls, and an export is
 * a browser download. Past this the section gives the count and period, and its prose points to the
 * API, which pages through everything.
 */
export const EXPORT_ROW_CAP = 1000;

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Reads everything, in page order. One query per table, no joins. */
export async function collectPersonalData(userId: bigint, currentSessionHash?: string): Promise<PersonalDataRecord> {
  const prisma = getPrisma();

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      locale: true,
      plan: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      inactivityWarnedAt: true,
      emailVerifiedAt: true,
      // Only whether a password exists. The hash is never exported.
      passwordHash: true,
      passwordChangedAt: true,
      termsVersion: true,
      termsAcceptedAt: true,
      termsAcceptedIp: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      cancelAt: true,
      monitorUrl: true,
      lookupAsyncUrl: true,
      callbackSecretSealed: true,
      billingProfile: true,
    },
  });

  const [keys, sessions, links, signins, monitors, asyncLookups, deliveries, usagePeriods] = await Promise.all([
    prisma.secretKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { name: true, prefix: true, last4: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    }),
    prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { tokenHash: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    }),
    prisma.loginToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
      select: { purpose: true, requestIp: true, createdAt: true, expiresAt: true, consumedAt: true },
    }),
    // Failed sign-ins on this account. Only failures are stored, and a success clears them.
    prisma.authAttempt.findMany({
      where: { userId, kind: 'login' },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
      select: { ip: true, createdAt: true },
    }),
    prisma.monitor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        publicId: true,
        vatNumber: true,
        url: true,
        lastSource: true,
        lastCheckedAt: true,
        lastChangedAt: true,
        lastDeliveredAt: true,
        createdAt: true,
      },
    }),
    prisma.asyncLookup.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
      select: {
        publicId: true,
        vatNumber: true,
        kind: true,
        url: true,
        status: true,
        attempts: true,
        createdAt: true,
        completedAt: true,
        deliveredAt: true,
      },
    }),
    prisma.delivery.findMany({
      where: { userId },
      orderBy: { sentAt: 'desc' },
      take: EXPORT_ROW_CAP,
      select: { publicId: true, event: true, url: true, attempt: true, httpStatus: true, error: true, sentAt: true },
    }),
    prisma.usagePeriod.findMany({
      where: { userId },
      orderBy: { periodStart: 'asc' },
      select: { periodStart: true, periodEnd: true, plan: true, quota: true, used: true },
    }),
  ]);

  const [linkCount, signinCount, asyncCount, deliveryCount, audit, logs] = await Promise.all([
    prisma.loginToken.count({ where: { userId } }),
    prisma.authAttempt.count({ where: { userId, kind: 'login' } }),
    prisma.asyncLookup.count({ where: { userId } }),
    prisma.delivery.count({ where: { userId } }),
    collectAudit(userId),
    // A count and a period only: `log_lookup` is our own instrumentation, with no field the holder gave
    // us.
    summarise('logs', prisma.lookupLog, { userId }, 'createdAt'),
  ]);

  const profile = account.billingProfile;

  const sections: Section[] = [
    {
      id: 'identity',
      kind: 'fields',
      fields: {
        email: account.email,
        language: account.locale,
        plan: account.plan,
        status: account.status,
        createdAt: iso(account.createdAt),
        updatedAt: iso(account.updatedAt),
        deletedAt: iso(account.deletedAt),
        inactivityWarnedAt: iso(account.inactivityWarnedAt),
        emailVerifiedAt: iso(account.emailVerifiedAt),
        passwordSet: account.passwordHash !== null,
        passwordChangedAt: iso(account.passwordChangedAt),
      },
    },
    {
      id: 'consent',
      kind: 'fields',
      fields: {
        termsVersion: account.termsVersion,
        termsAcceptedAt: iso(account.termsAcceptedAt),
        termsAcceptedIp: account.termsAcceptedIp,
      },
    },
    {
      id: 'billing',
      kind: 'fields',
      fields: profile
        ? {
            companyName: profile.companyName,
            vatNumber: profile.vatNumber,
            line1: profile.line1,
            line2: profile.line2,
            postalCode: profile.postalCode,
            city: profile.city,
            country: profile.country,
            createdAt: iso(profile.createdAt),
            updatedAt: iso(profile.updatedAt),
          }
        : {},
    },
    {
      id: 'payment',
      kind: 'fields',
      fields: {
        stripeCustomerId: account.stripeCustomerId,
        stripeSubscriptionId: account.stripeSubscriptionId,
        subscriptionStatus: account.subscriptionStatus,
        currentPeriodEnd: iso(account.currentPeriodEnd),
        cancelAt: iso(account.cancelAt),
      },
    },
    // The secret is not included here or in the exports. It is shown on `/keys` to a signed-in browser,
    // not written into a downloaded file.
    rows(
      'keys',
      keys.map((key) => ({
        name: key.name,
        key: `${key.prefix}…${key.last4}`,
        createdAt: iso(key.createdAt),
        lastUsedAt: iso(key.lastUsedAt),
        revokedAt: iso(key.revokedAt),
      })),
    ),
    rows(
      'sessions',
      sessions.map((session) => ({
        current: currentSessionHash !== undefined && session.tokenHash === currentSessionHash,
        ip: session.ip,
        userAgent: session.userAgent,
        createdAt: iso(session.createdAt),
        lastSeenAt: iso(session.lastSeenAt),
        expiresAt: iso(session.expiresAt),
      })),
    ),
    {
      ...rows(
        'links',
        links.map((link) => ({
          purpose: link.purpose,
          ip: link.requestIp,
          createdAt: iso(link.createdAt),
          expiresAt: iso(link.expiresAt),
          consumedAt: iso(link.consumedAt),
        })),
      ),
      total: linkCount,
    },
    {
      ...rows(
        'signins',
        signins.map((attempt) => ({ ip: attempt.ip, createdAt: iso(attempt.createdAt) })),
      ),
      total: signinCount,
    },
    {
      id: 'callbacks',
      kind: 'fields',
      fields: {
        monitorUrl: account.monitorUrl,
        lookupAsyncUrl: account.lookupAsyncUrl,
        // Whether there is one, never the value: it signs every callback.
        signingSecret: account.callbackSecretSealed !== null,
      },
    },
    rows(
      'monitors',
      monitors.map((monitor) => ({
        vatNumber: monitor.vatNumber,
        url: monitor.url,
        lastSource: monitor.lastSource,
        lastCheckedAt: iso(monitor.lastCheckedAt),
        lastChangedAt: iso(monitor.lastChangedAt),
        lastDeliveredAt: iso(monitor.lastDeliveredAt),
        createdAt: iso(monitor.createdAt),
      })),
    ),
    {
      ...rows(
        'async',
        asyncLookups.map((lookup) => ({
          id: lookup.publicId,
          vatNumber: lookup.vatNumber,
          kind: lookup.kind,
          status: lookup.status,
          url: lookup.url,
          attempts: lookup.attempts,
          createdAt: iso(lookup.createdAt),
          completedAt: iso(lookup.completedAt),
          deliveredAt: iso(lookup.deliveredAt),
        })),
      ),
      total: asyncCount,
    },
    {
      ...rows(
        'deliveries',
        deliveries.map((delivery) => ({
          event: delivery.event,
          url: delivery.url,
          attempt: delivery.attempt,
          httpStatus: delivery.httpStatus,
          error: delivery.error,
          sentAt: iso(delivery.sentAt),
        })),
      ),
      total: deliveryCount,
    },
    audit,
    rows(
      'usage',
      usagePeriods.map((period) => ({
        periodStart: iso(period.periodStart),
        periodEnd: iso(period.periodEnd),
        plan: period.plan,
        quota: period.quota,
        used: period.used,
      })),
    ),
    logs,
  ];

  return { email: account.email, generatedAt: new Date().toISOString(), sections };
}

function rows(id: SectionId, list: Fields[]): Section {
  return { id, kind: 'rows', rows: list, total: list.length };
}

/**
 * The audit trail: the flat columns of every row, capped, plus count and period.
 *
 * The stored envelopes are not included: one JSON document per call would make the file unreadable.
 * `/v1/audit` and `/audits/:id` return them one by one.
 */
async function collectAudit(userId: bigint): Promise<Section> {
  const prisma = getPrisma();
  const [list, summary] = await Promise.all([
    prisma.auditLookup.findMany({
      where: { userId },
      orderBy: { fetchedAt: 'desc' },
      take: EXPORT_ROW_CAP,
      select: {
        publicId: true,
        vatNumber: true,
        kind: true,
        httpStatus: true,
        errorCode: true,
        companyName: true,
        source: true,
        sourceDate: true,
        proof: true,
        fetchedAt: true,
      },
    }),
    summarise('audit', prisma.auditLookup, { userId }, 'fetchedAt'),
  ]);

  return {
    ...summary,
    kind: 'rows',
    rows: list.map((row) => ({
      id: row.publicId,
      fetchedAt: iso(row.fetchedAt),
      vatNumber: row.vatNumber,
      kind: row.kind,
      httpStatus: row.httpStatus,
      errorCode: row.errorCode,
      companyName: row.companyName,
      source: row.source,
      sourceDate: row.sourceDate ? row.sourceDate.toISOString().slice(0, 10) : null,
      proof: row.proof,
    })),
  };
}

/** A count and a period, for a table only read in aggregate. */
async function summarise(
  id: SectionId,
  model: { count: (args: object) => Promise<number>; aggregate: (args: object) => Promise<unknown> },
  where: object,
  dateField: 'createdAt' | 'fetchedAt',
): Promise<Section> {
  const [total, bounds] = await Promise.all([
    model.count({ where }),
    model.aggregate({ where, _min: { [dateField]: true }, _max: { [dateField]: true } }) as Promise<{
      _min: Record<string, Date | null>;
      _max: Record<string, Date | null>;
    }>,
  ]);
  return { id, kind: 'summary', total, from: iso(bounds._min[dateField]), to: iso(bounds._max[dateField]) };
}

// -- exports --

/**
 * GDPR Article 20 asks for a "structured, commonly used and machine-readable format". One key per
 * section: an object for a record, an array for a collection, with count and period where capped or
 * summarized.
 */
export function toJsonExport(record: PersonalDataRecord): string {
  const data: Record<string, unknown> = {};
  for (const section of record.sections) {
    if (section.kind === 'fields') {
      data[section.id] = section.fields ?? {};
    } else if (section.kind === 'rows') {
      data[section.id] = {
        total: section.total ?? section.rows?.length ?? 0,
        included: section.rows?.length ?? 0,
        ...(section.from !== undefined ? { from: section.from, to: section.to } : {}),
        rows: section.rows ?? [],
      };
    } else {
      data[section.id] = { total: section.total ?? 0, from: section.from ?? null, to: section.to ?? null };
    }
  }

  return `${JSON.stringify(
    {
      export: {
        service: 'Vatlas',
        account: record.email,
        generatedAt: record.generatedAt,
        format: 1,
        note: `Dates are ISO 8601 in UTC. Collections are capped at ${EXPORT_ROW_CAP} rows; "total" says how many exist.`,
      },
      data,
    },
    null,
    2,
  )}\n`;
}

/**
 * The same inventory as text, for people. Built from the same sections, so the exports agree.
 *
 * Always in English, with the field names the API uses, so the JSON and the text describe the same
 * thing. The page says so.
 */
export function toTextExport(record: PersonalDataRecord): string {
  const out: string[] = [
    'VATLAS - PERSONAL DATA EXPORT',
    '='.repeat(60),
    `Account:      ${record.email}`,
    `Generated at: ${record.generatedAt}`,
    `Dates are ISO 8601 in UTC. Collections are capped at ${EXPORT_ROW_CAP} rows.`,
    '',
  ];

  for (const section of record.sections) {
    out.push(`${section.id.toUpperCase()}`, '-'.repeat(60));

    if (section.kind === 'fields') {
      const fields = section.fields ?? {};
      if (Object.keys(fields).length === 0) out.push('  (nothing held)');
      else out.push(...lines(fields, '  '));
    } else if (section.kind === 'rows') {
      const list = section.rows ?? [];
      out.push(`  ${section.total ?? list.length} record(s), ${list.length} listed below.`);
      if (list.length === 0) out.push('  (nothing held)');
      list.forEach((row, index) => {
        out.push(`  [${index + 1}]`, ...lines(row, '    '));
      });
    } else {
      out.push(
        `  ${section.total ?? 0} record(s).`,
        `  Oldest: ${section.from ?? '-'}`,
        `  Newest: ${section.to ?? '-'}`,
      );
    }
    out.push('');
  }

  return out.join('\n');
}

/** `label: value` at a fixed width. Empty values are shown, not dropped. */
function lines(fields: Fields, indent: string): string[] {
  const width = Math.max(...Object.keys(fields).map((key) => key.length));
  return Object.entries(fields).map(
    ([key, value]) => `${indent}${key.padEnd(width)} : ${value === null || value === '' ? '-' : String(value)}`,
  );
}

// -- erasure per section --

/**
 * Sections a holder can erase without closing the account. Other sections are excluded for a reason
 * the page states: an invoice we must keep, a counter used for the quota, the current session.
 *
 * The two hidden sections are not erasable here either: callback URLs are cleared on `/monitor` or
 * `/lookup-async`, the signing secret is rolled there, and deliveries are removed with their
 * monitor and after ninety days anyway.
 */
export const ERASABLE = ['billing', 'sessions', 'links', 'async', 'audit'] as const;

export type Erasable = (typeof ERASABLE)[number];

export function isErasable(value: string): value is Erasable {
  return (ERASABLE as readonly string[]).includes(value);
}

export type EraseResult = { ok: true; deleted: number } | { ok: false; reason: 'subscription-active' };

/**
 * Erases one section only.
 *
 * GDPR Article 17 is not all-or-nothing. Each query is scoped by `userId`, so a posted section name
 * can only reach the poster's rows.
 */
export async function eraseSection(
  userId: bigint,
  section: Erasable,
  options: { keepSessionHash?: string } = {},
): Promise<EraseResult> {
  const prisma = getPrisma();

  switch (section) {
    case 'billing': {
      // Refused while Stripe is billing, like account erasure: invoices need an address.
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: userId },
        select: { plan: true, subscriptionStatus: true },
      });
      const live =
        account.subscriptionStatus !== null && !['canceled', 'incomplete_expired'].includes(account.subscriptionStatus);
      if (account.plan === 'pro' || live) return { ok: false, reason: 'subscription-active' };

      const { count } = await prisma.billingProfile.deleteMany({ where: { userId } });
      return { ok: true, deleted: count };
    }

    case 'sessions': {
      // Every session except the current one.
      const { count } = await prisma.session.deleteMany({
        where: { userId, ...(options.keepSessionHash ? { tokenHash: { not: options.keepSessionHash } } : {}) },
      });
      return { ok: true, deleted: count };
    }

    case 'links': {
      const { count } = await prisma.loginToken.deleteMany({ where: { userId } });
      return { ok: true, deleted: count };
    }

    case 'async': {
      // Finished ones only. A pending lookup is paid work, and deleting it would lose the credit.
      const ids = await prisma.asyncLookup.findMany({
        where: { userId, status: { in: ['success', 'failed'] } },
        select: { id: true },
      });
      if (ids.length === 0) return { ok: true, deleted: 0 };

      const list = ids.map((row) => row.id);
      const count = await prisma.$transaction(async (tx) => {
        await tx.delivery.deleteMany({ where: { userId, asyncLookupId: { in: list } } });
        const deleted = await tx.asyncLookup.deleteMany({ where: { userId, id: { in: list } } });
        return deleted.count;
      });
      return { ok: true, deleted: count };
    }

    case 'audit': {
      const { count } = await prisma.auditLookup.deleteMany({ where: { userId } });
      return { ok: true, deleted: count };
    }
  }
}
