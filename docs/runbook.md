# Runbook

## Перший запуск

```bash
cp app.env.example app.env
```

Згенерувати обовʼязкові секрети:

```bash
node -e "console.log('APP_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
```

```bash
npm run -w @tcf/server hash-password -- 'ваш-пароль'
```

Вставити результати в `app.env` (`APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD_HASH`).

> `APP_ENCRYPTION_KEY` шифрує бот-токени й API-ключі. **Втрата ключа = втрата всіх секретів**
> у базі; їх доведеться вводити заново. Зберігати окремо від бекапу БД.

> Зміна `ADMIN_PASSWORD_HASH` розлогінює всіх: ключ підпису сесій виводиться з нього разом із
> `SESSION_SECRET`. Це і є спосіб відкликати сесії — токени самодостатні, серверного списку, з
> якого їх можна було б викинути, немає. Після підозри на витік куки міняти пароль, а не лише
> `SESSION_SECRET`.

## Продакшн

```bash
docker compose up -d
```

Міграції застосовуються на старті (`AUTO_MIGRATE=true`), тож чистий том працює без окремого кроку.
Адмінка — на `127.0.0.1:3000`; назовні виставляти тільки через reverse proxy з TLS.

## Локальна розробка

**Рекомендований спосіб — тільки база в докері, код на хості.** Найшвидший цикл: `tsx watch`
перезапускає сервер за секунду, Vite оновлює браузер без перезавантаження, перезбірки немає взагалі.

```bash
docker compose up -d db
```

```bash
npm run db:migrate && npm run dev
```

Server на `:3000`, Vite на `:5173` з проксі `/api`. Відкривати `http://localhost:5173`
(Vite слухає на `::1`, тому `127.0.0.1:5173` не відповість).

### Якщо треба все в докері

> **Сервіс `app` у базовому `docker-compose.yml` — продакшн-образ: код у нього запікається під
> час збірки.** Саме тому після кожної правки довелось би робити `docker compose build app`.
> Для розробки він не призначений.

Оверлей монтує вихідники всередину контейнера й запускає `tsx watch` — перезбірка більше не
потрібна:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Перший запуск збирає образ, далі правки підхоплюються так само, як на хості.
`node_modules` лишається контейнерним — нативні модулі (`sharp`, `argon2`, `resvg`) зібрані під
його платформу, і підмінити їх хостовими означало б зламати рендер.

## Змінні оточення

Повний перелік із коментарями — в `app.env.example`. Ті, що найчастіше плутають:

| Змінна | Що робить |
| --- | --- |
| `ADMIN_AUTH_ENABLED` | `false` вимикає логін повністю. Лог пише warn, UI показує червоний банер |
| `ADMIN_BIND_HOST` | дефолт `127.0.0.1`. Змінювати тільки за проксі й **ніколи** разом із вимкненим auth |
| `APP_ENCRYPTION_KEY` | 64 hex-символи. Змінити = зробити наявні секрети нечитними |
| `POST_TEXT_RETENTION_DAYS` | `0` = стирати текст одразу при публікації (дефолт) |
| `AUTO_MIGRATE` | застосовувати міграції на старті |
| `ADMIN_BOT_TOKEN` | порожній = адмін-бот вимкнено; `publish_mode=auto` працює без нього |

> **Чому `app.env`, а не `.env`.** Compose автозавантажує `.env` і інтерполює `$` у значеннях,
> через що argon2-хеш приїжджає понівеченим. Див.
> [ADR 0006](adr/0006-npm-workspaces-and-app-env.md). Не перейменовувати назад.

## Бекап і відновлення

```bash
docker compose exec -T db pg_dump -U tcf tcf | gzip > backup-$(date +%F).sql.gz
```

```bash
gunzip -c backup-2026-08-02.sql.gz | docker compose exec -T db psql -U tcf -d tcf
```

Том `media_staging` бекапити **не треба**: там лише зображення постів, що ще чекають слоту, і вони
відновлюються перегенерацією. Опубліковане живе в Telegram.

Бекап без `APP_ENCRYPTION_KEY` марний — токени й ключі не розшифруються.

## Типові інциденти

**Канал пропустив слот.** Дивитись глибину буфера проєкту. Якщо `posts_buffer = 0` — це JIT-режим,
слот залежав від моделі в момент публікації; або збільшити буфер, або дивитись `rate_limit_state`.

**Пости не генеруються ні в кого.** Перевірити `rate_limit_state`: чи не заблоковані всі пари
`(ключ, модель)`.

```bash
docker compose exec -T db psql -U tcf -d tcf -c "select api_key_id, model, blocked_until, requests_used from rate_limit_state where blocked_until > now();"
```

**Джоби копичаться.** Подивитись чергу:

```bash
docker compose exec -T db psql -U tcf -d tcf -c "select type, status, count(*) from jobs group by 1,2 order by 3 desc;"
```

`status = 'dead'` означає вичерпані `max_attempts` — дивитись `last_error`.

**Пароль не підходить після зміни конфігу.** Майже завжди це інтерполяція `$` у хеші. Перевірити,
що прийшло в контейнер:

```bash
docker compose exec -T app printenv ADMIN_PASSWORD_HASH
```

**Сервер зник без сліду під час генерації.** Найімовірніше — паніка в нативному рендерері SVG:
модель віддала схему з фільтром (`feDisplacementMap` та подібні), resvg зробив assert у Rust, а
паніка в аддоні вбиває процес Node цілком. Санітайзер вирізає фільтри саме тому. У логах це
виглядає як `thread '<unnamed>' panicked` і `fatal runtime error` без жодного стектрейсу Node.

**Пост завис у `generating`.** Воркер помер посеред генерації. Публікація його не візьме, а
генерація відмовиться стартувати з цього статусу. Publisher tick повертає такі пости в `planned`
через 20 хвилин; вручну:

```bash
docker compose exec -T db psql -U tcf -d tcf -c "update posts set status='planned' where status='generating' and updated_at < now() - interval '20 minutes';"
```

**Batch-джоби зависли.** Вони самі скасовуються після власного дедлайну, але подивитись стан:

```bash
docker compose exec -T db psql -U tcf -d tcf -c "select action, model, state, deadline, provider_name from batch_jobs order by created_at desc limit 20;"
```

Джоба черги, що чекає на batch, стоїть у `pending` з `last_error = 'Теми замовлені через batch…'`
і перевіряється раз на 15 хвилин. Це нормальний стан, а не збій.

**Лог поста розрісся.** Він вмикається на проєкт і зберігає повні промпти й відповіді. Розмір:

```bash
docker compose exec -T db psql -U tcf -d tcf -c "select p.name, count(*), pg_size_pretty(sum(length(coalesce(l.detail,'')))::bigint) from logs l join projects p on p.id=l.project_id group by 1;"
```

Прибирається щоденним `prune` за `log_retention_days` проєкту; вимикається перемикачами на
вкладці «Генерація».

**Джоби виконуються із затримкою в кілька секунд без причини.** Перевірити розбіжність
годинників хоста й контейнера з базою — черга живе за годинником бази:

```bash
docker compose exec -T db psql -U tcf -d tcf -tc "select now();" && date -u
```

**Застрягла джоба в `running`.** Воркер помер, не знявши лок. Перевірити `locked_at`; джоби,
старші за таймаут, підбирає reaper (фаза 4).

## Тести

```bash
docker compose up -d db && npm test
```

92 тести у чотирьох наборах. Інтеграційні йдуть проти **справжнього** Postgres у власній базі
`tcf_test` — вона створюється й мігрується автоматично. Мокати драйвер сенсу немає: майже всі
гарантії системи це і є фічі Postgres (`SKIP LOCKED`, часткові унікальні індекси, advisory locks),
а мок підтверджував би лише сам себе.

| Набір | Що покриває |
| --- | --- |
| `test/pure.test.ts` | санітайзери HTML і SVG, нормалізація тем, слоти з DST, permalink, backoff, розбиття довгого поста |
| `test/db.test.ts` | claim під конкуренцією, дедуп, reschedule, лімітер, успадкування промптів, банк тем |
| `test/publish.test.ts` | відправка фото + тексту з підробним Bot API: обрив між частинами і відновлення без дублю |
| `test/load.test.ts` | 50 проєктів на одному слоті з підробним провайдером і керованим 429 |

Навантажувальний набір — головна перевірка «не захлинутись». Він підміняє Gemini на `FakeProvider`,
тож прогін детермінований, безкоштовний і дозволяє видати 429 на вимогу — те, що на живому API
можна зробити лише реально вичерпавши квоту.

Що він доводить:

- планування 50 проєктів ідемпотентне, слот не бронюється двічі;
- старти генерації рознесені (без зсуву на проєкт усі 150 джоб мали б однаковий `run_after`);
- вичерпана модель не отримує тиску: до `WORKER_CONCURRENCY` запитів замість усіх 30;
- буфер усе одно наповнюється з наступної моделі ланцюжка;
- коли недоступні **всі** моделі, джоби паркуються з `attempts = 0` і майбутнім `run_after`,
  а пул повертається одразу — не спить на стіні;
- після закриття вікна квоти все доганяється.

## Оновлення

```bash
docker compose build app && docker compose up -d app
```

Міграції застосуються на старті. Відкат схеми не автоматизований — відкочувати з бекапу.
