import { ensureDefaultChains } from './ai/chains.js';
import { authWarnings, env } from './config.js';
import { checkDatabase, closeDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { ensureStagingDir } from './media/staging.js';
import { ensureDefaultPrompts } from './prompts/resolve.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';

async function main() {
  for (const line of authWarnings()) logger.warn(line);

  if (!(await checkDatabase())) {
    logger.error(
      'Не вдалося підключитися до Postgres. Перевірте DATABASE_URL і що контейнер запущено (docker compose up -d db).',
    );
    process.exit(1);
  }

  if (env.AUTO_MIGRATE) {
    await runMigrations();
  }

  // Idempotent: existing rows are never overwritten, so operator edits survive
  // restarts while a fresh database still boots with a working configuration.
  await ensureStagingDir();
  await ensureDefaultPrompts();
  await ensureDefaultChains();

  startScheduler();

  const app = createApp();

  /*
   * A taken port is worth naming out loud. The usual cause is a container from
   * `docker compose up` still holding it, and the symptom otherwise is silent:
   * requests keep succeeding, served by the old process, while edits appear to
   * have no effect.
   */
  const server = app.listen(env.PORT, env.ADMIN_BIND_HOST, () => {
    logger.info(
      { host: env.ADMIN_BIND_HOST, port: env.PORT, authEnabled: env.ADMIN_AUTH_ENABLED },
      'admin server listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      // Let in-flight jobs finish before the pool releases the database.
      void stopScheduler()
        .catch((err: unknown) => logger.error({ err }, 'scheduler shutdown failed'))
        .then(() => closeDatabase())
        .finally(() => process.exit(0));
    });
    // Do not let a hung connection keep the process alive forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Порт ${env.PORT} уже зайнятий. Найчастіше це контейнер із «docker compose up» — ` +
          'зупиніть його (`docker compose stop app`) або змініть PORT. ' +
          'Інакше запити йтимуть у старий процес, і правки не діятимуть.',
      );
    } else {
      logger.error({ err }, 'HTTP server failed to start');
    }
    process.exit(1);
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
