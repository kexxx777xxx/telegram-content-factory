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

### `GET /api/projects`

Масив проєктів, відсортований за назвою. Токен бота — завжди маска (`···cdef`) або `null`.

### `POST /api/projects`

Тіло — `projectInputSchema`. Обовʼязкові лише `name`, `slug`, `telegramChannelId`; решта має
дефолти (`postsBuffer: 3`, `topicsBufferMin: 10`, `timezone: Europe/Kyiv`, розклад `09:00`/`18:00`).

`telegramBotToken` необовʼязковий, але якщо переданий — не коротший за 20 символів.
Дублікат `slug` → `409`.

### `GET /api/projects/:id`

### `PATCH /api/projects/:id`

Тіло — `projectUpdateSchema` (часткове). Дві навмисні особливості:

- **`slug` змінити не можна** — він фігурує в логах, ключах дедупу й іменах джоб. Поле просто
  ігнорується, а не викликає помилку.
- **`telegramBotToken: ""` означає «залишити збережений токен»**. Форма редагування ніколи не
  отримує справжній секрет, тож надсилає порожній рядок щоразу, коли редагуються інші поля.
  Будь-який непорожній рядок коротший за 20 символів — `400`.

Зміна `telegramChannelId` скидає закешований `telegramChannelUsername`: він належав старому каналу.

### `POST /api/projects/:id/verify-telegram`

Пробує канал ботом проєкту: `getMe` → `getChat` → `getChatMember`. Повертає `telegramCheckSchema`:

```json
{
  "ok": false,
  "bot": { "id": 123, "username": "my_bot", "firstName": "My Bot" },
  "chat": { "id": -1001234567890, "type": "channel", "title": "…", "username": "my_channel" },
  "canPost": false,
  "problems": ["Бот є адміністратором, але без права «Публікація повідомлень»."]
}
```

Завжди `200` — навіть коли перевірка не пройшла: результат діагностичний, а не помилка запиту.
Проєкт цілком легально може існувати до того, як бота додали в канал.

Права публікації перевіряються **тут**, а не при першій публікації: з буфером у 3 години інакше
проблема спливла б через півдня після налаштування.

Успішний `getChat` кешує `telegramChannelUsername` — саме він потім дає публічний
`t.me/name/123` замість непрозорого `t.me/c/…`.

### `DELETE /api/projects/:id`

`204`. Каскадом видаляє теми, пости та джоби проєкту.

## Заплановано

Зʼявиться у відповідних фазах; описується тут у міру реалізації.

| Маршрут | Фаза |
| --- | --- |
| `GET/POST /api/keys`, `GET /api/models` | 2 |
| `GET/PUT /api/projects/:id/prompts`, `/chains`, `POST /api/dry-run` | 2 |
| `GET/POST/DELETE /api/projects/:id/topics` | 3 |
| `GET /api/jobs`, `POST /api/jobs/:id/retry` | 4 |
| `GET/PATCH /api/projects/:id/posts` | 5 |
| `GET /api/posts/:id/image` | 6 |
| `POST /api/posts/:id/publish` | 7 |
| `GET /api/dashboard` | 9 |
