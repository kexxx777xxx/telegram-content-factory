import pg from 'pg';

/**
 * Creates and migrates a dedicated test database.
 *
 * Separate from the development one on purpose: these suites truncate tables
 * between cases, and pointing them at a database someone is also clicking
 * through would be a memorable way to lose a demo project.
 */
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://tcf:tcf@localhost:5432/postgres';
const TEST_DB = process.env.TEST_DB_NAME ?? 'tcf_test';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://tcf:tcf@localhost:5432/${TEST_DB}`;

export async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const exists = await admin.query('select 1 from pg_database where datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) {
    await admin.query(`create database ${TEST_DB}`);
  }
  await admin.end();

  // The app reads DATABASE_URL through config.ts, which is imported once per
  // process; setting it here means every suite connects to the test database.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_AUTH_ENABLED = 'false';
  process.env.APP_ENCRYPTION_KEY ??= 'a'.repeat(64);
  process.env.ADMIN_BOT_TOKEN = '';
  process.env.MEDIA_STAGING_DIR = './data/test-media';

  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();

  const { closeDatabase } = await import('../src/db/client.js');
  await closeDatabase();
}
