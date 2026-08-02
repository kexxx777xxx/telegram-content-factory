import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, type Job } from '../db/schema.js';

/**
 * Takes one runnable job for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole reason the queue can live in Postgres:
 * concurrent workers step over each other's locked rows instead of blocking,
 * so N workers drain the queue without any coordination outside the database.
 *
 * The subquery is what makes it safe — selecting and updating in one statement
 * leaves no window where two workers could both see the same pending row.
 */
export async function claimJob(workerId: string): Promise<Job | null> {
  const result: unknown = await db.execute(sql`
    update ${jobs} set
      status = 'running',
      locked_by = ${workerId},
      locked_at = now(),
      attempts = ${jobs.attempts} + 1,
      updated_at = now()
    where id = (
      select id from ${jobs}
      where ${jobs.status} = 'pending' and ${jobs.runAfter} <= now()
      order by ${jobs.priority} desc, ${jobs.runAfter}
      for update skip locked
      limit 1
    )
    returning id
  `);

  const id = extractRows<{ id: string }>(result)[0]?.id;
  if (!id) return null;

  /*
   * Deliberately a second query rather than `returning *`.
   *
   * Raw SQL bypasses Drizzle's column mapping, so `returning *` hands back
   * snake_case keys: `project_id` is populated while `projectId` reads as
   * undefined. Fields whose names match in both conventions (id, type, status)
   * look fine, which is what makes the bug quiet — a handler silently loses the
   * project it was supposed to work on. The typed select costs one round trip
   * and removes the whole class.
   */
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

export async function completeJob(id: string): Promise<void> {
  await db.execute(sql`
    update ${jobs} set status = 'done', last_error = null, locked_by = null,
                       locked_at = null, updated_at = now()
    where id = ${id}
  `);
}

/**
 * Puts the job back without counting an attempt.
 *
 * Used when the obstacle is external and timed — a rate-limited chain returns
 * the moment it might work again, and burning retries against that wall would
 * only guarantee the job dies before the quota resets.
 */
export async function rescheduleJob(id: string, runAfter: Date, reason: string): Promise<void> {
  await db.execute(sql`
    update ${jobs} set status = 'pending', run_after = ${runAfter},
                       attempts = greatest(${jobs.attempts} - 1, 0),
                       last_error = ${reason}, locked_by = null, locked_at = null,
                       updated_at = now()
    where id = ${id}
  `);
}

/** Exponential backoff with a 30-minute ceiling, so a flapping dependency is not hammered. */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0) * 30, 30 * 60);
}

/**
 * Records a failure and decides the job's fate.
 *
 * The backoff is computed in SQL from the row's own `attempts`, not from a
 * value captured in JS — otherwise every retry would wait the same 30 seconds
 * and the "exponential" part would be decorative. The random tail spreads jobs
 * that failed together in the same outage.
 */
export async function failJob(id: string, error: string, terminal: boolean): Promise<'failed' | 'dead'> {
  const jitter = Math.floor(Math.random() * 10);
  const result: unknown = await db.execute(sql`
    update ${jobs} set
      status = case
        when ${terminal} or ${jobs.attempts} >= ${jobs.maxAttempts} then 'dead'::job_status
        else 'pending'::job_status
      end,
      run_after = case
        when ${terminal} or ${jobs.attempts} >= ${jobs.maxAttempts} then ${jobs.runAfter}
        else now() + make_interval(
          secs => least(power(2, greatest(${jobs.attempts} - 1, 0)) * 30, 1800) + ${jitter}
        )
      end,
      last_error = ${error},
      locked_by = null,
      locked_at = null,
      updated_at = now()
    where id = ${id}
    returning status
  `);

  return extractRows<{ status: 'failed' | 'dead' }>(result)[0]?.status ?? 'dead';
}

/**
 * `db.execute` returns the driver result directly for node-postgres but plain
 * arrays under some drivers; normalise instead of assuming.
 */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
