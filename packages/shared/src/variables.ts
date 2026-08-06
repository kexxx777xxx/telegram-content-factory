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

/**
 * Available in **every** action, because they describe the channel rather than
 * one step of the pipeline.
 *
 * They are passed on every call (`prompts/variables.ts` on the server), so an
 * illustration prompt may speak about the persona and a topic prompt may use
 * the post length. Previously each call site passed only what its own default
 * prompt happened to mention, and anything else rendered as an empty string —
 * a reference listing those few would have described the defaults, not what is
 * possible.
 */
export const COMMON_VARIABLES: PromptVariable[] = [
  {
    name: 'persona',
    meaning: 'Хто пише і як — тон, погляд, межі теми.',
    source: 'Проєкт → Моделі і промпти → Голос каналу → Персона.',
  },
  {
    name: 'language',
    meaning: 'Код мови, якою пишеться результат.',
    source: 'Проєкт → Моделі і промпти → Голос каналу → Мова.',
  },
  {
    name: 'hashtags',
    meaning: 'Хештеги каналу через пробіл, кожен із решіткою.',
    source: 'Проєкт → Моделі і промпти → Голос каналу → Хештеги.',
  },
  {
    name: 'style',
    meaning: 'Візуальна мова ілюстрацій.',
    source: 'Проєкт → Голос каналу → Стиль ілюстрацій; порожнє поле бере глобальний стиль.',
  },
  {
    name: 'maxChars',
    meaning: 'Цільова довжина поста у видимих символах.',
    source: 'Проєкт → Огляд → Публікація → Довжина поста.',
  },
];

const TOPIC: PromptVariable = {
  name: 'topic',
  meaning: 'Тема поста — рядок із банку тем.',
  source: 'Банк тем проєкту (вкладка «Пости»); у тестовому запуску — приклад.',
};

/** What each action adds on top of {@link COMMON_VARIABLES}. */
export const ACTION_VARIABLES: Record<AiAction, PromptVariable[]> = {
  topics: [
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
  post_text: [TOPIC],
  svg: [TOPIC],
  svg_repair: [
    TOPIC,
    { name: 'error', meaning: 'Чому санітайзер відхилив схему.', source: 'Санітайзер SVG.' },
    { name: 'svgSource', meaning: 'Відхилений SVG цілком.', source: 'Попередня відповідь моделі.' },
  ],
  image_prompt: [
    TOPIC,
    {
      name: 'postText',
      meaning: 'Готовий текст поста без розмітки.',
      source: 'Результат дії «Текст поста».',
    },
  ],
  // The drawing model receives the text produced by `image_prompt` directly, so
  // this action has no prompt of its own to fill in.
  image: [],
};

/** Everything usable in one action: the channel-wide set plus its own. */
export function promptVariables(action: AiAction): PromptVariable[] {
  return [...COMMON_VARIABLES, ...ACTION_VARIABLES[action]];
}
