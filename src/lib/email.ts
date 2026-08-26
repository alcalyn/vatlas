import { createTransport, type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Transactional email over SMTP, in every environment.
 *
 * In development, Mailpit (`docker-compose.yml`) accepts SMTP on 1025 and shows messages on
 * <http://localhost:8025>. In production the same code uses a real relay, so what is tested locally
 * is what ships.
 *
 * Verification and password reset depend on email delivery. Set up SPF, DKIM and DMARC on the
 * sending domain in production.
 */

const emailLogger = logger.child({ component: 'email' });

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      // Mailpit accepts anonymous SMTP, so no credentials is the normal local case.
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
      // Also applies when `secure` is false: nodemailer upgrades via STARTTLS when offered, and a local
      // relay's self-signed certificate would fail.
      tls: { rejectUnauthorized: config.smtp.rejectUnauthorized },
    });
  }
  return transporter;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(email: Email): Promise<void> {
  await getTransporter().sendMail({ from: config.smtp.from, ...email });
  emailLogger.info({ to: email.to, subject: email.subject }, 'email sent');
}

export async function closeEmailer(): Promise<void> {
  transporter?.close();
  transporter = undefined;
}

/** Escapes text for the HTML part. Every value comes from user input. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
