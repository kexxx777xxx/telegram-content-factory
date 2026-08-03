import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { posts, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueue } from '../queue/enqueue.js';
import { isImplemented } from '../queue/handlers.js';

export interface PublisherReport {
  due: number;
  queued: number;
  skipped: number;
  jit: number;
}

/**
 * Finds posts whose slot has arrived and hands them to the queue.
 *
 * The tick itself never calls Telegram or a model — it only enqueues, so
 * publishing inherits the queue's retry and reschedule semantics instead of
 * re-implementing them on a timer.
 */
export async function publisherTick(): Promise<PublisherReport> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - env.PUBLISH_GRACE_MINUTES * 60_000);

  let queued = 0;
  let skipped = 0;
  let jit = 0;

  const due = await db
    .select({ post: posts, project: projects })
    .from(posts)
    .innerJoin(projects, eq(projects.id, posts.projectId))
    .where(
      and(
        eq(projects.status, 'active'),
        lte(posts.scheduledAt, now),
        inArray(posts.status, ['planned', 'ready']),
      ),
    )
    .limit(200);

  for (const { post, project } of due) {
    const log = logger.child({ post_id: post.id, project_id: project.id });
    const late = post.scheduledAt < graceCutoff;

    // Past the grace window with nothing ready. `publish_late` keeps waiting;
    // `skip` gives up so the channel does not suddenly emit yesterday's slot.
    if (late && project.missPolicy === 'skip') {
      await db
        .update(posts)
        .set({
          status: 'skipped',
          error: `Слот пропущено: пост не був готовий протягом ${env.PUBLISH_GRACE_MINUTES} хв`,
          updatedAt: new Date(),
        })
        .where(and(eq(posts.id, post.id), inArray(posts.status, ['planned', 'ready'])));
      skipped++;
      log.warn({ scheduledAt: post.scheduledAt }, 'slot skipped by miss policy');
      continue;
    }

    if (post.status === 'ready') {
      if (!isImplemented('publish_post')) continue;
      const id = await enqueue({
        type: 'publish_post',
        projectId: project.id,
        payload: { postId: post.id },
        // Ahead of buffer generation: this one is already late by definition.
        priority: 20,
        dedupeKey: `post:${post.id}:publish`,
      });
      if (id) queued++;
      continue;
    }

    /*
     * `planned` and already due means the project runs just-in-time
     * (postsBuffer = 0), or generation fell behind. Either way the work is
     * generate-then-publish in one job, so a half-done post never sits
     * published-less while its slot drifts further away.
     */
    if (!isImplemented('generate_and_publish')) continue;
    const id = await enqueue({
      type: 'generate_and_publish',
      projectId: project.id,
      payload: { postId: post.id },
      priority: 30,
      dedupeKey: `post:${post.id}:generate_publish`,
    });
    if (id) jit++;
  }

  return { due: due.length, queued, skipped, jit };
}

/**
 * Creates the slot a JIT project publishes into.
 *
 * With `postsBuffer = 0` the planner deliberately schedules nothing ahead, so
 * without this no row would ever exist for the publisher to find.
 */
export async function ensureJitSlots(): Promise<number> {
  const jitProjects = await db
    .select()
    .from(projects)
    .where(and(eq(projects.status, 'active'), eq(projects.postsBuffer, 0)));

  let created = 0;
  for (const project of jitProjects) {
    const { scheduleSchema } = await import('@tcf/shared');
    const { computeSlots } = await import('./slots.js');

    // One slot only: the next one. Anything further ahead would be a buffer,
    // which is exactly what this mode opted out of.
    const [slot] = computeSlots(
      scheduleSchema.parse(project.schedule),
      project.timezone,
      new Date(Date.now() - 60_000),
      1,
    );
    if (!slot) continue;

    const [row] = await db
      .insert(posts)
      .values({ projectId: project.id, scheduledAt: slot, status: 'planned' })
      .onConflictDoNothing({ target: [posts.projectId, posts.scheduledAt] })
      .returning({ id: posts.id });

    if (row) created++;
  }
  return created;
}

/** Posts sitting in `publishing` longer than any send could take. */
export async function reclaimStuckPublishing(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(posts)
    .set({ status: 'ready', updatedAt: new Date() })
    .where(and(eq(posts.status, 'publishing'), sql`${posts.updatedAt} < ${cutoff}`))
    .returning({ id: posts.id });

  if (rows.length > 0) logger.warn({ count: rows.length }, 'reclaimed posts stuck in publishing');
  return rows.length;
}
