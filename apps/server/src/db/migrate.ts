import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger.js';
import { closeDatabase, db } from './client.js';

/**
 * The drizzle migrator reads SQL from disk at runtime, so the folder has to be
 * located rather than imported. Candidates cover both the dev layout (cwd is
 * apps/server) and the container layout (cwd is the repo root).
 */
function findMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(process.cwd(), 'src/db/migrations'),
    resolve(process.cwd(), 'apps/server/src/db/migrations'),
  ].filter((c): c is string => Boolean(c));

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `Не знайдено теку міграцій. Перевірені шляхи:\n${candidates.map((c) => `  • ${c}`).join('\n')}`,
    );
  }
  return found;
}

/**
 * Also called on boot (see `AUTO_MIGRATE`) so `docker compose up` works on a
 * clean volume without a separate migration step. Drizzle takes its own lock in
 * the migrations table, so a concurrent second instance waits rather than races.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = findMigrationsFolder();
  logger.info({ migrationsFolder }, 'applying migrations');
  await migrate(db, { migrationsFolder });
  logger.info('migrations applied');
}

/** Standalone entry point: `npm run db:migrate`. */
async function main() {
  await runMigrations();
  await closeDatabase();
}

const isDirectRun =
  process.argv[1]?.includes('migrate') ?? false;

if (isDirectRun) {
  main().catch(async (err) => {
    logger.error({ err }, 'migration failed');
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
}
