import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { env } from '../config.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';

/**
 * A single pool serves the HTTP layer, the scheduler ticks and the worker pool.
 * `max` leaves headroom above WORKER_CONCURRENCY so a saturated queue can never
 * starve the admin UI of connections.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Math.max(10, env.WORKER_CONCURRENCY + 6),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client errored');
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;

export async function checkDatabase(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch (err) {
    logger.error({ err }, 'database health check failed');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
