import type { PostStatus } from '@tcf/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ChainExhaustedError, ChainMissingError, runChain, type ChainRunResult } from '../ai/chain.js';
import { db } from '../db/client.js';
import { posts, projects, topics, type Post, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { generateImage } from '../media/pipeline.js';
import { removeStagedImage } from '../media/staging.js';
import { sendApprovalCard } from '../telegram/adminBot.js';
import { sanitizeTelegramHtml, visibleLength } from '../telegram/html.js';
import {
  BATCH_MIN_SLACK_MS,
  collectBatch,
  dropBatch,
  findBatch,
  submitBatch,
} from '../ai/batch.js';
import { record } from './activityLog.js';
import { takeNextTopic } from './topics.js';

export class PostNotFoundError extends Error {}

/**
 * Text from the batch tier, or a decision about waiting for it.
 *
 * Returns a chain-shaped result when the answer is already in, `'waiting'`
 * while it is still cooking, and `null` when batch is not on the table at all —
 * so the caller's only branch is "did I get text".
 */
async function batchedText(
  post: Post,
  project: Project,
  variables: Record<string, string | number | undefined>,
): Promise<ChainRunResult | 'waiting' | null> {
  const slack = post.scheduledAt.getTime() - Date.now();

  const existing = await findBatch(post.id, 'post_text');
  if (existing) {
    const outcome = await collectBatch(existing.id);
    if (outcome?.state === 'pending') return 'waiting';

    await dropBatch(existing.id);
    if (outcome?.state === 'succeeded' && outcome.text) {
      return {
        text: outcome.text,
        model: existing.model,
        apiKeyId: existing.apiKeyId,
        promptId: existing.promptId ?? 'builtin',
        promptVersion: existing.promptVersion ?? 0,
        usage: {
          inputTokens: outcome.job.inputTokens ?? 0,
          outputTokens: outcome.job.outputTokens ?? 0,
        },
        attempts: [],
      };
    }
    // Failed, cancelled or expired: fall through to the normal call rather
    // than leave the slot with nothing.
    return null;
  }

  if (slack < BATCH_MIN_SLACK_MS) return null;

  const submitted = await submitBatch({
    action: 'post_text',
    projectId: project.id,
    postId: post.id,
    variables,
    // Stop waiting well before the slot: the illustration still has to be made
    // after the text arrives.
    deadline: new Date(post.scheduledAt.getTime() - 2 * 3600_000),
  });

  return submitted ? 'waiting' : null;
}

/** Statuses a generation job may legitimately start from. */
const GENERATABLE: PostStatus[] = ['planned', 'failed'];

export interface GenerationMeta {
  model?: string;
  imageKind?: string | null;
  imageModel?: string | null;
  imageNotes?: string[];
  promptId?: string;
  promptVersion?: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts?: number;
  generatedAt?: string;
  removedTags?: string[];
  visibleLength?: number;
}

export async function getPost(id: string): Promise<Post> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

export async function listPosts(projectId: string, limit = 100): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(eq(posts.projectId, projectId))
    .orderBy(desc(posts.scheduledAt))
    .limit(limit);
}

/**
 * Produces the post text for a planned slot.
 *
 * Idempotent by status: a job that runs twice (a retry after an ambiguous
 * failure, say) finds the post already past `planned` and does nothing rather
 * than spending another model call and overwriting a draft someone may have
 * edited by hand.
 */
export async function generatePostText(
  postId: string,
): Promise<'generated' | 'skipped' | 'batched'> {
  const post = await getPost(postId);
  const log = logger.child({ post_id: post.id, project_id: post.projectId });

  if (!GENERATABLE.includes(post.status)) {
    log.info({ status: post.status }, 'post already past planning, generation skipped');
    return 'skipped';
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, post.projectId)).limit(1);
  if (!project) throw new ChainMissingError('Проєкт поста не існує');

  /*
   * The topic is claimed before anything else, because both paths need it: the
   * batch prompt is rendered from it, and so is the synchronous one.
   */
  const topic = await ensureTopic(post, project);
  if (!topic) {
    throw new ChainMissingError('Немає доступної теми і не вдалося згенерувати нову');
  }

  const variables = {
    topic: topic.title,
    persona: project.persona,
    language: project.language,
    hashtags: project.hashtags.join(' '),
  };

  /*
   * Batch first, when the slot is far enough away to afford a 24-hour answer.
   *
   * The status stays `planned` while waiting on purpose: `generating` means a
   * model is working on it right now, and a post parked for a day is not that.
   * It also keeps the post recoverable — a stuck-generation reaper would have
   * nothing to reclaim here, because nothing is stuck.
   */
  const batched = await batchedText(post, project, variables);
  if (batched === 'waiting') return 'batched';

  await db
    .update(posts)
    .set({ status: 'generating', error: null, updatedAt: new Date() })
    .where(eq(posts.id, post.id));

  try {
    const result =
      batched ??
      (await runChain({
        action: 'post_text',
        projectId: project.id,
        postId: post.id,
        variables,
      }));

    // The model was asked for a restricted tag set; this is what enforces it.
    const clean = sanitizeTelegramHtml(result.text);
    if (clean.removedTags.length > 0) {
      log.info({ removedTags: clean.removedTags }, 'model returned markup outside the allowed set');
    }

    // Image generation happens after the text so the image-model branch can
    // describe what the post actually says, not just its topic.
    const image = await generateImage(
      { id: post.id, topicTitle: topic.title, textHtml: clean.html },
      project,
    );

    const meta: GenerationMeta = {
      model: result.model,
      promptId: result.promptId,
      promptVersion: result.promptVersion,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      attempts: result.attempts.length,
      generatedAt: new Date().toISOString(),
      removedTags: clean.removedTags,
      visibleLength: visibleLength(clean.html),
      imageKind: image?.kind ?? null,
      imageModel: image?.model ?? null,
      imageNotes: image?.notes ?? [],
    };

    await db
      .update(posts)
      .set({
        textHtml: clean.html,
        topicTitle: topic.title,
        imagePath: image?.path ?? null,
        imageKind: image?.kind ?? null,
        // `svgSource` is kept only while the post is buffered; publishing clears it.
        svgSource: image?.svgSource ?? null,
        status: project.publishMode === 'approval' ? 'awaiting_approval' : 'ready',
        generation: meta,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));

    await record({
      projectId: project.id,
      postId: post.id,
      topicId: topic.id,
      kind: 'generation_step',
      action: 'post_text',
      model: result.model,
      source: 'auto',
      message: `Текст готовий: ${visibleLength(clean.html)} символів, модель ${result.model}, промпт v${result.promptVersion}`,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });

    if (image) {
      await record({
        projectId: project.id,
        postId: post.id,
        kind: 'generation_step',
        action: image.kind === 'image_model' ? 'image' : 'svg',
        model: image.model,
        source: 'auto',
        message:
          image.kind === 'svg_fallback'
            ? 'Ілюстрація: резервна схема, модель не дала валідного SVG'
            : `Ілюстрація готова (${image.kind}), модель ${image.model}`,
        detail: image.notes.length > 0 ? image.notes.join('\n') : null,
      });
    }

    log.info(
      {
        model: result.model,
        chars: meta.visibleLength,
        topic: topic.title,
        image: image?.kind ?? 'none',
      },
      'post generated',
    );

    // Approval mode is useless if nobody is told a verdict is needed. A failure
    // to deliver the card must not undo a successful generation, though.
    if (project.publishMode === 'approval') {
      await sendApprovalCard(post.id).catch((err: unknown) =>
        log.warn({ err }, 'could not send approval card'),
      );
    }

    return 'generated';
  } catch (err) {
    // Back to `planned` so the queue's own retry can pick it up cleanly; the
    // topic stays attached so a retry does not consume a second one.
    const terminal = err instanceof ChainMissingError;
    await db
      .update(posts)
      .set({
        status: terminal ? 'failed' : 'planned',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));

    if (terminal) await releaseTopic(post.topicId);
    throw err;
  }
}

/**
 * Binds a topic to the post before any model call.
 *
 * Attaching it up front is what makes retries safe: the topic is claimed once,
 * and a failed attempt reuses the same one instead of draining the bank one
 * retry at a time.
 */
async function ensureTopic(post: Post, project: Project) {
  if (post.topicId) {
    const [existing] = await db.select().from(topics).where(eq(topics.id, post.topicId)).limit(1);
    if (existing) return existing;
  }

  const topic = await takeNextTopic({
    id: project.id,
    persona: project.persona,
    language: project.language,
    topicsBufferMin: project.topicsBufferMin,
  });
  if (!topic) return null;

  await db
    .update(posts)
    .set({ topicId: topic.id, topicTitle: topic.title, updatedAt: new Date() })
    .where(eq(posts.id, post.id));

  return topic;
}

async function releaseTopic(topicId: string | null): Promise<void> {
  if (!topicId) return;
  await db
    .update(topics)
    .set({ status: 'new' })
    .where(and(eq(topics.id, topicId), eq(topics.status, 'queued')));
}

/** Manual edit of a draft. Sanitised on the way in, same as generated text. */
export async function updatePostText(id: string, textHtml: string): Promise<Post> {
  const post = await getPost(id);
  if (post.status === 'published') {
    throw new PostNotFoundError('Опублікований пост редагувати не можна — текст уже стерто');
  }

  const clean = sanitizeTelegramHtml(textHtml);

  // `removedTags` must describe *this* edit, not the original generation —
  // otherwise the editor reports nothing while quietly rewriting what was typed.
  const meta: GenerationMeta & { editedAt: string } = {
    ...(post.generation as GenerationMeta),
    editedAt: new Date().toISOString(),
    removedTags: clean.removedTags,
    visibleLength: visibleLength(clean.html),
  };

  const [row] = await db
    .update(posts)
    .set({ textHtml: clean.html, generation: meta, updatedAt: new Date() })
    .where(eq(posts.id, id))
    .returning();

  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

/** Puts a post back to `planned` so a fresh generation job can run. */
export async function resetForRegeneration(id: string, keepTopic: boolean): Promise<Post> {
  const post = await getPost(id);
  if (post.status === 'published') {
    throw new PostNotFoundError('Опублікований пост не перегенерувати');
  }

  if (!keepTopic) await releaseTopic(post.topicId);
  // Without this the previous render stays on disk with nothing referencing it.
  await removeStagedImage(post.imagePath);

  const [row] = await db
    .update(posts)
    .set({
      status: 'planned',
      textHtml: null,
      imagePath: null,
      imageKind: null,
      svgSource: null,
      error: null,
      ...(keepTopic ? {} : { topicId: null, topicTitle: null }),
      updatedAt: new Date(),
    })
    .where(eq(posts.id, id))
    .returning();

  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

export async function postCounts(projectId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: posts.status, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(eq(posts.projectId, projectId))
    .groupBy(posts.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** Posts still ahead of their slot — the buffer depth the dashboard reports. */
export async function upcomingPosts(projectId: string): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.projectId, projectId),
        inArray(posts.status, ['planned', 'generating', 'ready', 'awaiting_approval']),
      ),
    )
    .orderBy(asc(posts.scheduledAt));
}

export { ChainExhaustedError };
