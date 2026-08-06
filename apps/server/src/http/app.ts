import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generationRouter } from '../api/routes/generation.js';
import { healthRouter } from '../api/routes/health.js';
import { jobsRouter } from '../api/routes/jobs.js';
import { keysRouter } from '../api/routes/keys.js';
import { postsRouter } from '../api/routes/posts.js';
import { projectsRouter } from '../api/routes/projects.js';
import { sessionRouter } from '../api/routes/session.js';
import { ideasRouter } from '../api/routes/ideas.js';
import { config, env } from '../config.js';
import { logger } from '../logger.js';
import { csrfGuard, requireAuth } from './auth.js';

/**
 * Located rather than imported so the same code works from `tsx` in dev (cwd is
 * apps/server) and from the CJS bundle in the container (cwd is the repo root).
 */
function findWebDist(): string | null {
  const candidates = [
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // The admin UI renders model-generated SVG inline; the sanitizer (phase 6)
      // is the real defence, CSP is the second layer.
      contentSecurityPolicy: config.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: ["'self'", 'data:', 'blob:'],
              styleSrc: ["'self'", "'unsafe-inline'"],
              scriptSrc: ["'self'"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser(env.SESSION_SECRET || 'dev-unused'));

  // Unauthenticated: probes and login.
  app.use('/api', healthRouter);
  app.use('/api', csrfGuard, sessionRouter);

  // Everything else behind the (optionally disabled) auth wall. Express 5
  // forwards rejected promises to the error handler, so route handlers throw.
  const api = express.Router();
  api.use(requireAuth, csrfGuard);
  api.use(projectsRouter);
  api.use(keysRouter);
  api.use(generationRouter);
  api.use(ideasRouter);
  api.use(jobsRouter);
  api.use(postsRouter);
  app.use('/api', api);

  // Built SPA, when present. In dev the Vite server owns this and proxies /api.
  const webDist = findWebDist();
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.path }, 'unhandled request error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
