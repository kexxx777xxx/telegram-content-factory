import { scheduleSchema } from '@tcf/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { posts, projects, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { isImplemented } from '../queue/handlers.js';
import { enqueue } from '../queue/enqueue.js';
import { needsReplenish } from '../services/topics.js';
import { computeSlots, projectJitterSeconds } from './slots.js';

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
 * Wrapped in a transaction-scoped advisory lock: a second instance ticking at
 * the same moment simply finds the lock taken and skips, so slots are never
 * double-booked. `posts_slot_uniq` is the belt to that suspenders — even if the
 * lock were lost, the same slot cannot become two posts.
 */
export async function planTick(): Promise<PlannerReport> {
  return db.transaction(async (tx) => {
    const locked: unknown = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${PLANNER_LOCK_ID}) as locked`,
    );
    const gotLock = firstRow<{ locked: boolean }>(locked)?.locked === true;
    if (!gotLock) {
      logger.debug('planner tick skipped: another instance holds the lock');
      return { projects: 0, postsPlanned: 0, jobsEnqueued: 0, skipped: true };
    }

    const active = await tx.select().from(projects).where(eq(projects.status, 'active'));

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

    return { projects: active.length, postsPlanned, jobsEnqueued, skipped: false };
  });
}

async function planProject(project: Project): Promise<{ postsPlanned: number; jobsEnqueued: number }> {
  const log = logger.child({ project_id: project.id });
  let postsPlanned = 0;
  let jobsEnqueued = 0;

  if (project.postsBuffer >= 1) {
    const schedule = scheduleSchema.parse(project.schedule);
    const slots = computeSlots(schedule, project.timezone, new Date(), project.postsBuffer);

    for (const slot of slots) {
      const [created] = await db
        .insert(posts)
        .values({ projectId: project.id, scheduledAt: slot, status: 'planned' })
        .onConflictDoNothing({ target: [posts.projectId, posts.scheduledAt] })
        .returning({ id: posts.id });

      if (!created) continue;
      postsPlanned++;

      if (isImplemented('generate_post')) {
        const enqueued = await enqueue({
          type: 'generate_post',
          projectId: project.id,
          payload: { postId: created.id },
          runAfter: generationStart(project, slot),
          dedupeKey: `post:${created.id}:generate`,
        });
        if (enqueued) jobsEnqueued++;
      }
    }

    if (postsPlanned > 0) log.info({ postsPlanned }, 'slots planned');
  }

  if (await needsReplenish(project.id, project.topicsBufferMin)) {
    const enqueued = await enqueue({
      type: 'replenish_topics',
      projectId: project.id,
      payload: { count: 20 },
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
 * `leadTimeMinutes` before the slot, plus a stable per-project offset. Without
 * the offset, every project sharing a 09:00 slot would fire its model calls in
 * the same second; deriving it from the id rather than randomly keeps a
 * replanning tick producing the same value.
 */
function generationStart(project: Project, slot: Date): Date {
  const lead = project.leadTimeMinutes * 60_000;
  const jitter = projectJitterSeconds(project.id) * 1000;
  const start = new Date(slot.getTime() - lead + jitter);
  return start.getTime() < Date.now() ? new Date() : start;
}

/** At most one prune per day; the dedupe key carries the date. */
async function enqueueDailyPrune(): Promise<number> {
  if (!isImplemented('prune')) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const enqueued = await enqueue({
    type: 'prune',
    dedupeKey: `prune:${day}`,
    maxAttempts: 2,
  });
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

function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows[0] as T | undefined;
  }
  return undefined;
}
