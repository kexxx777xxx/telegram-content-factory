import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeyUsage, rateLimitState } from '../db/schema.js';
import { logger } from '../logger.js';
import type { LlmUsage } from './provider.js';

/**
 * Token bucket + circuit breaker, keyed on `(api_key_id, model)`.
 *
 * Deliberately per key, with no attempt to infer which keys share an upstream
 * account — see docs/adr/0003-rate-limit-per-key.md. If two keys really do
 * share a quota, the second one discovers it through its own 429: one wasted
 * request, versus falsely blocking a working key and silently missing slots.
 */

const WINDOW_SECONDS = 60;

export interface AcquireDenied {
  ok: false;
  /** When the caller may try again — becomes the job's `run_after`. */
  retryAt: Date;
  reason: 'circuit_open' | 'rpm_exceeded' | 'daily_budget';
}

export type AcquireResult = { ok: true } | AcquireDenied;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Claims one request slot. Never blocks: a denial carries `retryAt` so the
 * worker reschedules the job and moves on to another one instead of sleeping
 * and holding a slot in the pool.
 */
export async function acquire(
  apiKeyId: string,
  model: string,
  limits: { rpmLimit?: number | null; dailyRequestBudget?: number | null },
): Promise<AcquireResult> {
  if (limits.dailyRequestBudget != null) {
    const [used] = await db
      .select({ total: sql<number>`coalesce(sum(${apiKeyUsage.requests}), 0)::int` })
      .from(apiKeyUsage)
      .where(and(eq(apiKeyUsage.apiKeyId, apiKeyId), eq(apiKeyUsage.day, today())));

    if ((used?.total ?? 0) >= limits.dailyRequestBudget) {
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);
      return { ok: false, retryAt: tomorrow, reason: 'daily_budget' };
    }
  }

  /*
   * One statement so concurrent workers cannot both read "1 slot left" and both
   * take it. The counter is incremented before we know whether the request is
   * allowed; when it is not, the extra tick only makes the next decision more
   * conservative, and the window resets it anyway. Failing safe beats a second
   * round-trip on the hot path.
   */
  const [state] = await db
    .insert(rateLimitState)
    .values({ apiKeyId, model, windowStart: new Date(), requestsUsed: 1 })
    .onConflictDoUpdate({
      target: [rateLimitState.apiKeyId, rateLimitState.model],
      set: {
        windowStart: sql`case when ${rateLimitState.windowStart} < now() - interval '${sql.raw(String(WINDOW_SECONDS))} seconds'
                         then now() else ${rateLimitState.windowStart} end`,
        requestsUsed: sql`case when ${rateLimitState.windowStart} < now() - interval '${sql.raw(String(WINDOW_SECONDS))} seconds'
                          then 1 else ${rateLimitState.requestsUsed} + 1 end`,
        updatedAt: new Date(),
      },
    })
    .returning({
      requestsUsed: rateLimitState.requestsUsed,
      windowStart: rateLimitState.windowStart,
      blockedUntil: rateLimitState.blockedUntil,
    });

  if (!state) return { ok: true };

  const now = Date.now();

  if (state.blockedUntil && state.blockedUntil.getTime() > now) {
    return { ok: false, retryAt: state.blockedUntil, reason: 'circuit_open' };
  }

  if (limits.rpmLimit != null && state.requestsUsed > limits.rpmLimit) {
    return {
      ok: false,
      retryAt: new Date(state.windowStart.getTime() + WINDOW_SECONDS * 1000),
      reason: 'rpm_exceeded',
    };
  }

  return { ok: true };
}

/**
 * Opens the circuit for this exact `(key, model)` pair. Every other worker then
 * skips it instantly instead of spending a 60-second timeout rediscovering the
 * same limit — which is what turns a quota hit into a skipped chain step rather
 * than a stalled queue.
 */
export async function openCircuit(
  apiKeyId: string,
  model: string,
  retryAfterMs: number | undefined,
  reason: string,
): Promise<Date> {
  // Vendors sometimes omit retryDelay; a minute is long enough to stop the
  // stampede and short enough not to idle a key that recovered sooner.
  const blockedUntil = new Date(Date.now() + (retryAfterMs ?? 60_000));

  await db
    .insert(rateLimitState)
    .values({ apiKeyId, model, blockedUntil, lastError: reason, requestsUsed: 0 })
    .onConflictDoUpdate({
      target: [rateLimitState.apiKeyId, rateLimitState.model],
      set: { blockedUntil, lastError: reason, updatedAt: new Date() },
    });

  logger.warn({ apiKeyId, model, blockedUntil, reason }, 'circuit opened for key/model pair');
  return blockedUntil;
}

export async function closeCircuit(apiKeyId: string, model: string): Promise<void> {
  await db
    .update(rateLimitState)
    .set({ blockedUntil: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(rateLimitState.apiKeyId, apiKeyId), eq(rateLimitState.model, model)));
}

export async function recordUsage(
  apiKeyId: string,
  model: string,
  usage: LlmUsage,
  failed = false,
): Promise<void> {
  await db
    .insert(apiKeyUsage)
    .values({
      apiKeyId,
      day: today(),
      model,
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      failures: failed ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [apiKeyUsage.apiKeyId, apiKeyUsage.day, apiKeyUsage.model],
      set: {
        requests: sql`${apiKeyUsage.requests} + 1`,
        inputTokens: sql`${apiKeyUsage.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${apiKeyUsage.outputTokens} + ${usage.outputTokens}`,
        failures: sql`${apiKeyUsage.failures} + ${failed ? 1 : 0}`,
        updatedAt: new Date(),
      },
    });
}

/** Pairs currently blocked — the dashboard's "why is nothing generating" view. */
export async function blockedPairs(): Promise<
  { apiKeyId: string; model: string; blockedUntil: Date; lastError: string | null }[]
> {
  const rows = await db
    .select({
      apiKeyId: rateLimitState.apiKeyId,
      model: rateLimitState.model,
      blockedUntil: rateLimitState.blockedUntil,
      lastError: rateLimitState.lastError,
    })
    .from(rateLimitState)
    .where(sql`${rateLimitState.blockedUntil} > now()`);

  return rows.filter(
    (r): r is { apiKeyId: string; model: string; blockedUntil: Date; lastError: string | null } =>
      r.blockedUntil !== null,
  );
}
