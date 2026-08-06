import type { JobType } from '@tcf/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';

export interface EnqueueInput {
  type: JobType;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  /**
   * Makes enqueueing idempotent. `jobs_dedupe_uniq` is partial on
   * `pending|running`, so the same key can be reused once the previous job
   * finishes — which is exactly what recurring slots need.
   */
  dedupeKey?: string;
}

/** Returns the job id, or null when an identical job is already queued. */
export async function enqueue(input: EnqueueInput): Promise<string | null> {
  const [row] = await db
    .insert(jobs)
    .values({
      type: input.type,
      projectId: input.projectId ?? null,
      payload: input.payload ?? {},
      /*
       * The database's clock, not ours.
       *
       * `claimJob` compares `run_after <= now()` inside Postgres, so a job
       * stamped with the app's clock is invisible until the difference between
       * the two elapses. On a container whose clock lags the host — the usual
       * case after the VM sleeps — that is a silent delay on every job, and it
       * showed up first as tests that claimed nothing they had just enqueued.
       */
      runAfter: input.runAfter ?? sql`now()`,
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
      dedupeKey: input.dedupeKey ?? null,
      status: 'pending',
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });

  return row?.id ?? null;
}

export async function jobCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/**
 * Frees jobs whose worker died mid-flight. Without this a crash leaves rows
 * stuck in `running` forever, and their dedupe keys keep blocking new work.
 */
export async function reclaimStuckJobs(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const reclaimed = await db
    .update(jobs)
    .set({ status: 'pending', lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, 'running'), sql`${jobs.lockedAt} < ${cutoff}`))
    .returning({ id: jobs.id });
  return reclaimed.length;
}

export async function retryJob(id: string): Promise<boolean> {
  const [row] = await db
    .update(jobs)
    .set({
      status: 'pending',
      attempts: 0,
      runAfter: new Date(),
      lastError: null,
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ['failed', 'dead'])))
    .returning({ id: jobs.id });
  return Boolean(row);
}
