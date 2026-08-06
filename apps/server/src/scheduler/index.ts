import { env } from '../config.js';
import { logger } from '../logger.js';
import { workerPool } from '../queue/worker.js';
import { startAdminBot, stopAdminBot } from '../telegram/adminBot.js';
import { planTick } from './planner.js';
import {
  ensureJitSlots,
  publisherTick,
  reclaimStuckGenerating,
  reclaimStuckPublishing,
} from './publisher.js';

/**
 * Owns the periodic loops. Kept separate from the HTTP layer so a deployment
 * could run an API-only instance later without touching either.
 */

let plannerTimer: NodeJS.Timeout | undefined;
let publisherTimer: NodeJS.Timeout | undefined;
let running = false;

/** A send cannot plausibly take this long; anything older lost its worker. */
const STUCK_PUBLISHING_MS = 10 * 60_000;

/**
 * Generation is slower than a send — an SVG alone gets two minutes — so the
 * window is wider. It still has to be finite: a post frozen in `generating`
 * never publishes and never fails.
 */
const STUCK_GENERATING_MS = 20 * 60_000;

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

async function safePublisherTick(): Promise<void> {
  try {
    await reclaimStuckPublishing(STUCK_PUBLISHING_MS);
    await reclaimStuckGenerating(STUCK_GENERATING_MS);
    await ensureJitSlots();
    const report = await publisherTick();
    if (report.queued > 0 || report.skipped > 0 || report.jit > 0) {
      logger.info(report, 'publisher tick');
    }
  } catch (err) {
    logger.error({ err }, 'publisher tick failed');
  }
}

export function startScheduler(): void {
  if (running) return;
  running = true;

  workerPool.start();
  startAdminBot();

  // Run once at boot so a restart does not leave a gap the size of the interval.
  void safePlanTick();
  plannerTimer = setInterval(() => void safePlanTick(), env.PLANNER_TICK_SECONDS * 1000);
  plannerTimer.unref();

  void safePublisherTick();
  publisherTimer = setInterval(() => void safePublisherTick(), env.PUBLISHER_TICK_SECONDS * 1000);
  publisherTimer.unref();

  logger.info(
    { plannerSeconds: env.PLANNER_TICK_SECONDS, publisherSeconds: env.PUBLISHER_TICK_SECONDS },
    'scheduler started',
  );
}

export async function stopScheduler(): Promise<void> {
  running = false;
  if (plannerTimer) clearInterval(plannerTimer);
  if (publisherTimer) clearInterval(publisherTimer);
  stopAdminBot();
  await workerPool.stop();
}
