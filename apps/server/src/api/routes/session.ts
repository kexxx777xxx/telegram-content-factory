import { loginSchema } from '@tcf/shared';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config.js';
import { logger } from '../../logger.js';
import {
  clearSessionCookie,
  isAuthenticated,
  setSessionCookie,
  verifyPassword,
} from '../../http/auth.js';

export const sessionRouter: Router = Router();

/** Brute force on a single shared password is the whole attack surface here. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Забагато спроб входу, спробуйте пізніше' },
});

sessionRouter.get('/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req), authEnabled: env.ADMIN_AUTH_ENABLED });
});

sessionRouter.post('/session', loginLimiter, async (req, res) => {
  if (!env.ADMIN_AUTH_ENABLED) {
    res.json({ authenticated: true, authEnabled: false });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Потрібен пароль' });
    return;
  }

  if (!(await verifyPassword(parsed.data.password))) {
    logger.warn({ ip: req.ip }, 'failed admin login');
    res.status(401).json({ error: 'Невірний пароль' });
    return;
  }

  setSessionCookie(res);
  res.json({ authenticated: true, authEnabled: true });
});

sessionRouter.delete('/session', (_req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});
