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
  resetForRegeneration,
  updatePostText,
  type GenerationMeta,
} from '../../services/posts.js';
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
    scheduledAt: row.scheduledAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    topicTitle: row.topicTitle,
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

/** Manual edit. The text goes through the same sanitiser as generated output. */
postsRouter.patch('/posts/:postId', async (req, res) => {
  const params = postParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = z.object({ textHtml: z.string().max(20_000) }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  try {
    res.json(toDto(await updatePostText(params.data.postId, parsed.data.textHtml)));
  } catch (err) {
    if (err instanceof PostNotFoundError) {
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
