import { JOB_TYPES, type JobType } from '@tcf/shared';
import { ChainExhaustedError, ChainMissingError } from '../ai/chain.js';
import { generatePostText, PostNotFoundError } from '../services/posts.js';
import { NotPublishableError, publishReadyPost, PublishThrottled } from '../services/publish.js';
import { TelegramApiError } from '../telegram/api.js';
import { getProject } from '../services/projects.js';
import { replenishTopics } from '../services/topics.js';
import { runPrune } from './prune.js';
import { PermanentJobFailure, RescheduleJob, type HandlerRegistry, type JobContext } from './types.js';

async function handleReplenishTopics({ job, log }: JobContext): Promise<void> {
  if (!job.projectId) throw new PermanentJobFailure('replenish_topics без projectId');

  const project = await getProject(job.projectId);
  const count = Number((job.payload as { count?: unknown }).count ?? 20);

  try {
    const report = await replenishTopics(project.id, count, project.persona, project.language);
    log.info({ inserted: report.inserted, duplicates: report.duplicates }, 'replenish finished');
  } catch (err) {
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
  } catch (err) {
    if (err instanceof PostNotFoundError || err instanceof ChainMissingError) {
      throw new PermanentJobFailure(err.message);
    }
    if (err instanceof ChainExhaustedError) {
      throw new RescheduleJob(err.retryAt ?? new Date(Date.now() + 15 * 60_000), err.message);
    }
    throw err;
  }
}

async function handlePublishPost({ job, log }: JobContext): Promise<void> {
  const postId = (job.payload as { postId?: unknown }).postId;
  if (typeof postId !== 'string') throw new PermanentJobFailure('publish_post без postId');

  try {
    const outcome = await publishReadyPost(postId);
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

  await handleGeneratePost(ctx);
  await handlePublishPost(ctx);
}

async function handlePrune({ log }: JobContext): Promise<void> {
  const report = await runPrune();
  log.info(report, 'prune finished');
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
};

export const IMPLEMENTED_JOB_TYPES: ReadonlySet<JobType> = new Set(
  JOB_TYPES.filter((type) => handlers[type] !== undefined),
);

export function isImplemented(type: JobType): boolean {
  return IMPLEMENTED_JOB_TYPES.has(type);
}
