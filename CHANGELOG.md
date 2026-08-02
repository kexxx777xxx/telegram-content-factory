# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/).

## [Unreleased]

### Added — фаза 0: скелет

- Монорепо на npm workspaces: `apps/server`, `apps/web`, `packages/shared`.
- Схема БД на 10 таблиць (Drizzle + PostgreSQL 16) з міграцією `0000_init`.
  Партіальні унікальні індекси: `jobs_dedupe_uniq` (ідемпотентність черги),
  `posts_slot_uniq` (захист від подвійного бронювання слоту),
  `topics_project_hash_uniq` (дедуп тем).
- Доменні енуми й zod-контракти в `packages/shared`, спільні для сервера й UI.
- Конфіг із zod-валідацією оточення: падає на старті з читабельним списком проблем.
- AES-256-GCM для секретів у БД, з версійним префіксом під майбутню ротацію ключа.
- Авторизація адмінки з перемикачем `ADMIN_AUTH_ENABLED`; вимкнення супроводжується
  warn у лозі та постійним червоним банером в UI.
- `GET /api/health`, `GET/POST/DELETE /api/session`.
- React SPA: екран входу, шапка зі станом БД, порожній стан.
- Docker: multi-stage образ, `docker compose up` піднімає стек і сам застосовує міграції.
- Документація: архітектура, шість ADR, runbook, API, промпти, журнал робіт, CLAUDE.md.

### Changed — відхилення від початкового плану

- npm workspaces замість pnpm (pnpm і corepack відсутні в оточенні) —
  [ADR 0006](docs/adr/0006-npm-workspaces-and-app-env.md).
- Конфіг у `app.env`, а не `.env`: Compose інтерполює `$` і псує argon2-хеш — той самий ADR.
- React 19 і Tailwind 4 замість React 18 з PRD — актуальні стабільні версії.
