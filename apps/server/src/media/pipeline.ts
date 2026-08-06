import type { ImageMode } from '@tcf/shared';
import { ChainExhaustedError, ChainMissingError, runChain } from '../ai/chain.js';
import { resolveChain } from '../ai/chains.js';
import { providers } from '../ai/gemini.js';
import { resolveKey } from '../ai/keys.js';
import { logSwitches, writeLog } from '../services/postLog.js';
import { acquire, openCircuit, recordUsage } from '../ai/rateLimiter.js';
import { LlmError } from '../ai/provider.js';
import type { Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { DEFAULT_STYLE } from '../prompts/defaults.js';
import { writeStagedImage } from './staging.js';
import { fallbackSvg } from './svg/fallback.js';
import { normaliseModelImage, renderSvgToPng, SvgRenderError } from './svg/render.js';
import { sanitizeSvg, SvgInvalidError } from './svg/sanitize.js';

/** Long structured output needs more room than the prose default. */
const SVG_TIMEOUT_MS = 120_000;

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
  post: { id: string; topicTitle: string | null; textHtml: string | null },
  project: Project,
): Promise<ImageResult | null> {
  const mode: ImageMode = project.imageMode;
  if (mode === 'none') return null;

  return mode === 'image_model'
    ? generateWithImageModel(post, project)
    : generateWithSvg(post, project);
}

/**
 * Model → sanitize → repair → next model → deterministic fallback.
 *
 * The repair step exists because "the SVG is nearly right" is the common
 * failure, not "the model produced nonsense": handing back the exact validation
 * error is far cheaper than a full regeneration.
 */
async function generateWithSvg(
  post: { id: string; topicTitle: string | null },
  project: Project,
): Promise<ImageResult> {
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

  try {
    attempts++;
    const generated = await runChain({
      action: 'svg',
      projectId: project.id,
      postId: post.id,
      variables: { topic, style: DEFAULT_STYLE },
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
        variables: { error: lastError, svgSource: lastSource.slice(0, 12_000) },
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
  post: { id: string; textHtml: string | null; topicTitle: string | null },
  project: Project,
): Promise<ImageResult> {
  const log = logger.child({ post_id: post.id, project_id: project.id });
  const notes: string[] = [];

  const promptResult = await runChain({
    action: 'image_prompt',
    projectId: project.id,
    postId: post.id,
    variables: {
      postText: stripTags(post.textHtml ?? post.topicTitle ?? ''),
      style: DEFAULT_STYLE,
    },
  });

  const chain = await resolveChain('image', project.id);
  if (!chain || chain.steps.length === 0) {
    throw new ChainMissingError('Для дії «image» не налаштовано жодної моделі');
  }

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
          prompt: promptResult.text,
        });
        await recordUsage(key.id, step.model, image.usage);

        const png = await normaliseModelImage(image.data);
        const path = await writeStagedImage(post.id, png.data, png.extension);

        // Metadata only. The render itself stays out of the database — logging
        // it would rebuild the local image archive ADR 0002 removed.
        const switches = await logSwitches(project.id);
        if (switches.requests || switches.responses) {
          await writeLog({
            postId: post.id,
            projectId: project.id,
            action: 'image',
            model: step.model,
            keyLabel: key.label,
            phase: 'note',
            content: `Зображення намальовано моделлю, ${png.data.length} байт (.${png.extension}). Вміст не логується.`,
            inputTokens: image.usage.inputTokens,
            outputTokens: image.usage.outputTokens,
          });
        }

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
