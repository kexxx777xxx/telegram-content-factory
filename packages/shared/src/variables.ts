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
    meaning:
      'Хештеги каналу через пробіл. До поста їх дописує код — у промпті вони ' +
      'потрібні хіба щоб модель знала, чого не писати самій.',
    source: 'Проєкт → Моделі і промпти → Голос каналу → Хештеги.',
  },
  {
    name: 'style',
    meaning: 'Візуальна мова ілюстрацій.',
    source: 'Проєкт → Голос каналу → Стиль ілюстрацій; порожнє поле бере глобальний стиль.',
  },
  {
    name: 'maxChars',
    meaning: 'Скільки символів лишається на текст: довжина поста мінус хештеги.',
    source: 'Проєкт → Огляд → Публікація → Довжина поста.',
  },
];

/**
 * Хвіст із хештегів, який дописується до тексту перед відправкою.
 *
 * Дописує код, а не модель: тоді теги в кожному пості ті самі, стоять на тому
 * самому місці й міняються разом із налаштуванням проєкту, а не з наступною
 * вдалою відповіддю. Модель просять їх не писати, і те, що вона все одно
 * напише, зрізається (`stripTrailingHashtags`).
 */
export function withHashtags(textHtml: string, hashtags: string[]): string {
  const tail = hashtags.join(' ');
  return tail ? `${textHtml.trimEnd()}\n\n${tail}` : textHtml;
}

/**
 * Скільки символів лишається під сам текст.
 *
 * Ліміт стосується повідомлення, а хештеги — його частина: їх дописують у
 * кінці, тож пост виходив рівно на їхню довжину більшим за задане число. На
 * типовому ліміті в 1024 це означало підпис, який не влазить у фото, і ще одне
 * повідомлення під ним — з вини налаштування, яке нібито саме це й мало
 * запобігти.
 *
 * Віднімається саме той хвіст, який допише {@link withHashtags}, — інакше
 * бюджет був би на символ-два щедрішим за правило, яке потім відхиляє текст.
 *
 * Тут, а не на сервері, бо форма показує це число оператору поруч із полем, і
 * два обчислення того самого розійшлися б при першій же правці.
 *
 * Мінімум — 200 символів, нижня межа самого поля: рядок хештегів довший за
 * ліміт лишив би моделі бюджет нуль чи відʼємний.
 */
export function textBudget(postMaxChars: number, hashtags: string[]): number {
  return Math.max(200, postMaxChars - withHashtags('', hashtags).length);
}

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
  image: [
    TOPIC,
    {
      name: 'imagePrompt',
      meaning: 'Опис картинки, складений дією «Промпт для зображення».',
      source: 'Результат попереднього кроку цієї ж групи.',
    },
  ],
};

/** Everything usable in one action: the channel-wide set plus its own. */
export function promptVariables(action: AiAction): PromptVariable[] {
  return [...COMMON_VARIABLES, ...ACTION_VARIABLES[action]];
}
