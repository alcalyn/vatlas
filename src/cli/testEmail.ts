import { config } from '../config.js';
import { closeEmailer, sendEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

function usage(): string {
  return [
    'Usage: npm run email:test -- <address>',
    '',
    'Sends one plain-text message to <address> through the very transport the application',
    'uses - same SMTP_* settings, same EMAIL_FROM, same code path as a password reset. It is the',
    'way to tell a relay problem from an application problem: if this arrives and a sign-in',
    'link does not, the relay is fine.',
    '',
    'In development it lands in Mailpit (http://localhost:8025) rather than in a real inbox.',
    'Remember that tsx does not reload .env: after editing it, start the command afresh.',
    '',
    'Examples:',
    '  npm run email:test -- you@example.com',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const to = args.find((arg) => !arg.startsWith('-'));
  if (!to) {
    process.stdout.write(`${usage()}\n`);
    process.exit(1);
  }

  const sentAt = new Date().toISOString();
  const text = [
    'This is a test message sent by the vatlas CLI.',
    '',
    `Sent at: ${sentAt}`,
    `From:    ${config.smtp.from}`,
    `Relay:   ${config.smtp.host}:${config.smtp.port}`,
    '',
    'If you are reading this, the SMTP configuration works.',
  ].join('\n');

  await sendEmail({
    to,
    subject: 'vatlas test email',
    text,
    // The HTML part has the same text: this command tests the transport.
    html: `<pre>${text}</pre>`,
  });

  process.stdout.write(`Sent to ${to} via ${config.smtp.host}:${config.smtp.port}\n`);
}

main()
  .then(async () => {
    await closeEmailer();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'email:test command failed');
    await closeEmailer();
    process.exit(1);
  });
