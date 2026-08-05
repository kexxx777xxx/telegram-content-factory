import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { closeDatabase, db } from '../src/db/client.js';
import { assertTestDatabase } from './guard.js';
import { apiKeys, jobs, posts, projects, topics } from '../src/db/schema.js';
import { providers } from '../src/ai/gemini.js';
import { LlmError, type LlmProvider } from '../src/ai/provider.js';
import { ensureDefaultChains } from '../src/ai/chains.js';
import { ensureDefaultPrompts } from '../src/prompts/resolve.js';
import { planTick } from '../src/scheduler/planner.js';
import { claimJob, completeJob, failJob, rescheduleJob } from '../src/queue/claim.js';
import { handlers } from '../src/queue/handlers.js';
import { PermanentJobFailure, RescheduleJob } from '../src/queue/types.js';
import { logger } from '../src/logger.js';

/**
 * The scenario the whole design exists for: many projects sharing one slot and
 * one quota.
 *
 * A fake provider replaces Gemini so the run is deterministic and free, and so
 * a 429 can be produced on demand — the thing that is impossible to test
 * against a real API without actually exhausting a quota.
 */

const PROJECT_COUNT = 50;
const SLOT_MODELS = ['fake-primary', 'fake-secondary'];

interface CallLog {
  model: string;
  at: number;
}

class FakeProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  calls: CallLog[] = [];
  /** Models that answer 429 until cleared. */
  rateLimited = new Set<string>();
  latencyMs = 0;

  async generate(_apiKey: string, request: { model: string }) {
    this.calls.push({ model: request.model, at: Date.now() });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

    if (this.rateLimited.has(request.model)) {
      throw new LlmError('rate_limit', `quota exhausted for ${request.model}`, 60_000, 429);
    }
    return {
      text: '<b>Згенеровано</b> у тесті.',
      model: request.model,
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  }

  async listModels() {
    return SLOT_MODELS.map((id) => ({
      id,
      displayName: id,
      inputTokenLimit: 1000,
      outputTokenLimit: 1000,
      supportsText: true,
      supportsImage: false,
    }));
  }
}

const fake = new FakeProvider();
const realGemini = providers.gemini!;

async function reset(): Promise<void> {
  assertTestDatabase();
  await db.execute(
    sql`truncate ${jobs}, ${posts}, ${topics}, ${apiKeys}, ${projects} restart identity cascade`,
  );
  fake.calls = [];
  fake.rateLimited.clear();
  fake.latencyMs = 0;
}

/** Point every chain at the fake models instead of the real catalog. */
async function seedConfig(): Promise<void> {
  await ensureDefaultPrompts();
  await ensureDefaultChains();
  await db.execute(sql`
    update model_chain_steps set model = case position
      when 0 then ${SLOT_MODELS[0]}
      else ${SLOT_MODELS[1]}
    end
  `);
  await db.execute(sql`delete from model_chain_steps where position > 1`);
}

async function seedProjects(count: number): Promise<void> {
  await db.insert(apiKeys).values({
    provider: 'gemini',
    label: 'shared',
    secretEnc: encryptSecret('fake-secret'),
    isDefault: true,
  });

  for (let i = 0; i < count; i++) {
    const [project] = await db
      .insert(projects)
      .values({
        slug: `load-${i}`,
        name: `Load ${i}`,
        status: 'active',
        telegramChannelId: `@load_channel_${i}`,
        // Isolates the queue and throttling behaviour under test; the image
        // pipeline has its own suite.
        imageMode: 'none',
        postsBuffer: 3,
        topicsBufferMin: 0,
        leadTimeMinutes: 24 * 60,
        // Every project on the same slot — the pile-up this design is about.
        schedule: { mode: 'slots', slots: ['09:00'], weekdays: [] },
      })
      .returning({ id: projects.id });

    await db.insert(topics).values(
      Array.from({ length: 4 }, (_, k) => ({
        projectId: project!.id,
        title: `Тема ${i}-${k}`,
        normalizedHash: `load-${i}-${k}`,
        status: 'new' as const,
        source: 'manual' as const,
      })),
    );
  }
}

/** Runs the pool until the queue drains, mirroring worker.ts semantics. */
async function drainQueue(concurrency = 4, maxMs = 60_000): Promise<{ processed: number }> {
  const deadline = Date.now() + maxMs;
  let processed = 0;

  const loop = async (id: string) => {
    while (Date.now() < deadline) {
      const job = await claimJob(id);
      if (!job) return;

      const handler = handlers[job.type];
      if (!handler) {
        await failJob(job.id, 'no handler', true);
        continue;
      }

      try {
        await handler({ job, log: logger });
        await completeJob(job.id);
        processed++;
      } catch (err) {
        if (err instanceof RescheduleJob) {
          await rescheduleJob(job.id, err.runAfter, err.message);
          // Keep looping, exactly as WorkerPool does: the parked job now has a
          // future run_after so it cannot be re-claimed, and returning here
          // would leave the rest of the queue untouched.
          continue;
        }
        await failJob(job.id, String(err), err instanceof PermanentJobFailure);
        processed++;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(`w${i}`)));
  return { processed };
}

beforeEach(async () => {
  providers.gemini = fake;
  await reset();
  await seedConfig();
});

afterAll(async () => {
  providers.gemini = realGemini;
  await closeDatabase();
});

describe(`load: ${PROJECT_COUNT} projects sharing one slot`, () => {
  it('plans every project without double-booking a slot', async () => {
    await seedProjects(PROJECT_COUNT);

    const first = await planTick();
    expect(first.projects).toBe(PROJECT_COUNT);
    expect(first.postsPlanned).toBe(PROJECT_COUNT * 3);

    // The second pass must add nothing: planning is idempotent, and posts_slot_uniq
    // is the backstop if the advisory lock were ever lost.
    const second = await planTick();
    expect(second.postsPlanned).toBe(0);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts);
    expect(count).toBe(PROJECT_COUNT * 3);
  });

  it('spreads generation start times instead of firing them together', async () => {
    await seedProjects(PROJECT_COUNT);
    await planTick();

    const rows = await db.select({ runAfter: jobs.runAfter }).from(jobs).where(eq(jobs.type, 'generate_post'));
    const distinct = new Set(rows.map((r) => r.runAfter.getTime()));

    // Without the per-project offset every one of these would be identical.
    expect(distinct.size).toBeGreaterThan(PROJECT_COUNT / 2);
  });

  it('does not stampede a rate-limited model', async () => {
    await seedProjects(10);
    await planTick();
    await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) });

    fake.rateLimited.add(SLOT_MODELS[0]!);
    await drainQueue();

    const primaryCalls = fake.calls.filter((c) => c.model === SLOT_MODELS[0]).length;
    const secondaryCalls = fake.calls.filter((c) => c.model === SLOT_MODELS[1]).length;

    /*
     * The circuit bounds the stampede by the pool size, not to a single
     * request: up to `concurrency` workers can pass acquire() before the first
     * 429 is recorded. What matters is that it stays bounded — without the
     * breaker every one of the 30 jobs would hit the exhausted model.
     */
    expect(primaryCalls).toBeGreaterThanOrEqual(1);
    expect(primaryCalls).toBeLessThanOrEqual(4);
    expect(secondaryCalls).toBeGreaterThan(primaryCalls);
  });

  it('still fills the buffer when the primary model is exhausted', async () => {
    await seedProjects(10);
    await planTick();
    await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) });

    fake.rateLimited.add(SLOT_MODELS[0]!);
    await drainQueue();

    const [{ ready }] = await db
      .select({ ready: sql<number>`count(*) filter (where status = 'ready')::int` })
      .from(posts);

    // The fallback step is what turns an exhausted quota into a slower slot
    // rather than a missed one.
    expect(ready).toBe(30);
  });

  it('parks jobs instead of blocking workers when every model is down', async () => {
    await seedProjects(5);
    await planTick();
    await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) });

    for (const model of SLOT_MODELS) fake.rateLimited.add(model);

    const startedAt = Date.now();
    await drainQueue(4, 20_000);
    const elapsed = Date.now() - startedAt;

    const parked = await db
      .select({ status: jobs.status, attempts: jobs.attempts, runAfter: jobs.runAfter })
      .from(jobs)
      .where(eq(jobs.type, 'generate_post'));

    // Every job is waiting on a future moment with its retries intact, and the
    // pool returned promptly rather than sleeping on the wall.
    expect(parked.every((j) => j.status === 'pending')).toBe(true);
    expect(parked.every((j) => j.attempts === 0)).toBe(true);
    expect(parked.every((j) => j.runAfter.getTime() > Date.now())).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('recovers once the quota window closes', async () => {
    await seedProjects(5);
    await planTick();
    await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) });

    for (const model of SLOT_MODELS) fake.rateLimited.add(model);
    await drainQueue(4, 10_000);

    fake.rateLimited.clear();
    await db.execute(sql`update rate_limit_state set blocked_until = null`);
    await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) });

    await drainQueue();

    const [{ ready }] = await db
      .select({ ready: sql<number>`count(*) filter (where status = 'ready')::int` })
      .from(posts);
    expect(ready).toBe(15);
  });
});
