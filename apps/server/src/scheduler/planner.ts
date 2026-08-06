import { scheduleSchema } from '@tcf/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { jobs, posts, projects, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { isImplemented } from '../queue/handlers.js';
import { enqueue } from '../queue/enqueue.js';
import { ideaCounts, needsReplenish, promoteIdeaToSlot, refillCount } from '../services/ideas.js';
import { computeSlots, projectJitterSeconds } from './slots.js';
import { BATCH_MIN_SLACK_MS, canBatch } from '../ai/batch.js';

/**
 * Arbitrary but fixed: two instances must derive the same lock id to exclude
 * each other, so it lives here rather than in config.
 */
const PLANNER_LOCK_ID = 0x7cf0_9a11;

export interface PlannerReport {
  projects: number;
  postsPlanned: number;
  jobsEnqueued: number;
  skipped: boolean;
}

/**
 * One planning pass over every active project.
 *
 * Guarded by a session-level advisory lock: a second instance ticking at the
 * same moment finds it taken and skips, so slots are never double-booked.
 * `posts_slot_uniq` is the belt to that suspenders — even if the lock were
 * lost, the same slot cannot become two posts.
 *
 * The lock is held on its own connection rather than by wrapping the tick in a
 * transaction. An earlier version used `pg_try_advisory_xact_lock`, which reads
 * as if planning were atomic — but every insert below goes through the shared
 * `db` handle on *other* pooled connections, so nothing was ever inside that
 * transaction. All it did was keep one connection idle-in-transaction for the
 * length of a full pass over every project. A plain session lock says what it
 * actually does, and Postgres drops it on its own if the process dies.
 */
export async function planTick(): Promise<PlannerReport> {
  const client = await pool.connect();
  try {
    const held = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [PLANNER_LOCK_ID],
    );
    if (held.rows[0]?.locked !== true) {
      logger.debug('planner tick skipped: another instance holds the lock');
      return { projects: 0, postsPlanned: 0, jobsEnqueued: 0, skipped: true };
    }

    try {
      const active = await db.select().from(projects).where(eq(projects.status, 'active'));

      let postsPlanned = 0;
      let jobsEnqueued = 0;

      for (const project of active) {
        try {
          const result = await planProject(project);
          postsPlanned += result.postsPlanned;
          jobsEnqueued += result.jobsEnqueued;
        } catch (err) {
          // One misconfigured project must not stop planning for the rest.
          logger.error({ err, project_id: project.id }, 'planning failed for project');
        }
      }

      jobsEnqueued += await enqueueDailyPrune();
      jobsEnqueued += await enqueueDailyBackup();

      return { projects: active.length, postsPlanned, jobsEnqueued, skipped: false };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [PLANNER_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/**
 * One project, planned on demand.
 *
 * Same pass the tick makes, minus the advisory lock — the lock exists so two
 * *instances* do not plan the same project twice, and `posts_slot_uniq` still
 * refuses a duplicate slot if this races the tick. Status is deliberately not
 * checked: an operator pressing «наповнити буфер» on a paused project is asking
 * for exactly that, and the posts wait in the buffer either way.
 */
export async function planOneProject(projectId: string): Promise<PlannerReport> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return { projects: 0, postsPlanned: 0, jobsEnqueued: 0, skipped: true };

  const result = await planProject(project);
  logger.info({ project_id: projectId, ...result }, 'buffer filled on request');
  return { projects: 1, ...result, skipped: false };
}

async function planProject(project: Project): Promise<{ postsPlanned: number; jobsEnqueued: number }> {
  const log = logger.child({ project_id: project.id });
  let postsPlanned = 0;
  let jobsEnqueued = 0;

  if (project.postsBuffer >= 1) {
    const schedule = scheduleSchema.parse(project.schedule);
    const slots = computeSlots(schedule, project.timezone, new Date(), project.postsBuffer);

    for (const slot of slots) {
      /*
       * An idea already in the bank *becomes* this slot's post — the same row,
       * now with a time. Inserting a fresh post and marking the idea consumed
       * would recreate the two-row arrangement that having one entity removed,
       * and would leave the subject's dedup hash on a different row than the
       * post that used it.
       */
      let created = await promoteIdeaToSlot(project.id, slot);

      if (!created) {
        // Bank empty: reserve the slot anyway. Generation asks for a subject
        // when it runs, so an empty bank delays content, never the schedule.
        const [bare] = await db
          .insert(posts)
          .values({ projectId: project.id, scheduledAt: slot, status: 'planned' })
          .onConflictDoNothing({ target: [posts.projectId, posts.scheduledAt] })
          .returning();
        created = bare ?? null;
      }

      if (!created) continue;
      postsPlanned++;

      if (isImplemented('generate_post')) {
        const enqueued = await enqueue({
          type: 'generate_post',
          projectId: project.id,
          payload: { postId: created.id },
          runAfter: await generationStart(project, slot),
          dedupeKey: `post:${created.id}:generate`,
        });
        if (enqueued) jobsEnqueued++;
      }
    }

    if (postsPlanned > 0) log.info({ postsPlanned }, 'slots planned');
  }

  if (await needsReplenish(project.id, project.topicsBufferMin)) {
    // Top the bank back up to its minimum rather than adding a fixed handful:
    // "поповнюється, коли менше 50" has to mean "поповнюється до 50", or the
    // threshold is hit again the next day with one topic more than before.
    const counts = await ideaCounts(project.id);
    const enqueued = await enqueue({
      type: 'replenish_topics',
      projectId: project.id,
      payload: { count: refillCount(counts.fresh, project.topicsBufferMin) },
      // One replenish job per project may be in flight; the partial unique
      // index lets the same key be reused once it finishes.
      dedupeKey: `project:${project.id}:replenish`,
    });
    if (enqueued) {
      jobsEnqueued++;
      log.info('topic bank below threshold, replenish queued');
    }
  }

  return { postsPlanned, jobsEnqueued };
}

/**
 * When generation should start for a slot.
 *
 * Normally `leadTimeMinutes` before the slot, plus a stable per-project offset.
 * Without the offset, every project sharing a 09:00 slot would fire its model
 * calls in the same second; deriving it from the id rather than randomly keeps a
 * replanning tick producing the same value.
 *
 * The exception is the batch tier, and it is the whole reason this is async.
 * Whether a post can be batched is decided from the slack left before its slot,
 * and that check happens *inside the job*. With a three-hour lead time the job
 * woke up with three hours of slack against a 26-hour threshold — so the answer
 * was always no, and batching for post text never once happened on a buffered
 * project. Starting such a post immediately instead lets it submit the cheap
 * order days ahead and park until the answer arrives, which is also what makes
 * an empty buffer fill up straight away rather than one lead time at a time.
 */
async function generationStart(project: Project, slot: Date): Promise<Date> {
  const now = Date.now();
  const jitter = projectJitterSeconds(project.id) * 1000;

  if (slot.getTime() - now >= BATCH_MIN_SLACK_MS && (await canBatch(project.id, 'post_text'))) {
    return new Date(now + jitter);
  }

  const start = new Date(slot.getTime() - project.leadTimeMinutes * 60_000 + jitter);
  return start.getTime() < now ? new Date() : start;
}

/**
 * At most one prune per calendar day.
 *
 * The dedupe index alone is not enough here: it is partial on `pending|running`,
 * so the key frees up the moment the job finishes and the next tick would queue
 * another — a daily task running every sixty seconds. The date key has to be
 * checked against *all* statuses, not just in-flight ones.
 */
async function enqueueDailyPrune(): Promise<number> {
  if (!isImplemented('prune')) return 0;

  const day = new Date().toISOString().slice(0, 10);
  const dedupeKey = `prune:${day}`;

  const [alreadyToday] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.dedupeKey, dedupeKey))
    .limit(1);
  if (alreadyToday) return 0;

  const enqueued = await enqueue({ type: 'prune', dedupeKey, maxAttempts: 2 });
  return enqueued ? 1 : 0;
}

/** Same once-a-day reasoning as prune: the date key covers every status. */
async function enqueueDailyBackup(): Promise<number> {
  if (!isImplemented('backup')) return 0;

  const day = new Date().toISOString().slice(0, 10);
  const dedupeKey = `backup:${day}`;

  const [alreadyToday] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.dedupeKey, dedupeKey))
    .limit(1);
  if (alreadyToday) return 0;

  const enqueued = await enqueue({ type: 'backup', dedupeKey, maxAttempts: 2 });
  return enqueued ? 1 : 0;
}

/** Posts still waiting for their slot — the buffer depth per project. */
export async function bufferDepth(projectId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(
      and(
        eq(posts.projectId, projectId),
        gte(posts.scheduledAt, new Date()),
        sql`${posts.status} in ('planned','generating','ready','awaiting_approval')`,
      ),
    );
  return row?.count ?? 0;
}
