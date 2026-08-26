import express from 'express';
import { config } from './config.js';
import { consoleRouter, stripeWebhookRouter } from './console/routes.js';
import { disconnectPrisma } from './db/prisma.js';
import { closeEmailer } from './lib/email.js';
import { httpLogger, logger } from './lib/logger.js';
import { logStripeConfiguration } from './console/stripe.js';
import { flushSourceCalls } from './api/sources/live/europe-vies.js';
import { startUsageFlusher, stopUsageFlusher } from './services/usage.js';

/**
 * The developer console.
 *
 * A separate Express process from the API: the API authenticates with a header and must never see
 * a session cookie, and the console authenticates with a cookie and should not live on the API's
 * origin. Two hosts, two processes, one database.
 *
 * The browser only talks to this origin, so there is no CORS, and verification and reset links
 * land on the host that reads the session cookie.
 */
export function createConsoleApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // `TRUST_PROXY_HOPS`: 0 in development. In production it must match the real hop count: `true`
  // would let a client spoof req.ip and bypass per-IP limits.
  app.set('trust proxy', config.trustProxyHops);
  app.use(httpLogger());
  // Before the body parser: Stripe's signature covers the exact bytes it sent.
  app.use(stripeWebhookRouter);
  app.use(express.urlencoded({ extended: false }));
  app.use(consoleRouter);

  app.use((_req, res) => {
    res.status(404).type('text').send('Not found');
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: error }, 'console request failed');
    res.status(500).type('text').send('Something went wrong on our side.');
  });

  return app;
}

// The console charges for queuing async lookups, and the quota counter lives in memory and is
// flushed on a timer. Without starting the flusher, usage would never be saved.
startUsageFlusher();

const server = createConsoleApp().listen(config.console.port, () => {
  logger.info({ port: config.console.port, baseUrl: config.console.baseUrl }, 'vatlas console listening');
  // Log the Stripe configuration at startup.
  logStripeConfiguration();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      // Flush pending source call logs before disconnecting Prisma, and the usage counter too (it exists
      // nowhere else).
      void flushSourceCalls()
        .then(() => stopUsageFlusher())
        .then(() => Promise.all([closeEmailer(), disconnectPrisma()]))
        .then(() => process.exit(0));
    });
  });
}
