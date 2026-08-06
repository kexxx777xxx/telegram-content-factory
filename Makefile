# Одна команда на кожну роботу. Все, що довше за один рядок, живе тут, а не в
# конвенціях і не в голові: інструкція з чотирьох кроків виконується частково,
# ціль — ні.

DEV := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: check up down logs migration

## Перед комітом. Тести потребують бази, тож вона піднімається сама.
check:
	docker compose up -d db
	npm run typecheck
	npm test
	@git diff --cached --name-only | grep -qE '^(app\.env$$|.*\.(key|pem|dump|sql\.gz)$$)' \
		&& { echo '!! секрет або дамп у індексі — прибрати перед комітом'; exit 1; } || true

## Усе в докері: перевірки, збірка, міграції (їх застосовує сам контейнер), старт.
up: check
	$(DEV) up -d --build
	@echo 'api → http://127.0.0.1:3000   web → http://127.0.0.1:5173'

down:
	$(DEV) down

logs:
	$(DEV) logs -f app

## Після зміни schema.ts — див. «Міграції» в AGENTS.md.
migration:
	npm run db:generate
