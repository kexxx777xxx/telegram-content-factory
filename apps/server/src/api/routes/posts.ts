import type { PostDto } from '@tcf/shared';
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { Post } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { stagedImageExists } from '../../media/staging.js';
import { enqueue } from '../../queue/enqueue.js';
import {
  getPost,
  listPosts,
  postCounts,
  PostNotFoundError,
  PostTooLongError,
  resetForRegeneration,
  updatePostQueue,
  updatePostText,
  bumpToFront,
  type GenerationMeta,
} from '../../services/posts.js';
import { postLog } from '../../services/activityLog.js';
import { launchPost, NotLaunchableError } from '../../services/publishNow.js';
import { badRequest, firstIssue } from './helpers.js';

export const postsRouter: Router = Router();

const projectParam = z.object({ id: z.string().uuid() });
const postParam = z.object({ postId: z.string().uuid() });

function toDto(row: Post): PostDto {
  const meta = (row.generation ?? {}) as GenerationMeta;
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    position: row.position,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    topicTitle: row.topicTitle,
    category: row.category,
    source: row.source,
    textHtml: row.textHtml,
    imageKind: row.imageKind,
    hasImage: row.imagePath !== null,
    permalink: row.permalink,
    error: row.error,
    generation: {
      model: meta.model ?? null,
      promptVersion: meta.promptVersion ?? null,
      visibleLength: meta.visibleLength ?? null,
      removedTags: meta.removedTags ?? [],
      generatedAt: meta.generatedAt ?? null,
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}

postsRouter.get('/projects/:id/posts', async (req, res) => {
  const params = projectParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const [rows, counts] = await Promise.all([
    listPosts(params.data.id),
    postCounts(params.data.id),
  ]);
  res.json({ posts: rows.map(toDto), counts });
});

/**
 * Streams the staged render. Only buffered posts have one: after publishing the
 * file is deleted and the image lives in Telegram (ADR 0002).
 */
postsRouter.get('/posts/:postId/image', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  let post;
  try {
    post = await getPost(params.data.postId);
  } catch (err) {
    if (err instanceof PostNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }

  if (!stagedImageExists(post.imagePath)) {
    res.status(404).json({ error: 'Зображення недоступне' });
    return;
  }

  res.type('image/png');
  res.setHeader('Cache-Control', 'private, max-age=60');
  createReadStream(post.imagePath!).pipe(res);
});

/** The post's own log: what was asked of each model and what came back. */
postsRouter.get('/posts/:postId/logs', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  res.json(await postLog(params.data.postId));
});

postsRouter.get('/posts/:postId', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  try {
    res.json(toDto(await getPost(params.data.postId)));
  } catch (err) {
    if (err instanceof PostNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Ручна правка поста: текст, місце в черзі або закріплений час.
 *
 * Три різні речі в одному PATCH, бо для оператора це один об'єкт і одна форма.
 * `null` у `position`/`scheduledAt` означає «прибрати», а відсутнє поле — «не
 * чіпати»; без цієї різниці закріплений час не було б як зняти.
 */
const postPatchSchema = z.object({
  textHtml: z.string().max(20_000).optional(),
  position: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
});

postsRouter.patch('/posts/:postId', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = postPatchSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));
  const { textHtml, position, scheduledAt } = parsed.data;

  try {
    let post =
      textHtml !== undefined
        ? await updatePostText(params.data.postId, textHtml)
        : await getPost(params.data.postId);

    if (position !== undefined || scheduledAt !== undefined) {
      post = await updatePostQueue(params.data.postId, {
        position,
        scheduledAt:
          scheduledAt === undefined ? undefined : scheduledAt === null ? null : new Date(scheduledAt),
      });
    }
    res.json(toDto(post));
  } catch (err) {
    if (err instanceof PostTooLongError) return badRequest(res, err.message);
    if (err instanceof PostNotFoundError) {
      res.status(409).json({ error: err.message });
      return;
    }
    // Дві публікації на ту саму хвилину — `posts_slot_uniq`. Помилка бази тут
    // означає рівно одне, і сказати це зрозуміло дешевше, ніж перевіряти
    // заздалегідь і все одно ловити гонку.
    if (err instanceof Error && 'code' in err && err.code === '23505') {
      res.status(409).json({ error: 'На цю хвилину вже закріплено інший пост' });
      return;
    }
    throw err;
  }
});

/** «Хай піде наступним» — найчастіше бажання до черги, однією кнопкою. */
postsRouter.post('/posts/:postId/bump', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  try {
    res.json(toDto(await bumpToFront(params.data.postId)));
  } catch (err) {
    if (err instanceof PostNotFoundError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Runs the slot now, ignoring its time.
 *
 * Works from any unfinished state: a ready post is published, an unfinished one
 * is generated and published in one job. The response says which path was
 * taken so the UI does not have to re-derive it from the status it just saw.
 */
postsRouter.post('/posts/:postId/publish', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  try {
    res.status(202).json(await launchPost(params.data.postId));
  } catch (err) {
    if (err instanceof PostNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof NotLaunchableError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Clears the draft and queues a fresh generation.
 *
 * `keepTopic` defaults to true: regenerating usually means "same topic, better
 * text", and releasing the topic every time would churn the bank.
 */
postsRouter.post('/posts/:postId/regenerate', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = z.object({ keepTopic: z.boolean().default(true) }).safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  try {
    const post = await resetForRegeneration(params.data.postId, parsed.data.keepTopic);
    await enqueue({
      type: 'generate_post',
      projectId: post.projectId,
      payload: { postId: post.id },
      // Ahead of scheduled buffer work: somebody is waiting on this one.
      priority: 10,
      dedupeKey: `post:${post.id}:generate`,
    });
    logger.info({ post_id: post.id }, 'regeneration queued');
    res.json(toDto(post));
  } catch (err) {
    if (err instanceof PostNotFoundError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});
