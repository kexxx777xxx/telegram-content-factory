import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { posts, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { alert } from '../services/alerts.js';
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
    .orderBy(asc(posts.scheduledAt))
    .limit(200);

  /*
   * Найсвіжіший прострочений слот кожного проєкту — те, що публікує
   * `publish_last`. Рахується до циклу, бо рішення про кожен пост залежить від
   * того, чи є за ним новіший: інакше довелось би дивитись уперед на кожному
   * кроці.
   */
  const newestLate = new Map<string, string>();
  for (const { post, project } of due) {
    if (!post.scheduledAt || post.scheduledAt >= graceCutoff) continue;
    if (project.missPolicy !== 'publish_last') continue;
    newestLate.set(project.id, post.id);
  }

  for (const { post, project } of due) {
    const log = logger.child({ post_id: post.id, project_id: project.id });
    // Ideas have no slot and are therefore never due; the query below only
    // ever returns rows that have one, so this is a type guard, not a filter.
    if (!post.scheduledAt) continue;
    const late = post.scheduledAt < graceCutoff;

    /*
     * Слот пройшов, а поста не було. `publish_late` віддає всі прострочені —
     * після нічного простою це вся черга за раз; `publish_last` лишає з неї
     * найсвіжіший, бо читачеві потрібен свіжий пост, а не вчорашня черга;
     * `skip` не публікує нічого.
     */
    const droppedByPolicy =
      late &&
      (project.missPolicy === 'skip' ||
        (project.missPolicy === 'publish_last' && newestLate.get(project.id) !== post.id));

    if (droppedByPolicy) {
      const reason =
        project.missPolicy === 'skip'
          ? `Слот пропущено: пост не був готовий протягом ${env.PUBLISH_GRACE_MINUTES} хв`
          : 'Слот пропущено: за ним є новіший прострочений, а проєкт публікує лише останній';

      await db
        .update(posts)
        .set({ status: 'skipped', error: reason, updatedAt: new Date() })
        .where(and(eq(posts.id, post.id), inArray(posts.status, ['planned', 'ready'])));
      skipped++;
      log.warn({ scheduledAt: post.scheduledAt, policy: project.missPolicy }, 'slot skipped by miss policy');
      await alert({
        kind: 'slot_skipped',
        projectId: project.id,
        postId: post.id,
        title: 'Слот пропущено',
        detail: `${reason} (слот ${post.scheduledAt.toISOString()})`,
      }).catch(() => undefined);
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

/**
 * Posts stuck in `generating` after their worker died.
 *
 * Generation refuses to start from `generating`, so without this the slot is
 * permanently frozen: the job is reclaimed and re-run, sees a status it may not
 * start from, reports "skipped", and the post never becomes anything. Found the
 * hard way — a Rust panic in the SVG renderer aborted the process mid-generation
 * and left the post that way.
 */
export async function reclaimStuckGenerating(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(posts)
    .set({ status: 'planned', updatedAt: new Date() })
    .where(and(eq(posts.status, 'generating'), sql`${posts.updatedAt} < ${cutoff}`))
    .returning({ id: posts.id });

  if (rows.length > 0) logger.warn({ count: rows.length }, 'reclaimed posts stuck in generating');
  return rows.length;
}

/**
 * Posts sitting in `publishing` longer than any send could take.
 *
 * Safe to retry because publishing resumes rather than restarts: a worker that
 * died after Telegram accepted the photo left the message id on the row, so the
 * re-run skips it and sends only what is missing. Before that, this reclaim was
 * itself a way to get the same image posted twice.
 */
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
