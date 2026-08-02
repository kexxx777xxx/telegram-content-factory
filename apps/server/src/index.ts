import { authWarnings, env } from './config.js';
import { checkDatabase, closeDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';

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

  const app = createApp();
  const server = app.listen(env.PORT, env.ADMIN_BIND_HOST, () => {
    logger.info(
      { host: env.ADMIN_BIND_HOST, port: env.PORT, authEnabled: env.ADMIN_AUTH_ENABLED },
      'admin server listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
    // Do not let a hung connection keep the process alive forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
