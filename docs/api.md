# HTTP API

Базовий шлях — `/api`. Контракти описані zod-схемами в `packages/shared/src/schemas.ts`; цей
документ описує маршрути й коди.

Автентифікація — сесійна кука `tcf_session` (httpOnly, `SameSite=Lax`). Коли
`ADMIN_AUTH_ENABLED=false`, усі маршрути відкриті, а `GET /api/session` повертає
`authenticated: true`.

На мутаціях діє перевірка `Origin` (double-submit CSRF), тому запити з іншого походження
відхиляються з `403`.

## Загальні коди

| Код | Коли |
| --- | --- |
| `400` | тіло не пройшло zod-валідацію |
| `401` | немає або протухла сесія |
| `403` | крос-оріджин мутація |
| `404` | немає такого ресурсу |
| `429` | ліміт спроб входу |
| `500` | необроблена помилка (деталі — тільки в лог) |

Тіло помилки завжди `{ "error": "<повідомлення українською>" }`.

## Реалізовано

### `GET /api/health`

Без авторизації — це і проба контейнера, і джерело для банера в UI.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": "up",
  "authEnabled": true,
  "time": "2026-08-02T14:08:18.070Z"
}
```

`status` = `degraded`, якщо `database` = `down`.

### `GET /api/session`

```json
{ "authenticated": false, "authEnabled": true }
```

### `POST /api/session`

Тіло: `{ "password": "…" }`. Успіх ставить куку і повертає
`{ "authenticated": true, "authEnabled": true }`.

Ліміт: 10 спроб на 15 хвилин з IP.

### `DELETE /api/session`

Скидає куку.

## Заплановано

Зʼявиться у відповідних фазах; описується тут у міру реалізації.

| Маршрут | Фаза |
| --- | --- |
| `GET/POST/PATCH/DELETE /api/projects` | 1 |
| `POST /api/projects/:id/verify-telegram` | 1 |
| `GET/POST /api/keys`, `GET /api/models` | 2 |
| `GET/PUT /api/projects/:id/prompts`, `/chains`, `POST /api/dry-run` | 2 |
| `GET/POST/DELETE /api/projects/:id/topics` | 3 |
| `GET /api/jobs`, `POST /api/jobs/:id/retry` | 4 |
| `GET/PATCH /api/projects/:id/posts` | 5 |
| `GET /api/posts/:id/image` | 6 |
| `POST /api/posts/:id/publish` | 7 |
| `GET /api/dashboard` | 9 |
