# Telegram Content Factory

Мультипроєктна система автогенерації та публікації контенту в Telegram. Веде кілька каналів
одночасно: у кожного власний банк тем, голос, розклад, ланцюжок моделей і промпти.

Цикл: **тема → текст → зображення → публікація**, усе через AI.

## Стан

Фаза 0 з 10 — скелет. Працює: база зі схемою й міграціями, конфіг, авторизація адмінки з
перемикачем, health, збірка й запуск у docker. Генерації та публікації ще немає.

## Швидкий старт

```bash
cp app.env.example app.env
```

Заповнити `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD_HASH` — команди в
[docs/runbook.md](docs/runbook.md).

```bash
docker compose up -d
```

Адмінка на `http://127.0.0.1:3000`. Міграції застосовуються самі.

Для розробки:

```bash
docker compose up -d db && npm run db:migrate && npm run dev
```

## Структура

```
apps/server      Express API, планувальник, воркери, інтеграції
apps/web         React SPA (адмінка)
packages/shared  спільні zod-схеми та доменні енуми
docs/            архітектура, ADR, runbook, журнал робіт
```

## Ключові рішення

| Рішення | Чому |
| --- | --- |
| [PostgreSQL замість JSON](docs/adr/0001-postgres-instead-of-json-file.md) | кілька воркерів, транзакції, часткові індекси |
| [Після публікації лишається лінк](docs/adr/0002-telegram-as-content-store.md) | Telegram і є архівом; БД лишається малою |
| [429 рахується на ключ](docs/adr/0003-rate-limit-per-key.md) | приналежність ключів до акаунту ззовні не визначити |
| [Буфер постів, нуль дозволено](docs/adr/0004-buffered-generation-with-zero.md) | слот публікації не має залежати від моделі |
| [Черга в Postgres](docs/adr/0005-postgres-queue-no-redis.md) | одна транзакція на джобу і домен, без брокера |

## Документація

- [Архітектура](docs/architecture.md)
- [Runbook](docs/runbook.md) — деплой, env, бекап, інциденти
- [API](docs/api.md)
- [Промпти](docs/prompts.md)
- [Журнал робіт](docs/worklog/)
- [CLAUDE.md](CLAUDE.md) — конвенції репозиторію
