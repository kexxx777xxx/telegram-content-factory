import type { AiAction } from './enums.js';

/**
 * Every `{{variable}}` a prompt can use, and where its value comes from.
 *
 * The list used to live in the web bundle as bare names. A name alone does not
 * answer the only question an operator actually has — «звідки це береться і що
 * буде, якщо поле порожнє» — so the origin is part of the record and the UI
 * renders a reference from it. Adding a variable to a prompt means adding it
 * here, otherwise it stays invisible to whoever edits that prompt next.
 */
export interface PromptVariable {
  name: string;
  /** What lands in place of the placeholder. */
  meaning: string;
  /** Which setting supplies it — the answer to «де це змінити». */
  source: string;
}

const PERSONA: PromptVariable = {
  name: 'persona',
  meaning: 'Хто пише і як — тон, погляд, межі теми.',
  source: 'Проєкт → Моделі і промпти → Голос каналу → Персона.',
};

const LANGUAGE: PromptVariable = {
  name: 'language',
  meaning: 'Код мови, якою пишеться результат.',
  source: 'Проєкт → Моделі і промпти → Голос каналу → Мова.',
};

const HASHTAGS: PromptVariable = {
  name: 'hashtags',
  meaning: 'Хештеги каналу через пробіл, кожен із решіткою.',
  source: 'Проєкт → Моделі і промпти → Голос каналу → Хештеги.',
};

const STYLE: PromptVariable = {
  name: 'style',
  meaning: 'Візуальна мова ілюстрацій.',
  source:
    'Проєкт → Голос каналу → Стиль ілюстрацій; порожнє поле бере глобальний стиль із Налаштувань.',
};

const TOPIC: PromptVariable = {
  name: 'topic',
  meaning: 'Тема поста — рядок із банку тем.',
  source: 'Банк тем проєкту (вкладка «Пости»); у тестовому запуску — приклад.',
};

export const PROMPT_VARIABLES: Record<AiAction, PromptVariable[]> = {
  topics: [
    PERSONA,
    LANGUAGE,
    {
      name: 'count',
      meaning: 'Скільки тем просити за один виклик.',
      source: 'Кнопка поповнення банку або планувальник (мінімум тем у буферах).',
    },
    {
      name: 'existingTopics',
      meaning: 'Уже наявні теми списком — щоб модель не повторювалась.',
      source: 'До 120 останніх тем проєкту, включно з опублікованими.',
    },
  ],
  post_text: [
    PERSONA,
    LANGUAGE,
    TOPIC,
    HASHTAGS,
    {
      name: 'maxChars',
      meaning: 'Цільова довжина поста у видимих символах.',
      source: 'Проєкт → Огляд → Публікація → Довжина поста.',
    },
  ],
  svg: [TOPIC, STYLE],
  svg_repair: [
    { name: 'error', meaning: 'Чому санітайзер відхилив схему.', source: 'Санітайзер SVG.' },
    { name: 'svgSource', meaning: 'Відхилений SVG цілком.', source: 'Попередня відповідь моделі.' },
  ],
  image_prompt: [
    {
      name: 'postText',
      meaning: 'Готовий текст поста без розмітки.',
      source: 'Результат дії «Текст поста».',
    },
    STYLE,
  ],
  image: [
    {
      name: 'imagePrompt',
      meaning: 'Промпт англійською, складений попередньою дією.',
      source: 'Результат дії «Промпт для зображення».',
    },
  ],
};
