import type { ImageMode } from '@tcf/shared';
import type { AiAction } from '@tcf/shared';
import { ChainExhaustedError, ChainMissingError, runChain } from '../ai/chain.js';
import {
  BATCH_IMAGE_MARGIN_MS,
  BATCH_IMAGE_MIN_SLACK_MS,
  collectBatch,
  dropBatch,
  findBatch,
  submitBatch,
} from '../ai/batch.js';
import { resolveChain } from '../ai/chains.js';
import { providers } from '../ai/gemini.js';
import { resolveKey } from '../ai/keys.js';
import { record } from '../services/activityLog.js';
import { projectVariables } from '../prompts/variables.js';
import { renderPrompt, resolvePrompt } from '../prompts/resolve.js';
import { acquire, openCircuit, recordUsage } from '../ai/rateLimiter.js';
import { LlmError } from '../ai/provider.js';
import type { Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { writeStagedImage } from './staging.js';
import { fallbackSvg } from './svg/fallback.js';
import { normaliseModelImage, renderSvgToPng, SvgRenderError } from './svg/render.js';
import { sanitizeSvg, SvgInvalidError } from './svg/sanitize.js';

/** Long structured output needs more room than the prose default. */
const SVG_TIMEOUT_MS = 120_000;

/** Пост у тому обсязі, який потрібен ілюстрації. */
export interface ImagePost {
  id: string;
  topicTitle: string | null;
  textHtml: string | null;
  /** Потрібен, щоб вирішити, чи лишається час на дешевий тариф. */
  scheduledAt?: Date | null;
}

export interface ImageResult {
  path: string;
  kind: 'svg' | 'svg_fallback' | 'image_model';
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
): Promise<ImageResult | 'waiting' | null> {
  const mode: ImageMode = project.imageMode;
  if (mode === 'none') return null;

  return mode === 'image_model'
    ? generateWithImageModel(post, project)
    : generateWithSvg(post, project);
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
  variables: Record<string, string | number | undefined>,
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

  const slot = post.scheduledAt;
  if (!slot || slot.getTime() - Date.now() < BATCH_IMAGE_MIN_SLACK_MS) return null;
  if (project.batchMode === 'off') return null;

  const submitted = await submitBatch({
    action,
    projectId: project.id,
    postId: post.id,
    variables,
    deadline: new Date(slot.getTime() - BATCH_IMAGE_MARGIN_MS),
  });

  return submitted ? 'waiting' : null;
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
): Promise<ImageResult | 'waiting'> {
  const log = logger.child({ post_id: post.id, project_id: project.id });
  const topic = post.topicTitle ?? 'схема';
  const notes: string[] = [];
  let attempts = 0;

  const tryRender = async (svg: string, model: string | null): Promise<ImageResult | null> => {
    const clean = sanitizeSvg(svg);
    if (clean.removed.length > 0) notes.push(`санітайзер прибрав: ${clean.removed.join(', ')}`);
    notes.push(...clean.warnings);

    const png = await renderSvgToPng(clean.svg);
    const path = await writeStagedImage(post.id, png.data, png.extension);
    return { path, kind: 'svg', svgSource: clean.svg, model, attempts, notes };
  };

  let lastError: string | null = null;
  let lastSource: string | null = null;

  const variables = { ...(await projectVariables(project)), topic };

  /*
   * SVG — це текстова генерація, тож на дешевий тариф вона йде так само, як
   * текст поста. Санітайзер і ремонт лишаються синхронними: вони працюють уже
   * над готовою відповіддю і другого замовлення не потребують.
   */
  const cheap = await batchedIllustration(post, project, 'svg', variables);
  if (cheap === 'waiting') return 'waiting';

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

  return { path, kind: 'svg_fallback', svgSource: null, model: null, attempts, notes };
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
): Promise<ImageResult | 'waiting'> {
  const log = logger.child({ post_id: post.id, project_id: project.id });
  const notes: string[] = [];

  const promptResult = await runChain({
    action: 'image_prompt',
    projectId: project.id,
    postId: post.id,
    variables: {
      ...(await projectVariables(project)),
      topic: post.topicTitle ?? '',
      postText: stripTags(post.textHtml ?? post.topicTitle ?? ''),
    },
  });

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
  const drawVariables = {
    ...(await projectVariables(project)),
    imagePrompt: promptResult.text,
    topic: post.topicTitle ?? '',
  };

  /*
   * Малювання — найдорожчий виклик у пості, тож і найбільше виграє від
   * половинної ціни. На batch іде саме воно, а не складання опису: опис — це
   * короткий текстовий виклик, і чекати через нього другу чергу означало б
   * подвоїти очікування заради копійок.
   */
  const cheap = await batchedIllustration(post, project, 'image', drawVariables);
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
      message: `Зображення намальовано моделлю ${cheap.model} на batch-тарифі, ${png.data.length} байт`,
    });
    return { path, kind: 'image_model', svgSource: null, model: cheap.model, attempts: 1, notes };
  }

  const template = await resolvePrompt('image', project.id, null);
  const drawPrompt = renderPrompt(template.body, drawVariables);

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
