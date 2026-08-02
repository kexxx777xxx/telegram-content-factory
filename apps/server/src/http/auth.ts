import argon2 from 'argon2';
import type { NextFunction, Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { logger } from '../logger.js';

/**
 * Admin authentication, switchable by `ADMIN_AUTH_ENABLED`.
 *
 * With auth off the middleware is a pass-through — a legitimate setup when the
 * app runs on loopback or already sits behind VPN / Cloudflare Access. It is
 * never silent: the boot logs a warning block and `/api/health` reports
 * `authEnabled: false`, which the UI renders as a permanent banner.
 */

const COOKIE_NAME = 'tcf_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  issuedAt: number;
  nonce: string;
}

function sign(value: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('base64url');
}

function issueToken(): string {
  const payload: SessionPayload = { issuedAt: Date.now(), nonce: randomBytes(16).toString('base64url') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    return Date.now() - payload.issuedAt < SESSION_TTL_MS;
  } catch {
    return false;
  }
}

export async function verifyPassword(password: string): Promise<boolean> {
  try {
    return await argon2.verify(env.ADMIN_PASSWORD_HASH, password);
  } catch (err) {
    logger.warn({ err }, 'password verification failed');
    return false;
  }
}

export function setSessionCookie(res: Response): void {
  res.cookie(COOKIE_NAME, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function isAuthenticated(req: Request): boolean {
  if (!env.ADMIN_AUTH_ENABLED) return true;
  return verifyToken(req.cookies?.[COOKIE_NAME] as string | undefined);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * Double-submit CSRF guard on state-changing requests. Only meaningful while
 * auth is on — without a session cookie there is nothing to ride on.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!env.ADMIN_AUTH_ENABLED || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    try {
      if (new URL(origin).host !== host) {
        res.status(403).json({ error: 'cross-origin request rejected' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'malformed origin' });
      return;
    }
  }
  next();
}
