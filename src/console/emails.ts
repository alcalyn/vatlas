import { config } from '../config.js';
import { escapeHtml, sendEmail } from '../lib/email.js';
import { t, type Locale } from './i18n.js';

/**
 * Emails sent by the console. All are in the account's language and have a plain-text part.
 *
 * Styling is minimal and inline, since mail clients strip `<style>` and custom properties.
 */

const BUTTON =
  'display:inline-block;background:#16457a;color:#ffffff;text-decoration:none;' +
  'padding:12px 22px;border-radius:8px;font-weight:600';
const BODY =
  'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
  'line-height:1.6;color:#0f1219;max-width:520px';
const RULE = 'border:0;border-top:1px solid #e3e7f0;margin:28px 0 20px';

/** Heading, lead, one button, then small print: the shape of every email. */
async function sendLinkEmail(
  to: string,
  locale: Locale,
  keys: { subject: string; heading: string; body: string; button: string; expiry: string; ignore: string },
  url: string,
): Promise<void> {
  const tr = t(locale);

  await sendEmail({
    to,
    subject: tr(keys.subject),
    text: [tr(keys.heading), '', tr(keys.body), '', url, '', tr(keys.expiry), '', tr(keys.ignore)].join('\n'),
    html: `<div style="${BODY}">
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(tr(keys.heading))}</h1>
  <p>${escapeHtml(tr(keys.body))}</p>
  <p style="margin:24px 0"><a href="${escapeHtml(url)}" style="${BUTTON}">${escapeHtml(tr(keys.button))}</a></p>
  <p style="color:#4b5468;font-size:14px">${escapeHtml(tr(keys.expiry))}</p>
  <p style="color:#6f7889;font-size:13px">${escapeHtml(tr(keys.ignore))}</p>
</div>`,
  });
}

/**
 * The only email an unverified account receives unasked. No welcome and no key are sent until the
 * address is verified, so signing up with someone else's address only sends them this.
 */
export async function sendVerifyEmail(to: string, url: string, locale: Locale): Promise<void> {
  await sendLinkEmail(
    to,
    locale,
    {
      subject: 'mail.verifySubject',
      heading: 'mail.verifyHeading',
      body: 'mail.verifyBody',
      button: 'mail.verifyButton',
      expiry: 'mail.verifyExpiry',
      ignore: 'mail.verifyIgnore',
    },
    url,
  );
}

export async function sendPasswordResetEmail(to: string, url: string, locale: Locale): Promise<void> {
  await sendLinkEmail(
    to,
    locale,
    {
      subject: 'mail.resetSubject',
      heading: 'mail.resetHeading',
      body: 'mail.resetBody',
      button: 'mail.resetButton',
      expiry: 'mail.resetExpiry',
      ignore: 'mail.resetIgnore',
    },
    url,
  );
}

/**
 * Security notice, sent even if the address is unverified: it only goes to the account's own
 * address, and it must reach the holder if the change was not theirs. It points to the reset form.
 */
export async function sendPasswordChangedEmail(to: string, locale: Locale): Promise<void> {
  const tr = t(locale);
  const forgot = `${config.console.baseUrl}/password/forgot?lang=${locale}`;

  await sendEmail({
    to,
    subject: tr('mail.changedSubject'),
    text: [tr('mail.changedHeading'), '', tr('mail.changedBody'), '', tr('mail.changedNotYou'), forgot].join('\n'),
    html: `<div style="${BODY}">
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(tr('mail.changedHeading'))}</h1>
  <p>${escapeHtml(tr('mail.changedBody'))}</p>
  <hr style="${RULE}">
  <p style="color:#4b5468;font-size:14px">${escapeHtml(tr('mail.changedNotYou'))}</p>
  <p style="margin:24px 0"><a href="${escapeHtml(forgot)}" style="${BUTTON}">${escapeHtml(tr('mail.changedButton'))}</a></p>
</div>`,
  });
}

/**
 * Warning sent a month before a dormant account is erased, as the privacy policy promises.
 *
 * The only action is to sign in, which proves the account is still used. There is no "keep me"
 * link that could be replayed.
 */
export async function sendDormantWarningEmail(to: string, days: number, locale: Locale): Promise<void> {
  const tr = t(locale);
  const login = `${config.console.baseUrl}/login?lang=${locale}`;

  await sendEmail({
    to,
    subject: tr('mail.dormantSubject', { count: days }),
    text: [
      tr('mail.dormantHeading'),
      '',
      tr('mail.dormantBody', { count: days }),
      '',
      tr('mail.dormantKeep'),
      '',
      login,
      '',
      tr('mail.dormantIgnore'),
    ].join('\n'),
    html: `<div style="${BODY}">
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(tr('mail.dormantHeading'))}</h1>
  <p>${escapeHtml(tr('mail.dormantBody', { count: days }))}</p>
  <p>${escapeHtml(tr('mail.dormantKeep'))}</p>
  <p style="margin:24px 0"><a href="${escapeHtml(login)}" style="${BUTTON}">${escapeHtml(tr('mail.dormantButton'))}</a></p>
  <hr style="${RULE}">
  <p style="color:#6f7889;font-size:13px">${escapeHtml(tr('mail.dormantIgnore'))}</p>
</div>`,
  });
}
