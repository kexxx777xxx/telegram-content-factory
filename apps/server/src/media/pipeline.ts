import type { ImageMode } from '@tcf/shared';
import type { AiAction } from '@tcf/shared';
import { ChainExhaustedError, ChainMissingError, runChain } from '../ai/chain.js';
import {
  BATCH_DEADLINE_MS,
  BATCH_MAX_ITEMS,
  BATCH_MIN_ITEMS,
  batchCandidates,
  collectBatch,
  dropBatch,
  findBatch,
  submitBatch,
  type BatchItem,
} from '../ai/batch.js';
import { resolveChain } from '../ai/chains.js';
import { providers } from '../ai/gemini.js';
import { resolveKey } from '../ai/keys.js';
import { record } from '../services/activityLog.js';
import { projectVariables } from '../prompts/variables.js';
import { renderPrompt, resolvePrompt } from '../prompts/resolve.js';
import { acquire, openCircuit, recordUsage } from '../ai/rateLimiter.js';
import { LlmError } from '../ai/provider.js';
import type { Post, Project } from '../db/schema.js';

/**
 * Скільки постів іде в одне замовлення на малювання.
 *
 * Менше, ніж для тексту: кожному сусідові спершу треба скласти опис картинки, а
 * це окремий синхронний виклик. Двадцять описів перетворили б одну джобу на
 * довгий забіг, під час якого решта черги стоїть.
 */
const BATCH_IMAGE_GROUP_LIMIT = 5;
import { logger } from '../logger.js';
import { writeStagedImage } from './staging.js';
import { fallbackSvg } from './svg/fallback.js';
import { normaliseModelImage, renderSvgToPng, SvgRenderError } from './svg/render.js';
import { sanitizeSvg, SvgInvalidError } from './svg/sanitize.js';

/** Long structured output needs more room than the prose default. */
const SVG_TIMEOUT_MS = 120_000;

/** Обчислює один раз на виклик і віддає той самий результат далі. */
function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= fn());
}

/** Пост у тому обсязі, який потрібен ілюстрації. */
export interface ImagePost {
  id: string;
  topicTitle: string | null;
  textHtml: string | null;
}

export interface ImageResult {
  path: string;
  kind: 'svg' | 'svg_fallback' | 'image_model';
  /** Чи прийшла ця ілюстрація з дешевого batch-замовлення. Видно в журналі. */
  viaBatch: boolean;
  svgSource: string | null;
  model: string | null;
  attempts: number;
  notes: string[];
}

/**
 * Produces the post illustration and stages it on disk.
 *
 * The contract is deliberately total for SVG projects: this never returns
 * without an image. A slot arriving with text but no picture would change the
 * channel's format, and skipping the slot would lose a publication over a
 * rendering problem — so a deterministic fallback closes the gap.
 */
export async function generateImage(
  post: ImagePost,
  project: Project,
  opts: { allowBatch?: boolean } = {},
): Promise<ImageResult | 'waiting' | null> {
  const mode: ImageMode = project.imageMode;
  if (mode === 'none') return null;
  const allowBatch = opts.allowBatch === true;

  return mode === 'image_model'
    ? generateWithImageModel(post, project, allowBatch)
    : generateWithSvg(post, project, allowBatch);
}

/**
 * Замовлення ілюстрації на дешевому тарифі — або те, що з нього вийшло.
 *
 * Повертає `'waiting'`, поки відповіді немає: джоба паркується і повертається
 * сюди ж за чверть години. `null` означає «дешево не вийшло, роби як завжди» —
 * і це нормальний шлях, а не помилка: близький слот, вимкнений режим, ключ без
 * batch. Ілюстрація довго була єдиним кроком, який завжди платив повну ціну,
 * хоч і найдорожчий: текст і теми давно ходять сюди.
 */
async function batchedIllustration(
  post: ImagePost,
  project: Project,
  action: AiAction,
  /** Чи має цей пост добу на очікування; див. `generatePostText`. */
  allowBatch: boolean,
  /** Змінні для сусіда по замовленню; для малювання це ще й окремий виклик. */
  buildVariables: (candidate: Post) => Promise<Record<string, string | number | undefined>>,
  limit: number,
): Promise<
  { text?: string; image?: { data: Buffer; mimeType: string }; model: string } | 'waiting' | null
> {
  const existing = await findBatch(post.id, action);
  if (existing) {
    const outcome = await collectBatch(existing.id);
    if (outcome?.state === 'pending') return 'waiting';

    await dropBatch(existing.id);
    if (outcome?.state === 'succeeded' && (outcome.text || outcome.image)) {
      // Модель береться з рядка замовлення: у журналі має стояти та, що
      // справді малювала, а не перший крок ланцюжка на момент читання.
      return { text: outcome.text, image: outcome.image, model: existing.model };
    }
    // Не вийшло — далі звичайний ланцюжок, слот важливіший за знижку.
    return null;
  }

  if (!allowBatch) return noBatch(post, project, action, 'пост потрібен у каналі зараз');
  if (project.batchMode === 'off') return null;

  /*
   * Те саме, що з текстом: одне замовлення на всі пости буфера, яким уже є що
   * малювати. Ціна за запит однакова, а звернень і опитувань — одне.
   */
  const candidates = await batchCandidates({
    projectId: project.id,
    postId: post.id,
    action,
    needsText: true,
    limit,
  });

  // Те саме, що з текстом: замовлення, у якому немає замовника, лишає його
  // чекати на відповідь, якої для нього ніхто не просив.
  if (!candidates.some((candidate) => candidate.id === post.id)) {
    return noBatch(post, project, action, 'пост не потрапив у власне замовлення');
  }

  if (candidates.length < BATCH_MIN_ITEMS) {
    logger.info(
      { project_id: project.id, action, candidates: candidates.length },
      'too few posts ready for one illustration batch, drawing synchronously',
    );
    return noBatch(
      post,
      project,
      action,
      `у буфері ${candidates.length} пост(ів) із текстом і без картинки, а замовлення збирається щонайменше з ${BATCH_MIN_ITEMS}`,
    );
  }

  const items: BatchItem[] = [];
  for (const candidate of candidates) {
    try {
      items.push({ postId: candidate.id, variables: await buildVariables(candidate) });
    } catch (err) {
      // Сусід, для якого не вдалось скласти запит, просто не їде в замовленні:
      // його власна джоба зробить усе звичайним шляхом.
      logger.warn({ err, post_id: candidate.id }, 'skipping post in illustration batch');
    }
  }

  if (items.length < BATCH_MIN_ITEMS) {
    return noBatch(post, project, action, 'не вдалося скласти запити для сусідів по замовленню');
  }

  const submitted = await submitBatch({
    action,
    projectId: project.id,
    items,
    deadline: new Date(Date.now() + BATCH_DEADLINE_MS),
  });

  if (submitted.length > 0) return 'waiting';
  return noBatch(post, project, action, 'провайдер не прийняв замовлення (ключ без batch або відмова)');
}

/**
 * Чому ця ілюстрація малюється за повну ціну.
 *
 * Пишеться в журнал проєкту, а не лише в лог процесу: «чому картинка не пішла
 * дешево» — питання, яке ставлять до конкретного поста, і відповідь має лежати
 * поруч із ним. Завжди повертає `null` — це шлях «роби як завжди».
 */
async function noBatch(
  post: ImagePost,
  project: Project,
  action: AiAction,
  reason: string,
): Promise<null> {
  await record({
    projectId: project.id,
    postId: post.id,
    kind: 'note',
    action,
    source: 'auto',
    message: `Ілюстрація без batch: ${reason}`,
  });
  return null;
}

/**
 * Model → sanitize → repair → next model → deterministic fallback.
 *
 * The repair step exists because "the SVG is nearly right" is the common
 * failure, not "the model produced nonsense": handing back the exact validation
 * error is far cheaper than a full regeneration.
 */
async function generateWithSvg(
  post: ImagePost,
  project: Project,
  allowBatch: boolean,
): Promise<ImageResult | 'waiting'> {
  const log = logger.child({ post_id: post.id, project_id: project.id });
  const topic = post.topicTitle ?? 'схема';
  const notes: string[] = [];
  let attempts = 0;
  let viaBatch = false;

  const tryRender = async (svg: string, model: string | null): Promise<ImageResult | null> => {
    const clean = sanitizeSvg(svg);
    if (clean.removed.length > 0) notes.push(`санітайзер прибрав: ${clean.removed.join(', ')}`);
    notes.push(...clean.warnings);

    const png = await renderSvgToPng(clean.svg);
    const path = await writeStagedImage(post.id, png.data, png.extension);
    return { path, kind: 'svg', svgSource: clean.svg, model, attempts, notes, viaBatch };
  };

  let lastError: string | null = null;
  let lastSource: string | null = null;

  const variables = { ...(await projectVariables(project)), topic };

  /*
   * SVG — це текстова генерація, тож на дешевий тариф вона йде так само, як
   * текст поста. Санітайзер і ремонт лишаються синхронними: вони працюють уже
   * над готовою відповіддю і другого замовлення не потребують.
   */
  const cheap = await batchedIllustration(
    post,
    project,
    'svg',
    allowBatch,
    async (candidate) => ({ ...(await projectVariables(project)), topic: candidate.topicTitle ?? 'схема' }),
    BATCH_MAX_ITEMS,
  );
  if (cheap === 'waiting') return 'waiting';

  if (cheap?.text) {
    viaBatch = true;
    notes.push('SVG прийшов із batch-замовлення (−50%)');
  }

  try {
    attempts++;
    const generated = cheap?.text
      ? { text: cheap.text, model: cheap.model as string | null }
      : await runChain({
          action: 'svg',
          projectId: project.id,
          postId: post.id,
          variables,
          // A schematic is ~4k output tokens; the default 60s budget is for prose.
          timeoutMs: SVG_TIMEOUT_MS,
        });
    lastSource = generated.text;

    try {
      const rendered = await tryRender(generated.text, generated.model);
      if (rendered) return rendered;
    } catch (err) {
      if (!(err instanceof SvgInvalidError || err instanceof SvgRenderError)) throw err;
      lastError = err.message;
      log.warn({ err: err.message }, 'generated SVG rejected, attempting repair');
    }
  } catch (err) {
    if (err instanceof ChainExhaustedError || err instanceof ChainMissingError) {
      lastError = err.message;
      log.warn({ err: err.message }, 'svg chain unavailable');
    } else {
      throw err;
    }
  }

  if (lastError && lastSource) {
    try {
      attempts++;
      const repaired = await runChain({
        action: 'svg_repair',
        projectId: project.id,
        postId: post.id,
        variables: {
          ...variables,
          error: lastError,
          svgSource: lastSource.slice(0, 12_000),
        },
        timeoutMs: SVG_TIMEOUT_MS,
      });
      const rendered = await tryRender(repaired.text, repaired.model);
      if (rendered) {
        notes.push('SVG полагоджено після помилки валідації');
        return rendered;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err: lastError }, 'svg repair failed');
    }
  }

  // Everything upstream failed. This path cannot itself fail — that is its job.
  notes.push(`використано резервну схему: ${lastError ?? 'ланцюжок SVG недоступний'}`);
  const png = await renderSvgToPng(fallbackSvg(topic));
  const path = await writeStagedImage(post.id, png.data, png.extension);
  log.info({ reason: lastError }, 'fell back to deterministic schematic');

  return { path, kind: 'svg_fallback', svgSource: null, model: null, attempts, notes, viaBatch };
}

/**
 * Two steps: a text model writes the prompt, an image model draws it.
 *
 * No fallback here — a hand-drawn schematic would not match a project that
 * chose photographic illustration, so a failure surfaces as a failure instead
 * of quietly publishing the wrong aesthetic.
 */
async function generateWithImageModel(
  post: ImagePost,
  project: Project,
  allowBatch: boolean,
): Promise<ImageResult | 'waiting'> {
  const log = logger.child({ post_id: post.id, project_id: project.id });
  const notes: string[] = [];

  /*
   * Опис картинки рахується **ліниво**, і це не мікрооптимізація.
   *
   * Виклик стояв тут беззастережно, першим рядком, — а джоба, яка чекає на
   * batch-відповідь, заходить сюди щочверть години. Тобто за кожне пробудження
   * платили описом, який потім викидали: 137 викликів на 49 постів за годину,
   * до семи на один пост. Тепер опис складається лише тоді, коли справді
   * потрібен: у замовлення або в синхронне малювання.
   */
  const ownPrompt = memo(async () =>
    runChain({
      action: 'image_prompt',
      projectId: project.id,
      postId: post.id,
      variables: {
        ...(await projectVariables(project)),
        topic: post.topicTitle ?? '',
        postText: stripTags(post.textHtml ?? post.topicTitle ?? ''),
      },
    }),
  );

  const chain = await resolveChain('image', project.id);
  if (!chain || chain.steps.length === 0) {
    throw new ChainMissingError('Для дії «image» не налаштовано жодної моделі');
  }

  /*
   * Промпт кроку малювання — це шаблон навколо опису, а не сам опис. За
   * замовчуванням у ньому лише `{{imagePrompt}}`, тож нічого не змінюється;
   * але саме сюди дописують те, що стосується кожного зображення каналу
   * («без тексту на картинці», «вертикальний кадр») — інакше таке доводилось
   * би вписувати в промпт опису й сподіватись, що модель його перекаже.
   */
  const drawVariables = async () => ({
    ...(await projectVariables(project)),
    imagePrompt: (await ownPrompt()).text,
    topic: post.topicTitle ?? '',
  });

  /*
   * Малювання — найдорожчий виклик у пості, тож і найбільше виграє від
   * половинної ціни. На batch іде саме воно, а не складання опису: опис — це
   * короткий текстовий виклик, і чекати через нього другу чергу означало б
   * подвоїти очікування заради копійок.
   */
  const cheap = await batchedIllustration(
    post,
    project,
    'image',
    allowBatch,
    async (candidate) =>
      candidate.id === post.id
        ? drawVariables()
        : {
            ...(await projectVariables(project)),
            topic: candidate.topicTitle ?? '',
            imagePrompt: (
              await runChain({
                action: 'image_prompt',
                projectId: project.id,
                postId: candidate.id,
                variables: {
                  ...(await projectVariables(project)),
                  topic: candidate.topicTitle ?? '',
                  postText: stripTags(candidate.textHtml ?? candidate.topicTitle ?? ''),
                },
              })
            ).text,
          },
    // Менша пачка, ніж для тексту: опис картинки для кожного сусіда — це
    // окремий синхронний виклик, і двадцять таких перетворили б одну джобу на
    // довгий забіг.
    BATCH_IMAGE_GROUP_LIMIT,
  );
  if (cheap === 'waiting') return 'waiting';

  if (cheap?.image) {
    const png = await normaliseModelImage(cheap.image.data);
    const path = await writeStagedImage(post.id, png.data, png.extension);
    notes.push('намальовано на batch-тарифі (−50%)');
    await record({
      projectId: project.id,
      postId: post.id,
      kind: 'generation_step',
      action: 'image',
      model: cheap.model,
      source: 'auto',
      batch: true,
      message: `Зображення намальовано моделлю ${cheap.model} на batch-тарифі, ${png.data.length} байт`,
    });
    return { path, kind: 'image_model', svgSource: null, model: cheap.model, attempts: 1, notes, viaBatch: true };
  }

  const template = await resolvePrompt('image', project.id, null);
  const drawPrompt = renderPrompt(template.body, await drawVariables());

  let lastError: LlmError | null = null;

  for (const step of chain.steps) {
    const provider = providers[step.provider];
    if (!provider?.generateImage) continue;

    const key = await resolveKey(project.id, step.provider, 'image');
    if (!key) {
      notes.push(`${step.model}: немає доступного ключа`);
      continue;
    }

    {
      const gate = await acquire(key.id, step.model, {
        rpmLimit: key.rpmLimit,
        dailyRequestBudget: key.dailyRequestBudget,
      });
      if (!gate.ok) {
        notes.push(`${step.model}: пропущено (${gate.reason})`);
        continue;
      }

      try {
        const image = await provider.generateImage(key.secret, {
          model: step.model,
          prompt: drawPrompt,
        });
        await recordUsage(key.id, step.model, image.usage);

        const png = await normaliseModelImage(image.data);
        const path = await writeStagedImage(post.id, png.data, png.extension);

        // Metadata only. The render itself stays out of the database — logging
        // it would rebuild the local image archive ADR 0002 removed.
        await record({
          projectId: project.id,
          postId: post.id,
          kind: 'generation_step',
          action: 'image',
          model: step.model,
          keyLabel: key.label,
          source: 'auto',
          message: `Зображення намальовано моделлю ${step.model}, ${png.data.length} байт (.${png.extension})`,
          inputTokens: image.usage.inputTokens,
          outputTokens: image.usage.outputTokens,
        });

        log.info({ model: step.model }, 'image generated by model');
        return {
          path,
          kind: 'image_model',
          viaBatch: false,
          svgSource: null,
          model: step.model,
          attempts: 1,
          notes,
        };
      } catch (err) {
        const error = err instanceof LlmError ? err : new LlmError('unknown', String(err));
        lastError = error;
        await recordUsage(key.id, step.model, { inputTokens: 0, outputTokens: 0 }, true);

        if (error.kind === 'rate_limit') {
          await openCircuit(key.id, step.model, error.retryAfterMs, error.message);
        }
        notes.push(`${step.model}: ${error.message.slice(0, 120)}`);
        if (error.kind === 'invalid') break;
      }
    }
  }

  throw new ChainExhaustedError('image', [], lastError?.retryAfterMs
    ? new Date(Date.now() + lastError.retryAfterMs)
    : undefined);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}
