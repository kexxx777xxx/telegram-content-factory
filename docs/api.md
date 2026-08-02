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

### `GET/POST/PATCH/DELETE /api/keys`

Ключі провайдерів. Секрет шифрується AES-256-GCM; назовні — маска.
`PATCH` із `secret: ""` означає «залишити збережений» — той самий контракт, що й для бот-токенів.

Обмеження: `scope: 'project'` вимагає `projectId`, `scope: 'global'` — забороняє його.
Один проєктний ключ на провайдера (`409` на другий), щоб ланцюжок не гадав, який із двох брати.

DTO містить `usageToday` і `blockedModels` — тиск на бюджет і відкриті запобіжники видно
до того, як вони зірвуть слот.

### `POST /api/keys/:id/verify`

Читає каталог моделей цим ключем. Дешево й відповідає на єдине питання, що має значення при
налаштуванні: чи ключ узагалі приймуть.

### `GET /api/models`

Каталог від провайдера, кеш на годину, `?refresh=true` — примусово.

**ID моделей ніколи не хардкодяться.** У PRD фігурував `gemini-3.0-flash`, якого в каталозі
не існує — захардкоджений ланцюжок упав би на першому ж слоті з незрозумілим 404.

`409`, якщо немає жодного активного ключа.

### `GET /api/config/generation?projectId=<uuid>`

Ефективна конфігурація всіх пʼяти дій. Без `projectId` — глобальні дефолти.

Кожен запис несе `chainInherited` і `promptInherited`: саме з них UI малює бейдж
«Успадковано з глобальних», а не здогадується.

### `PUT /api/config/generation/:action?projectId=<uuid>`

Тіло: `{ steps?, promptBody? }`. `steps` замінюють ланцюжок цілком (редактор завжди надсилає
повний порядок). `promptBody` створює **нову версію** — наявний рядок не мутується, бо
опубліковані пости посилаються на конкретну версію.

### `DELETE /api/config/generation/:action?projectId=<uuid>&chain=&prompt=`

Прибирає override проєкту, повертаючи глобальну конфігурацію.

### `POST /api/projects/:id/dry-run`

Тіло: `{ action, model?, variables? }`. Виконує **справжній** виклик, нічого не зберігає.
`model` обмежує запуск однією моделлю замість усього ланцюжка.

Повертає не лише текст, а весь слід спроб:

```json
{
  "ok": true,
  "text": "…",
  "model": "gemini-3.5-flash-lite",
  "promptScope": "project",
  "promptVersion": 1,
  "usage": { "inputTokens": 329, "outputTokens": 374 },
  "attempts": [
    { "position": 0, "model": "gemini-3.5-flash", "keyLabel": "Global Gemini",
      "keyScope": "global", "outcome": "skipped",
      "detail": "Пара «ключ + модель» заблокована після 429", "retryAt": "…" },
    { "position": 1, "model": "gemini-3.5-flash-lite", "keyLabel": "Global Gemini",
      "keyScope": "global", "outcome": "success", "durationMs": 2248 }
  ],
  "error": null,
  "renderedPrompt": "…"
}
```

Слід спроб — головна частина відповіді: коли ланцюжок поводиться не так, корисне питання не
«що вийшло», а «який крок відповів і чому мовчали попередні».

Завжди `200`: вичерпаний ланцюжок — це діагностика, а не помилка запиту. У `error` тоді
вказано найранішій час, коли щось може спрацювати знову.

### `GET /api/projects/:id/topics`

Теми проєкту (до 500, найновіші перші) + лічильники.

```json
{ "topics": [...], "counts": { "fresh": 19, "queued": 0, "used": 0, "rejected": 0, "total": 19 } }
```

`fresh` і `queued` розділені навмисно: тема в статусі `queued` уже закріплена за постом, що
готується. Якби поріг поповнення рахував їх разом, банк міг би вичерпатись у момент, коли всі
рядки вже роздані.

### `POST /api/projects/:id/topics/import`

Тіло: `{ "text": "..." }` — одна тема на рядок, необовʼязково `Категорія | Назва`,
маркери списку (`-`, `*`, `•`) зрізаються.

Дублікати не валять імпорт: вони рахуються й повертаються в `duplicates`.

### `POST /api/projects/:id/topics/replenish`

Тіло: `{ "count": 20 }`. Запитує теми в моделі через ланцюжок `topics` зі structured output.
Наявні назви йдуть у промпт, щоб модель уникала повторів за змістом.

Повертає `{ requested, generated, inserted, duplicates, titles, model }`.
`409`, якщо ланцюжок не налаштований або вичерпаний — з причиною в тексті.

### `PATCH /api/topics/:topicId`

Тіло: `{ "status": "new|queued|used|rejected" }`.

### `POST /api/topics/delete`

Тіло: `{ "ids": [...] }` → `{ "removed": n }`.

## Заплановано

Зʼявиться у відповідних фазах; описується тут у міру реалізації.

| Маршрут | Фаза |
| --- | --- |
| `GET /api/jobs`, `POST /api/jobs/:id/retry` | 4 |
| `GET/PATCH /api/projects/:id/posts` | 5 |
| `GET /api/posts/:id/image` | 6 |
| `POST /api/posts/:id/publish` | 7 |
| `GET /api/dashboard` | 9 |
