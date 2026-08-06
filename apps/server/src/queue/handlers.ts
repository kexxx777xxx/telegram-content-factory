import { JOB_TYPES, type JobType } from '@tcf/shared';
import { ChainExhaustedError, ChainMissingError } from '../ai/chain.js';
import { generatePostText, PostNotFoundError } from '../services/posts.js';
import { NotPublishableError, publishReadyPost, PublishThrottled } from '../services/publish.js';
import { TelegramApiError } from '../telegram/api.js';
import { getProject } from '../services/projects.js';
import { replenishTopics } from '../services/topics.js';
import { sendBackup } from '../services/backup.js';
import { runPrune } from './prune.js';
import { PermanentJobFailure, RescheduleJob, type HandlerRegistry, type JobContext } from './types.js';

async function handleReplenishTopics({ job, log }: JobContext): Promise<void> {
  if (!job.projectId) throw new PermanentJobFailure('replenish_topics без projectId');

  const project = await getProject(job.projectId);
  const count = Number((job.payload as { count?: unknown }).count ?? 20);

  try {
    // The scheduled refill is the one place batching is unambiguously right:
    // nothing waits on it, and the threshold is a minimum, so the bank still
    // has topics while the vendor takes its hours.
    const report = await replenishTopics(project.id, count, project.persona, project.language, {
      allowBatch: true,
    });

    if (report === 'batched') {
      throw new RescheduleJob(
        new Date(Date.now() + BATCH_POLL_MS),
        'Теми замовлені через batch, чекаємо на відповідь',
      );
    }

    log.info({ inserted: report.inserted, duplicates: report.duplicates }, 'replenish finished');
  } catch (err) {
    if (err instanceof RescheduleJob) throw err;
    if (err instanceof ChainMissingError) {
      throw new PermanentJobFailure(err.message);
    }
    if (err instanceof ChainExhaustedError) {
      // Every model and key is walled off right now. Wait for the earliest one
      // to reopen instead of spending attempts on a known-closed door.
      throw new RescheduleJob(err.retryAt ?? new Date(Date.now() + 15 * 60_000), err.message);
    }
    throw err;
  }
}

async function handleGeneratePost({ job, log }: JobContext): Promise<void> {
  const postId = (job.payload as { postId?: unknown }).postId;
  if (typeof postId !== 'string') throw new PermanentJobFailure('generate_post без postId');

  try {
    const outcome = await generatePostText(postId);
    log.info({ postId, outcome }, 'generate_post finished');

    if (outcome === 'batched') {
      // Parked on the batch tier. Rescheduling rather than failing is the whole
      // point: no attempt is spent, and the worker is free while the vendor
      // takes its hours.
      throw new RescheduleJob(
        new Date(Date.now() + BATCH_POLL_MS),
        'Чекає на відповідь batch-джоби',
      );
    }
  } catch (err) {
    if (err instanceof RescheduleJob) throw err;
    if (err instanceof PostNotFoundError || err instanceof ChainMissingError) {
      throw new PermanentJobFailure(err.message);
    }
    if (err instanceof ChainExhaustedError) {
      throw new RescheduleJob(err.retryAt ?? new Date(Date.now() + 15 * 60_000), err.message);
    }
    throw err;
  }
}

/** How often a parked job looks at its batch. Cheap call, no rush. */
const BATCH_POLL_MS = 15 * 60_000;

async function handlePublishPost({ job, log }: JobContext): Promise<void> {
  const postId = (job.payload as { postId?: unknown }).postId;
  if (typeof postId !== 'string') throw new PermanentJobFailure('publish_post без postId');

  try {
    const manual = (job.payload as { manual?: unknown }).manual === true;
    const outcome = await publishReadyPost(postId, manual ? 'manual' : 'auto');
    log.info({ postId, outcome }, 'publish finished');
  } catch (err) {
    if (err instanceof PublishThrottled) {
      // Telegram's own back-pressure. Waiting is the correct response, and it
      // must not cost the post one of its retries.
      throw new RescheduleJob(
        new Date(Date.now() + err.retryAfterSeconds * 1000 + 1000),
        err.message,
      );
    }
    if (err instanceof PostNotFoundError || err instanceof NotPublishableError) {
      throw new PermanentJobFailure(err.message);
    }
    // A rejected token is not going to start working on the fourth attempt.
    // Dying immediately with the reason is more useful than half an hour of
    // backoff hiding it.
    if (err instanceof TelegramApiError && err.isAuthFailure) {
      throw new PermanentJobFailure(`${err.message} — перевірте токен бота проєкту`);
    }
    throw err;
  }
}

/**
 * The just-in-time path: one job that generates and immediately publishes.
 *
 * Kept as a single job rather than two chained ones so a slot cannot end up
 * with a freshly generated post that nothing publishes.
 */
async function handleGenerateAndPublish(ctx: JobContext): Promise<void> {
  const postId = (ctx.job.payload as { postId?: unknown }).postId;
  if (typeof postId !== 'string') throw new PermanentJobFailure('generate_and_publish без postId');

  // A RescheduleJob thrown by generation propagates, so publishing never runs
  // on a post whose text has not arrived yet.
  await handleGeneratePost(ctx);
  await handlePublishPost(ctx);
}

async function handlePrune({ log }: JobContext): Promise<void> {
  const report = await runPrune();
  log.info(report, 'prune finished');
}

async function handleBackup({ log }: JobContext): Promise<void> {
  const meta = await sendBackup();
  log.info({ meta }, 'backup finished');
}

/**
 * Only registered types are ever enqueued (see `IMPLEMENTED_JOB_TYPES`), so a
 * half-built phase cannot fill the queue with jobs nothing can execute.
 */
export const handlers: HandlerRegistry = {
  generate_post: handleGeneratePost,
  publish_post: handlePublishPost,
  generate_and_publish: handleGenerateAndPublish,
  replenish_topics: handleReplenishTopics,
  prune: handlePrune,
  backup: handleBackup,
};

export const IMPLEMENTED_JOB_TYPES: ReadonlySet<JobType> = new Set(
  JOB_TYPES.filter((type) => handlers[type] !== undefined),
);

export function isImplemented(type: JobType): boolean {
  return IMPLEMENTED_JOB_TYPES.has(type);
}
