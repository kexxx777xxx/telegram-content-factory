import type { AiAction } from '@tcf/shared';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batchJobs, projects, type BatchJob } from '../db/schema.js';
import { logger } from '../logger.js';
import { record } from '../services/activityLog.js';
import { resolveChain } from './chains.js';
import { providers } from './gemini.js';
import { resolveKey } from './keys.js';
import { renderPrompt, resolvePrompt } from '../prompts/resolve.js';

/**
 * The batch tier costs half and answers within 24 hours — a trade that only
 * works when the result is not needed sooner than that.
 *
 * So every submission carries a deadline of ours. Past it the caller stops
 * waiting and generates synchronously; the batch job is cancelled rather than
 * left to bill us for an answer nobody will read. Without that rule "cheaper"
 * quietly becomes "the slot missed its time".
 */
export const BATCH_TURNAROUND_MS = 24 * 3600_000;

/** Below this much slack, batching cannot pay off before the slot arrives. */
export const BATCH_MIN_SLACK_MS = BATCH_TURNAROUND_MS + 2 * 3600_000;

/**
 * Whether this action *could* go to the batch tier for this project.
 *
 * The planner needs this before the work starts, not when it runs. Eligibility
 * is decided from the slack left before the slot — and by the time a generation
 * job wakes up at its lead time, that slack is a couple of hours, far under the
 * vendor's day. Asked at planning time instead, the answer is still meaningful,
 * and the job can be started early enough to use the cheap tier.
 */
export async function canBatch(projectId: string, action: AiAction): Promise<boolean> {
  const [project] = await db
    .select({ batchMode: projects.batchMode })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project?.batchMode === 'off') return false;

  const chain = await resolveChain(action, projectId);
  const step = chain?.steps[0];
  if (!step) return false;
  if (!providers[step.provider]?.submitBatch) return false;

  const key = await resolveKey(projectId, step.provider, action);
  return key?.batchEnabled === true;
}

export interface BatchSubmitInput {
  action: AiAction;
  projectId: string;
  postId?: string | null;
  variables: Record<string, string | number | undefined>;
  responseSchema?: Record<string, unknown>;
  /** When the answer stops being useful. */
  deadline: Date;
}

/**
 * Queues the first step of the action's chain on the batch tier.
 *
 * Only the first step: fallbacks exist for when a model is unavailable *now*,
 * and a batch job that will not be read for a day has no such moment to react
 * to. If it fails, the synchronous path walks the whole chain as usual.
 */
export async function submitBatch(input: BatchSubmitInput): Promise<BatchJob | null> {
  const chain = await resolveChain(input.action, input.projectId);
  const step = chain?.steps[0];
  if (!step) return null;

  const provider = providers[step.provider];
  if (!provider?.submitBatch) return null;

  const key = await resolveKey(input.projectId, step.provider, input.action);
  if (!key || !key.batchEnabled) return null;

  const prompt = await resolvePrompt(input.action, input.projectId, step.model, step.promptId);
  const rendered = renderPrompt(prompt.body, input.variables);

  try {
    const handle = await provider.submitBatch(key.secret, {
      model: step.model,
      prompt: rendered,
      temperature: step.params.temperature,
      maxOutputTokens: step.params.maxOutputTokens,
      thinkingBudget: step.params.thinkingBudget,
      responseSchema: input.responseSchema,
    });

    const [row] = await db
      .insert(batchJobs)
      .values({
        projectId: input.projectId,
        postId: input.postId ?? null,
        apiKeyId: key.id,
        action: input.action,
        model: step.model,
        providerName: handle.name,
        state: handle.state,
        promptId: prompt.id === 'builtin' ? null : prompt.id,
        promptVersion: prompt.version,
        deadline: input.deadline,
      })
      .returning();

    if (row) {
      await record({
        projectId: input.projectId,
        postId: input.postId ?? null,
        kind: 'note',
        action: input.action,
        model: step.model,
        keyLabel: key.label,
        source: 'auto',
        message: `Відправлено в batch (−50% ціни, до 24 год): ${handle.name}`,
      });
      logger.info(
        { project_id: input.projectId, action: input.action, name: handle.name },
        'batch submitted',
      );
    }
    return row ?? null;
  } catch (err) {
    // Batch is an optimisation. A key without the paid tier, a model that does
    // not support it — every such failure must fall through to the normal call
    // rather than cost the project its post.
    logger.warn({ err, action: input.action }, 'batch submit failed, falling back to sync');
    return null;
  }
}

export interface BatchOutcome {
  state: BatchJob['state'];
  text?: string;
  image?: { data: Buffer; mimeType: string };
  job: BatchJob;
}

/** Reads a job's current state, updating the row when it has moved. */
export async function collectBatch(jobId: string): Promise<BatchOutcome | null> {
  const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, jobId)).limit(1);
  if (!job) return null;
  if (job.state !== 'pending') {
    return { state: job.state, text: job.resultText ?? undefined, job };
  }

  const provider = providers.gemini;
  if (!provider?.pollBatch) return { state: 'failed', job };

  const key = await keySecret(job.apiKeyId);
  if (!key) return { state: 'failed', job };

  const result = await provider.pollBatch(key, job.providerName);
  if (result.state === 'pending') return { state: 'pending', job };

  const [updated] = await db
    .update(batchJobs)
    .set({
      state: result.state,
      resultText: result.text ?? null,
      error: result.error ?? null,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      updatedAt: new Date(),
    })
    .where(eq(batchJobs.id, job.id))
    .returning();

  const final = updated ?? job;

  await record({
    projectId: job.projectId,
    postId: job.postId,
    kind: 'note',
    action: job.action,
    model: job.model,
    source: 'auto',
    message:
      result.state === 'succeeded'
        ? `Batch завершився за ${job.model}`
        : `Batch завершився невдало (${result.state}): ${result.error ?? 'без деталей'}`,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    ok: result.state === 'succeeded',
  });

  return { state: result.state, text: result.text, image: result.image, job: final };
}

/** The pending job for this post and action, if one was submitted earlier. */
export async function findBatch(
  postId: string,
  action: AiAction,
): Promise<BatchJob | undefined> {
  const [row] = await db
    .select()
    .from(batchJobs)
    .where(
      and(
        eq(batchJobs.postId, postId),
        eq(batchJobs.action, action),
        inArray(batchJobs.state, ['pending', 'succeeded']),
      ),
    )
    .limit(1);
  return row;
}

/** The pending job for a project-wide action (topic refills have no post). */
export async function findProjectBatch(
  projectId: string,
  action: AiAction,
): Promise<BatchJob | undefined> {
  const [row] = await db
    .select()
    .from(batchJobs)
    .where(
      and(
        eq(batchJobs.projectId, projectId),
        isNull(batchJobs.postId),
        eq(batchJobs.action, action),
        inArray(batchJobs.state, ['pending', 'succeeded']),
      ),
    )
    .limit(1);
  return row;
}

/** Marks a job consumed so a regeneration does not re-use yesterday's answer. */
export async function dropBatch(jobId: string): Promise<void> {
  await db.delete(batchJobs).where(eq(batchJobs.id, jobId));
}

/**
 * Gives up on jobs whose deadline passed: cancel at the vendor, delete here.
 *
 * Leaving them would keep a post waiting for an answer it can no longer use,
 * and keep paying for it.
 */
export async function abandonExpired(): Promise<number> {
  const stale = await db
    .select()
    .from(batchJobs)
    .where(and(eq(batchJobs.state, 'pending'), lt(batchJobs.deadline, new Date())));

  for (const job of stale) {
    const key = await keySecret(job.apiKeyId);
    if (key) await providers.gemini?.cancelBatch?.(key, job.providerName);
    await db.delete(batchJobs).where(eq(batchJobs.id, job.id));
    await record({
      projectId: job.projectId,
      postId: job.postId,
      kind: 'note',
      action: job.action,
      model: job.model,
      source: 'auto',
      message: 'Batch не встиг до дедлайну — скасовано, генерація піде звичайним викликом',
      ok: false,
    });
  }

  if (stale.length > 0) logger.warn({ count: stale.length }, 'abandoned expired batch jobs');
  return stale.length;
}

async function keySecret(apiKeyId: string): Promise<string | null> {
  const { apiKeys } = await import('../db/schema.js');
  const { decryptSecret } = await import('../crypto/secrets.js');
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).limit(1);
  return row ? decryptSecret(row.secretEnc) : null;
}
