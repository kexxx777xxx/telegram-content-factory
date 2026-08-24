import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * All environment access happens here. Anything invalid fails at boot with a
 * readable message rather than surfacing as an undefined deep inside a worker.
 */

/**
 * Dev convenience: pull the repo-root `.env` in before validating. In the
 * container real environment variables are already set and no file exists, so
 * this is a no-op there. Existing variables always win — `loadEnvFile` does not
 * overwrite them.
 */
function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), 'app.env'),
    resolve(process.cwd(), '../../app.env'),
    resolve(process.cwd(), '../app.env'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) return;
  try {
    process.loadEnvFile(found);
  } catch {
    // Malformed file: fall through to schema validation, which reports properly.
  }
}

loadDotEnv();

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const int = (fallback: number, min = 0) =>
  z.coerce.number().int().min(min).default(fallback);

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'очікується 64 hex-символи (32 байти)');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL обовʼязковий'),

    PORT: int(3000, 1),
    ADMIN_BIND_HOST: z.string().default('127.0.0.1'),

    ADMIN_AUTH_ENABLED: bool(true),
    ADMIN_PASSWORD_HASH: z.string().default(''),
    SESSION_SECRET: z.string().default(''),

    APP_ENCRYPTION_KEY: hex32,

    MEDIA_STAGING_DIR: z.string().default('./data/media'),

    /** Apply pending migrations on boot so a fresh `docker compose up` just works. */
    AUTO_MIGRATE: bool(true),

    WORKER_CONCURRENCY: int(4, 1),
    PLANNER_TICK_SECONDS: int(60, 5),
    PUBLISHER_TICK_SECONDS: int(30, 5),

    EVENT_RETENTION_DAYS: int(30, 0),
    JOB_RETENTION_DAYS: int(7, 0),
    POST_TEXT_RETENTION_DAYS: int(0, 0),
    STAGING_ORPHAN_HOURS: int(2, 1),

    ADMIN_BOT_TOKEN: z.string().default(''),
    ADMIN_USER_IDS: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.ADMIN_AUTH_ENABLED) {
      if (!env.ADMIN_PASSWORD_HASH) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_PASSWORD_HASH'],
          message:
            'ADMIN_AUTH_ENABLED=true вимагає ADMIN_PASSWORD_HASH (npm run -w @tcf/server hash-password -- "пароль")',
        });
      }
      if (env.SESSION_SECRET.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'SESSION_SECRET має бути щонайменше 32 символи',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
    // Thrown before the logger exists, so plain stderr is the only channel.
    console.error(`\nНекоректна конфігурація оточення:\n${lines.join('\n')}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

/**
 * Reported by `/api/health`. Read here rather than at the call site so this
 * stays the only module touching `process.env` — `npm_package_version` is set
 * by npm when it runs the process and is absent under a bare `node`, hence the
 * fallback.
 */
export const version: string = process.env.npm_package_version ?? '0.1.0';

export const config = {
  env,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  /** Telegram user ids allowed to press approval buttons. */
  adminUserIds: env.ADMIN_USER_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  adminBotEnabled: env.ADMIN_BOT_TOKEN.length > 0,
  retention: {
    eventDays: env.EVENT_RETENTION_DAYS,
    jobDays: env.JOB_RETENTION_DAYS,
    postTextDays: env.POST_TEXT_RETENTION_DAYS,
    stagingOrphanHours: env.STAGING_ORPHAN_HOURS,
  },
} as const;

/**
 * Disabling auth is legitimate (local dev, or the app sits behind VPN /
 * Cloudflare Access) but must never happen quietly — the admin UI holds bot
 * tokens and API keys. Returns the warning lines so the caller can log them
 * once the logger is up.
 */
export function authWarnings(): string[] {
  if (env.ADMIN_AUTH_ENABLED) return [];
  const warnings = [
    'АВТОРИЗАЦІЯ АДМІНКИ ВИМКНЕНА (ADMIN_AUTH_ENABLED=false).',
    'Будь-хто, хто дістанеться до порту, отримає доступ до бот-токенів і API-ключів.',
  ];
  if (env.ADMIN_BIND_HOST !== '127.0.0.1' && env.ADMIN_BIND_HOST !== 'localhost') {
    warnings.push(
      `НЕБЕЗПЕЧНО: auth вимкнено І сервер слухає на ${env.ADMIN_BIND_HOST}, а не на loopback.`,
    );
  }
  return warnings;
}
