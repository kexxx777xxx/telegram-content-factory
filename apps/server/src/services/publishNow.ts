import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, posts, projects, type Post } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueue } from '../queue/enqueue.js';
import { getPost, PostNotFoundError } from './posts.js';

/** Raised for states where "publish now" cannot mean anything sensible. */
export class NotLaunchableError extends Error {}

export interface LaunchResult {
  postId: string;
  /** Which path was taken, so the UI can say "публікується" vs "генерується". */
  job: 'publish_post' | 'generate_and_publish';
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
      payload: { postId: post.id },
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
    payload: { postId: post.id },
    priority: 40,
    dedupeKey: `post:${post.id}:generate_publish`,
  });
  log.info({ status: post.status }, 'manual generate-and-publish queued');
  return { postId: post.id, job: 'generate_and_publish', created };
}

export { PostNotFoundError };
