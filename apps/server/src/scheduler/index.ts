import { env } from '../config.js';
import { logger } from '../logger.js';
import { workerPool } from '../queue/worker.js';
import { planTick } from './planner.js';

/**
 * Owns the periodic loops. Kept separate from the HTTP layer so a deployment
 * could run an API-only instance later without touching either.
 */

let plannerTimer: NodeJS.Timeout | undefined;
let running = false;

async function safePlanTick(): Promise<void> {
  try {
    const report = await planTick();
    if (!report.skipped && (report.postsPlanned > 0 || report.jobsEnqueued > 0)) {
      logger.info(report, 'planner tick');
    }
  } catch (err) {
    logger.error({ err }, 'planner tick failed');
  }
}

export function startScheduler(): void {
  if (running) return;
  running = true;

  workerPool.start();

  // Run once at boot so a restart does not leave a gap the size of the interval.
  void safePlanTick();
  plannerTimer = setInterval(() => void safePlanTick(), env.PLANNER_TICK_SECONDS * 1000);
  plannerTimer.unref();

  logger.info({ everySeconds: env.PLANNER_TICK_SECONDS }, 'planner started');
}

export async function stopScheduler(): Promise<void> {
  running = false;
  if (plannerTimer) clearInterval(plannerTimer);
  await workerPool.stop();
}
