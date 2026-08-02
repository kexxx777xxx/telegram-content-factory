import { randomUUID } from 'node:crypto';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { claimJob, completeJob, failJob, rescheduleJob } from './claim.js';
import { handlers } from './handlers.js';
import { reclaimStuckJobs } from './enqueue.js';
import { PermanentJobFailure, RescheduleJob } from './types.js';

const IDLE_POLL_MS = 1_000;
/** A job held this long has almost certainly lost its worker. */
const STUCK_JOB_MS = 15 * 60_000;
const REAPER_INTERVAL_MS = 60_000;

/**
 * A fixed pool of loops, each claiming and running one job at a time.
 *
 * The pool never sleeps on an obstacle: a handler that cannot proceed raises
 * `RescheduleJob` with a time, the row goes back to `pending`, and the loop
 * immediately looks for other work. That is what keeps an exhausted quota from
 * freezing every worker at once.
 */
export class WorkerPool {
  private running = false;
  private loops: Promise<void>[] = [];
  private reaper?: NodeJS.Timeout;
  private readonly id = randomUUID().slice(0, 8);

  start(concurrency = env.WORKER_CONCURRENCY): void {
    if (this.running) return;
    this.running = true;

    for (let i = 0; i < concurrency; i++) {
      this.loops.push(this.loop(`${this.id}-${i}`));
    }

    this.reaper = setInterval(() => {
      void reclaimStuckJobs(STUCK_JOB_MS).then((count) => {
        if (count > 0) logger.warn({ count }, 'reclaimed jobs abandoned by dead workers');
      });
    }, REAPER_INTERVAL_MS);
    this.reaper.unref();

    logger.info({ concurrency, poolId: this.id }, 'worker pool started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all(this.loops);
    this.loops = [];
    logger.info({ poolId: this.id }, 'worker pool stopped');
  }

  private async loop(workerId: string): Promise<void> {
    while (this.running) {
      let claimed = false;
      try {
        claimed = await this.tick(workerId);
      } catch (err) {
        logger.error({ err, workerId }, 'worker loop error');
      }
      if (!claimed && this.running) await sleep(IDLE_POLL_MS);
    }
  }

  private async tick(workerId: string): Promise<boolean> {
    const job = await claimJob(workerId);
    if (!job) return false;

    const log = logger.child({ job_id: job.id, job_type: job.type, project_id: job.projectId });
    const handler = handlers[job.type];

    if (!handler) {
      // Should be unreachable: only implemented types are ever enqueued.
      log.error('no handler registered for job type');
      await failJob(job.id, `Немає обробника для типу ${job.type}`, true);
      return true;
    }

    const startedAt = Date.now();
    try {
      await handler({ job, log });
      await completeJob(job.id);
      log.info({ durationMs: Date.now() - startedAt, attempt: job.attempts }, 'job done');
    } catch (err) {
      await this.handleFailure(job.id, job.attempts, err, log, Date.now() - startedAt);
    }
    return true;
  }

  private async handleFailure(
    jobId: string,
    attempts: number,
    err: unknown,
    log: typeof logger,
    durationMs: number,
  ): Promise<void> {
    if (err instanceof RescheduleJob) {
      await rescheduleJob(jobId, err.runAfter, err.message);
      log.info(
        { runAfter: err.runAfter, reason: err.message, durationMs },
        'job rescheduled without spending an attempt',
      );
      return;
    }

    const terminal = err instanceof PermanentJobFailure;
    const message = err instanceof Error ? err.message : String(err);
    const outcome = await failJob(jobId, message, terminal);

    if (outcome === 'dead') {
      log.error({ err, attempts, durationMs }, 'job dead — no further retries');
    } else {
      log.warn({ err, attempts, durationMs }, 'job failed, will retry');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const workerPool = new WorkerPool();
