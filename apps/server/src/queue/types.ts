import type { JobType } from '@tcf/shared';
import type { Job } from '../db/schema.js';
import type { Logger } from '../logger.js';

export interface JobContext {
  job: Job;
  log: Logger;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/**
 * Asks the queue to try again later without spending a retry attempt.
 *
 * Quota exhaustion is the motivating case: a project blocked for two hours must
 * not burn through `max_attempts` in the meantime and land in the dead letter
 * pile with a wall it was always going to hit.
 */
export class RescheduleJob extends Error {
  constructor(
    readonly runAfter: Date,
    reason: string,
  ) {
    super(reason);
    this.name = 'RescheduleJob';
  }
}

/** Terminal by nature — retrying cannot change the outcome. */
export class PermanentJobFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PermanentJobFailure';
  }
}

export type HandlerRegistry = Partial<Record<JobType, JobHandler>>;
