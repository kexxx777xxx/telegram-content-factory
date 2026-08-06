import type { AiAction, KeyLevel } from '@tcf/shared';
import { logger } from '../logger.js';
import { renderPrompt, resolvePrompt } from '../prompts/resolve.js';
import { resolveChain } from './chains.js';
import { providers } from './gemini.js';
import { resolveKey } from './keys.js';
import { acquire, closeCircuit, openCircuit, recordUsage } from './rateLimiter.js';
import { LlmError, type LlmUsage } from './provider.js';
import { logEnabled, record } from '../services/activityLog.js';

/** One row of the diagnostic trail: why each model/key pair was used or skipped. */
export interface ChainAttempt {
  position: number;
  model: string;
  keyLabel: string;
  keyLevel: KeyLevel;
  outcome: 'success' | 'rate_limited' | 'auth_failed' | 'invalid' | 'error' | 'skipped';
  detail?: string;
  retryAt?: string;
  durationMs?: number;
}

export interface ChainRunResult {
  text: string;
  model: string;
  apiKeyId: string;
  promptId: string;
  promptVersion: number;
  usage: LlmUsage;
  attempts: ChainAttempt[];
}

/**
 * Every step and key was unusable. `retryAt` is the earliest moment anything
 * might work again — the queue turns it into `run_after` instead of burning
 * retry attempts on a wall it already knows about.
 */
export class ChainExhaustedError extends Error {
  constructor(
    readonly action: AiAction,
    readonly attempts: ChainAttempt[],
    readonly retryAt?: Date,
  ) {
    super(`Ланцюжок «${action}» вичерпано: жоден крок не спрацював`);
    this.name = 'ChainExhaustedError';
  }
}

export class ChainMissingError extends Error {}

export interface RunChainOptions {
  action: AiAction;
  projectId: string;
  variables: Record<string, string | number | undefined>;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Present when the call belongs to a post; without it nothing is logged. */
  postId?: string;
}

/**
 * Walks the chain step by step, key by key.
 *
 * The ordering matters: a step that is rate limited or circuit-broken is
 * skipped *without spending its timeout*, so a quota wall costs milliseconds
 * rather than 60 seconds per model. That is the difference between one slow
 * slot and a stalled worker pool.
 */
export async function runChain(options: RunChainOptions): Promise<ChainRunResult> {
  const chain = await resolveChain(options.action, options.projectId);
  if (!chain || chain.steps.length === 0) {
    throw new ChainMissingError(`Для дії «${options.action}» не налаштовано жодного ланцюжка моделей`);
  }

  const steps = chain.steps;

  const attempts: ChainAttempt[] = [];
  const journaling = await logEnabled(options.projectId);
  let earliestRetry: Date | undefined;
  /** A key that failed auth is dead for the whole run, not just this step. */
  const deadKeys = new Set<string>();

  for (const step of steps) {
    const provider = providers[step.provider];
    if (!provider) {
      attempts.push({
        position: step.position,
        model: step.model,
        keyLabel: '—',
        keyLevel: 'default',
        outcome: 'invalid',
        detail: `Невідомий провайдер ${step.provider}`,
      });
      continue;
    }

    const key = await resolveKey(options.projectId, step.provider, options.action);

    if (!key) {
      attempts.push({
        position: step.position,
        model: step.model,
        keyLabel: '—',
        keyLevel: 'default',
        outcome: 'skipped',
        detail: 'Немає доступного API-ключа: задайте дефолтний у налаштуваннях',
      });
      continue;
    }

    /*
     * Checked before the prompt is resolved and rendered: that is two queries
     * and a render for a step that cannot run. The attempt is still recorded —
     * the trail exists to answer "why did nothing generate", and a step that
     * vanishes from it without explanation is the one question it cannot
     * answer.
     */
    if (deadKeys.has(key.id)) {
      attempts.push({
        position: step.position,
        model: step.model,
        keyLabel: key.label,
        keyLevel: key.level,
        outcome: 'skipped',
        detail: 'Ключ уже відхилив автентифікацію на попередньому кроці цього запуску',
      });
      continue;
    }

    const prompt = await resolvePrompt(options.action, options.projectId, step.model, step.promptId);
    const rendered = renderPrompt(prompt.body, options.variables);

    const gate = await acquire(key.id, step.model, {
      rpmLimit: key.rpmLimit,
      dailyRequestBudget: key.dailyRequestBudget,
    });

    if (!gate.ok) {
      earliestRetry = earlier(earliestRetry, gate.retryAt);
      attempts.push({
        position: step.position,
        model: step.model,
        keyLabel: key.label,
        keyLevel: key.level,
        outcome: 'skipped',
        detail: describeDenial(gate.reason),
        retryAt: gate.retryAt.toISOString(),
      });
      continue;
    }

    const startedAt = Date.now();
    if (journaling) {
      await record({
        projectId: options.projectId,
        postId: options.postId ?? null,
        kind: 'model_request',
        action: options.action,
        model: step.model,
        keyLabel: key.label,
        message: `Запит до ${step.model} (${options.action})`,
        detail: rendered,
      });
    }

    try {
      const result = await provider.generate(key.secret, {
        model: step.model,
        prompt: rendered,
        temperature: step.params.temperature,
        maxOutputTokens: step.params.maxOutputTokens,
        thinkingBudget: step.params.thinkingBudget,
        responseSchema: options.responseSchema,
        timeoutMs: options.timeoutMs,
      });

      await recordUsage(key.id, step.model, result.usage);
      await closeCircuit(key.id, step.model);

      if (journaling) {
        await record({
          projectId: options.projectId,
          postId: options.postId ?? null,
          kind: 'model_response',
          action: options.action,
          model: step.model,
          keyLabel: key.label,
          message: `Відповідь від ${step.model}`,
          detail: result.text,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: Date.now() - startedAt,
        });
      }

      attempts.push({
        position: step.position,
        model: step.model,
        keyLabel: key.label,
        keyLevel: key.level,
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });

      return {
        text: result.text,
        model: step.model,
        apiKeyId: key.id,
        promptId: prompt.id,
        promptVersion: prompt.version,
        usage: result.usage,
        attempts,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof LlmError ? err : new LlmError('unknown', String(err));
      await recordUsage(key.id, step.model, { inputTokens: 0, outputTokens: 0 }, true);

      if (journaling) {
        await record({
          projectId: options.projectId,
          postId: options.postId ?? null,
          kind: 'model_response',
          action: options.action,
          model: step.model,
          keyLabel: key.label,
          message: `${step.model} не впорався: ${error.kind}`,
          detail: error.message,
          durationMs,
          ok: false,
        });
      }

      if (error.kind === 'rate_limit') {
        const blockedUntil = await openCircuit(key.id, step.model, error.retryAfterMs, error.message);
        earliestRetry = earlier(earliestRetry, blockedUntil);
        attempts.push({
          position: step.position,
          model: step.model,
          keyLabel: key.label,
          keyLevel: key.level,
          outcome: 'rate_limited',
          detail: error.message,
          retryAt: blockedUntil.toISOString(),
          durationMs,
        });
        continue;
      }

      if (error.kind === 'auth') {
        deadKeys.add(key.id);
        attempts.push({
          position: step.position,
          model: step.model,
          keyLabel: key.label,
          keyLevel: key.level,
          outcome: 'auth_failed',
          detail: error.message,
          durationMs,
        });
        continue;
      }

      attempts.push({
        position: step.position,
        model: step.model,
        keyLabel: key.label,
        keyLevel: key.level,
        outcome: error.kind === 'invalid' ? 'invalid' : 'error',
        detail: error.message,
        durationMs,
      });

    }
  }

  logger.warn({ action: options.action, projectId: options.projectId, attempts }, 'chain exhausted');
  throw new ChainExhaustedError(options.action, attempts, earliestRetry);
}

function earlier(current: Date | undefined, candidate: Date): Date {
  return current === undefined || candidate < current ? candidate : current;
}

function describeDenial(reason: 'circuit_open' | 'rpm_exceeded' | 'daily_budget'): string {
  switch (reason) {
    case 'circuit_open':
      return 'Пара «ключ + модель» заблокована після 429';
    case 'rpm_exceeded':
      return 'Вичерпано ліміт запитів за хвилину для цього ключа';
    case 'daily_budget':
      return 'Вичерпано денний бюджет запитів для цього ключа';
  }
}
