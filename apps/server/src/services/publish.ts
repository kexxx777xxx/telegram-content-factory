import { and, eq } from 'drizzle-orm';
import type { LogSource } from '@tcf/shared';
import { config } from '../config.js';
import { record } from './activityLog.js';
import { db } from '../db/client.js';
import { events, posts, projects, topics } from '../db/schema.js';
import { logger } from '../logger.js';
import { removeStagedImage, stagedImageExists } from '../media/staging.js';
import { TelegramApiError } from '../telegram/api.js';
import { buildPermalink } from '../telegram/permalink.js';
import { publishPost as sendToTelegram } from '../telegram/publisher.js';
import { getPost, PostNotFoundError, type GenerationMeta } from './posts.js';
import { projectBotToken } from './projects.js';

export class NotPublishableError extends Error {}

/**
 * Telegram said "wait" — the caller turns this into a reschedule rather than a
 * failed attempt, so a busy channel does not consume the post's retries.
 */
export class PublishThrottled extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Telegram просить зачекати ${retryAfterSeconds} с`);
  }
}

const PUBLISHABLE = new Set(['ready', 'awaiting_approval', 'publishing']);

/**
 * Sends a prepared post and erases the local copy.
 *
 * The erasure is the point, not a side effect: from here on the post lives in
 * Telegram and this row keeps only the permalink and a few metrics
 * (ADR 0002). Doing it in the same step as publishing is what keeps the two
 * from drifting apart.
 */
export async function publishReadyPost(
  postId: string,
  source: LogSource = 'auto',
): Promise<'published' | 'skipped'> {
  const post = await getPost(postId);
  const log = logger.child({ post_id: post.id, project_id: post.projectId });

  if (post.status === 'published') {
    log.info('post already published, nothing to do');
    return 'skipped';
  }
  if (!PUBLISHABLE.has(post.status)) {
    throw new NotPublishableError(`Пост у статусі «${post.status}» не готовий до публікації`);
  }
  if (!post.textHtml) {
    throw new NotPublishableError('У поста немає тексту');
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, post.projectId)).limit(1);
  if (!project) throw new NotPublishableError('Проєкт поста не існує');

  const token = projectBotToken(project);
  if (!token) throw new NotPublishableError('Для проєкту не задано токен бота');

  // A missing file means the render was swept or never written; publishing text
  // alone would change the channel's format, so this is a failure, not a
  // silent downgrade.
  if (project.imageMode !== 'none' && !stagedImageExists(post.imagePath)) {
    throw new NotPublishableError('Зображення поста відсутнє у staging');
  }

  await db
    .update(posts)
    .set({ status: 'publishing', updatedAt: new Date() })
    .where(eq(posts.id, post.id));

  let result;
  try {
    result = await sendToTelegram({
      token,
      chatId: project.telegramChannelId,
      textHtml: post.textHtml,
      imagePath: project.imageMode === 'none' ? null : post.imagePath,
      botKey: project.id,
      /*
       * A post that goes out in several pieces can fail between them. These two
       * hooks are what keep a retry from reposting what already arrived: the
       * ids are written as each send is accepted, and read back on the way in.
       */
      alreadySent: {
        messageId: post.tgMessageId,
        extraMessageIds: post.tgExtraMessageIds ?? [],
      },
      onProgress: async (progress) => {
        await db
          .update(posts)
          .set({
            tgMessageId: progress.messageId,
            tgExtraMessageIds: progress.extraMessageIds,
            updatedAt: new Date(),
          })
          .where(eq(posts.id, post.id));
      },
    });
  } catch (err) {
    await db
      .update(posts)
      .set({
        status: 'ready',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));

    if (err instanceof TelegramApiError && err.retryAfter) {
      throw new PublishThrottled(err.retryAfter);
    }
    throw err;
  }

  const permalink = buildPermalink(
    project.telegramChannelId,
    project.telegramChannelUsername,
    result.messageId,
  );

  const meta = post.generation as GenerationMeta;
  const keepText = config.retention.postTextDays > 0;

  await db.transaction(async (tx) => {
    await tx
      .update(posts)
      .set({
        status: 'published',
        publishedAt: new Date(),
        tgMessageId: result.messageId,
        // The resume trail has served its purpose; `publishedParts` below is
        // the durable record of how many messages the post became.
        tgExtraMessageIds: null,
        permalink,
        // Everything reproducible from Telegram goes; only metrics stay.
        textHtml: keepText ? post.textHtml : null,
        svgSource: null,
        imagePath: null,
        error: null,
        generation: { ...meta, publishedParts: 1 + result.extraMessageIds.length },
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));

    if (post.topicId) {
      await tx
        .update(topics)
        .set({ status: 'used', usedAt: new Date() })
        .where(and(eq(topics.id, post.topicId), eq(topics.status, 'queued')));
    }

    await tx.insert(events).values({
      projectId: post.projectId,
      postId: post.id,
      kind: 'post_published',
      payload: { permalink, messageId: result.messageId, parts: 1 + result.extraMessageIds.length },
    });
  });

  // Only after the row is committed: a file deleted before the transaction
  // succeeds would leave a post that can never be republished.
  await removeStagedImage(post.imagePath);

  await record({
    projectId: post.projectId,
    postId: post.id,
    topicId: post.topicId,
    kind: 'publish',
    source,
    message: `Опубліковано ${source === 'manual' ? 'вручну' : 'за розкладом'}: ${permalink}`,
  });

  log.info({ permalink, messageId: result.messageId }, 'post published, local copy erased');
  return 'published';
}

export { PostNotFoundError };
