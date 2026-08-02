import type { AiAction } from '@tcf/shared';

/**
 * Global default prompts — the bottom of the resolution chain
 * (step override → model scope → project scope → global).
 *
 * Variables are substituted before the call: {{topic}}, {{persona}}, {{language}},
 * {{hashtags}}, {{style}}, {{existingTopics}}, {{count}}, {{postText}}, {{error}}.
 *
 * Anything these prompts ask for that *must* hold is also enforced in code —
 * a prompt is a request, not a guarantee. The SVG rules below are mirrored by
 * the sanitizer, and the caption length by the publisher.
 */
export const DEFAULT_PROMPTS: Record<AiAction, string> = {
  topics: `Ти — редактор Telegram-каналу. Персона автора:
{{persona}}

Запропонуй {{count}} нових тем для постів мовою {{language}}.

Вимоги:
- Теми конкретні й вузькі, а не оглядові. Не «Мікросервіси», а «Чому saga не рятує від
  часткових відмов у розподілених транзакціях».
- Кожна тема має давати матеріал на один пост, а не на цикл статей.
- Уникай тем, які дублюють уже наявні за змістом, навіть якщо формулювання інше.

Уже використані або заплановані теми:
{{existingTopics}}

Поверни JSON-масив обʼєктів із полями "title" (рядок) і "category" (рядок).`,

  post_text: `Ти пишеш пост для Telegram-каналу. Персона автора:
{{persona}}

Тема: {{topic}}
Мова: {{language}}

Структура:
1. Заголовок із доречним емодзі на початку.
2. Суть — коротке концептуальне пояснення, чому це взагалі важливо.
3. Компроміси: що виграємо, що втрачаємо, коли доречно, коли ні.
4. Хештеги наприкінці: {{hashtags}}

Правила:
- Пиши як практик для практиків: конкретно, без маркетингу й без «у сучасному світі».
- Жодних вигаданих цифр, бенчмарків чи цитат. Якщо потрібне число — уникай його.
- Дозволена розмітка Telegram HTML: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">.
  Ніяких <br>, <p>, <div> чи markdown.
- Тримайся в межах 1024 символів: більший текст доведеться відривати від зображення.

Поверни лише текст поста, без пояснень і без обгортки.`,

  svg: `Створи SVG-ілюстрацію до теми: {{topic}}

Стиль: {{style}}

Технічні вимоги:
- Рівно один кореневий <svg> з viewBox="0 0 1200 675", без width/height.
- Тло — світлий аркуш у клітинку (#f8fafc, сітка #e2e8f0).
- Малюнок імітує ескіз олівцем і чорною ручкою; акценти — напівпрозорі пастельні
  маркери (жовтий, блакитний, мʼятний).
- ЖОДНОГО тексту, літер чи цифр усередині графіки. Схема має читатися формою.
- Лише базові фігури, шляхи та групи. Без <script>, <foreignObject>, без зовнішніх
  посилань і без растрових зображень.

Поверни лише SVG-код, без пояснень і без markdown-огорожі.`,

  svg_repair: `Цей SVG не пройшов валідацію.

Помилка: {{error}}

SVG:
{{svgSource}}

Полагодь його, зберігши задум і стиль. Обмеження ті самі: один кореневий <svg>,
viewBox="0 0 1200 675", жодного тексту всередині, без <script>, <foreignObject>
та зовнішніх посилань.

Поверни лише виправлений SVG-код.`,

  image_prompt: `Склади промпт англійською для генеративної моделі зображень.

Ілюстрація супроводжує пост:
{{postText}}

Бажаний стиль: {{style}}

Вимоги до промпту:
- Опиши сцену, композицію та палітру; співвідношення сторін 16:9.
- Жодного тексту, написів чи цифр на зображенні — вкажи це явно.
- Без логотипів, брендів і впізнаваних реальних людей.

Поверни лише сам промпт одним абзацом.`,

  /**
   * The image action feeds a drawing model, whose input is the text produced by
   * `image_prompt`. This template exists only so the action has a resolvable
   * prompt like every other; `{{imagePrompt}}` is normally the whole content.
   */
  image: `{{imagePrompt}}`,
};

/** Style tokens injected as {{style}} when a project has not overridden them. */
export const DEFAULT_STYLE =
  'зошит у клітинку, ескіз олівцем і чорною ручкою, напівпрозорі пастельні маркери-хайлайтери';
