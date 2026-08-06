import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, posts, projects, topics, type Post } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueue } from '../queue/enqueue.js';
import { getPost, PostNotFoundError } from './posts.js';

/** Raised for states where "publish now" cannot mean anything sensible. */
export class NotLaunchableError extends Error {}

export interface LaunchResult {
  postId: string;
  /** Which path was taken, so the UI can say "публікується" vs "генерується". */
  job: 'publish_post' | 'generate_and_publish' | 'generate_post';
  /** True when the slot row was created by this call rather than the planner. */
  created: boolean;
}

/**
 * Runs a post's slot immediately, whatever state it is in.
 *
 * Ready posts go straight to the publisher; unfinished ones take the
 * generate-then-publish path in a single job. That is the same job the
 * just-in-time mode uses, so a manual launch cannot leave a freshly generated
 * post sitting with nothing to publish it.
 */
export async function launchPost(postId: string): Promise<LaunchResult> {
  const post = await getPost(postId);
  return launch(post, false);
}

/**
 * The project-level launch: takes the nearest unpublished slot, or makes one.
 *
 * A project with `postsBuffer = 0` has no row until its tick creates one, and a
 * paused project has none at all — without creating a slot the button would be
 * dead exactly when it is most useful.
 */
export async function launchProject(projectId: string): Promise<LaunchResult> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new NotLaunchableError('Проєкт не знайдено');

  const [next] = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.projectId, projectId),
        inArray(posts.status, ['ready', 'awaiting_approval', 'planned', 'failed']),
      ),
    )
    // Ready first: publishing something already paid for beats generating anew.
    // Spelled out rather than sorting by the enum, whose order is declaration
    // order and happens to put `planned` ahead of `ready`.
    .orderBy(
      sql`case when ${posts.status} in ('ready', 'awaiting_approval') then 0 else 1 end`,
      asc(posts.scheduledAt),
    )
    .limit(1);

  if (next) return launch(next, false);

  const [row] = await db
    .insert(posts)
    .values({ projectId, scheduledAt: new Date(), status: 'planned' })
    .returning();
  if (!row) throw new NotLaunchableError('Не вдалося створити слот');

  const result = await launch(row, true);
  return { ...result, created: true };
}

/**
 * Turns one topic into a post and runs it.
 *
 * A topic *is* a post that only has its subject so far — that is why the list
 * shows both. It follows that everything the list offers a post has to work on
 * a topic too; otherwise the row looks managed and is not. The only thing the
 * topic lacks is a slot, so this gives it one and hands it to the same `launch`
 * every other manual run goes through.
 *
 * `publish: false` stops after generation, which is how a topic gets pulled
 * into the buffer ahead of its turn without being pushed into the channel.
 */
export async function launchTopic(
  topicId: string,
  options: { publish: boolean },
): Promise<LaunchResult> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) throw new NotLaunchableError('Тему не знайдено');
  if (topic.status === 'used') throw new NotLaunchableError('Тему вже використано в пості');

  // Claimed before the post exists: two clicks on the same row would otherwise
  // each get a slot, and the topic would go out twice.
  const claimed = await db
    .update(topics)
    .set({ status: 'queued' })
    .where(and(eq(topics.id, topicId), eq(topics.status, 'new')))
    .returning({ id: topics.id });

  if (claimed.length === 0) {
    const existing = await db
      .select()
      .from(posts)
      .where(and(eq(posts.topicId, topicId), ne(posts.status, 'published')))
      .limit(1);
    const [post] = existing;
    if (post) return launch(post, false);
    throw new NotLaunchableError('Тема вже в роботі');
  }

  const [row] = await db
    .insert(posts)
    .values({
      projectId: topic.projectId,
      scheduledAt: freeSlot(),
      status: 'planned',
      topicId: topic.id,
      topicTitle: topic.title,
    })
    .returning();

  if (!row) {
    await db.update(topics).set({ status: 'new' }).where(eq(topics.id, topicId));
    throw new NotLaunchableError('Не вдалося створити слот для теми');
  }

  logger.info({ post_id: row.id, topic_id: topic.id }, 'topic promoted to a post');

  if (options.publish) return { ...(await launch(row, true)), created: true };

  await enqueue({
    type: 'generate_post',
    projectId: row.projectId,
    payload: { postId: row.id, manual: true },
    priority: 40,
    dedupeKey: `post:${row.id}:generate`,
  });
  return { postId: row.id, job: 'generate_post', created: true };
}

/**
 * `posts_slot_uniq` covers `(project_id, scheduled_at)`, so launching two
 * topics inside the same millisecond would collide. Nudging by a random second
 * is enough — the slot time carries no meaning for a manual run.
 */
function freeSlot(): Date {
  return new Date(Date.now() + Math.floor(Math.random() * 1000));
}

async function launch(post: Post, created: boolean): Promise<LaunchResult> {
  const log = logger.child({ post_id: post.id, project_id: post.projectId });

  if (post.status === 'published') {
    throw new NotLaunchableError('Пост уже опубліковано');
  }
  if (post.status === 'generating' || post.status === 'publishing') {
    throw new NotLaunchableError(`Пост уже в роботі: статус «${post.status}»`);
  }

  if ((post.status === 'ready' || post.status === 'awaiting_approval') && post.textHtml) {
    await enqueue({
      type: 'publish_post',
      projectId: post.projectId,
      payload: { postId: post.id, manual: true },
      priority: 50,
      dedupeKey: `post:${post.id}:publish`,
    });
    log.info('manual publish queued');
    return { postId: post.id, job: 'publish_post', created };
  }

  // `skipped` is terminal for the scheduler but not for a human decision, and
  // generation refuses to start from it — so the slot goes back to planned.
  if (post.status === 'skipped') {
    await db
      .update(posts)
      .set({ status: 'planned', error: null, updatedAt: new Date() })
      .where(eq(posts.id, post.id));
  }

  // A generate job may already be pending from the buffer's lead time. Leaving
  // it would let both run: one generates while the other finds the post still
  // unfinished and fails the publish. Pending jobs are safe to drop — a running
  // one is not, and the dedupe key protects that case.
  await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.status, 'pending'),
        eq(jobs.dedupeKey, `post:${post.id}:generate`),
      ),
    );

  await enqueue({
    type: 'generate_and_publish',
    projectId: post.projectId,
    payload: { postId: post.id, manual: true },
    priority: 40,
    dedupeKey: `post:${post.id}:generate_publish`,
  });
  log.info({ status: post.status }, 'manual generate-and-publish queued');
  return { postId: post.id, job: 'generate_and_publish', created };
}

export { PostNotFoundError };
