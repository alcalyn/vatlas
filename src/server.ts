import express from 'express';
import { config } from './config.js';
import { router } from './api/routes.js';
import { errorHandler } from './api/errors.js';
import { closePool } from './db/pool.js';
import { disconnectPrisma } from './db/prisma.js';
import { startUsageFlusher, stopUsageFlusher } from './services/usage.js';
import { flushSourceCalls } from './api/sources/live/europe-vies.js';
import { httpLogger, logger } from './lib/logger.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // `TRUST_PROXY_HOPS`: 0 in development. In production it must match the real hop count: `true`
  // would let a client spoof req.ip and bypass the per-IP demo limit.
  app.set('trust proxy', config.trustProxyHops);
  app.use(httpLogger());
  app.use(express.json());
  app.use(router);
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
  });
  app.use(errorHandler);

  return app;
}

startUsageFlusher();

const server = createApp().listen(config.port, () => {
  logger.info({ port: config.port }, 'vatlas listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      // Flush the usage counter first, awaited: it exists nowhere else. Pending source call logs are
      // flushed too, since lookups do not wait for them.
      void stopUsageFlusher()
        .then(() => flushSourceCalls())
        .then(() => Promise.all([closePool(), disconnectPrisma()]))
        .then(() => process.exit(0));
    });
  });
}
