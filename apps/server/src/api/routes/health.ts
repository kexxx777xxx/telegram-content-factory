import { Router } from 'express';
import { env } from '../../config.js';
import { checkDatabase } from '../../db/client.js';

export const healthRouter: Router = Router();

/**
 * Unauthenticated on purpose: it is the container health probe, and the web app
 * reads `authEnabled` from it to decide whether to show the "auth is off" banner
 * before any session exists.
 */
healthRouter.get('/health', async (_req, res) => {
  const database = (await checkDatabase()) ? 'up' : 'down';
  res.json({
    status: database === 'up' ? 'ok' : 'degraded',
    version: process.env.npm_package_version ?? '0.1.0',
    database,
    authEnabled: env.ADMIN_AUTH_ENABLED,
    time: new Date().toISOString(),
  });
});
