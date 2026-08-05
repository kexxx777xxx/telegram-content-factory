import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../src/db/client.js';
import { assertTestDatabase } from './guard.js';
import {
  apiKeys,
  jobs,
  modelChains,
  posts,
  projects,
  prompts,
  topics,
  type Project,
} from '../src/db/schema.js';
import { encryptSecret } from '../src/crypto/secrets.js';
import { claimJob, completeJob, failJob, rescheduleJob } from '../src/queue/claim.js';
import { enqueue, reclaimStuckJobs } from '../src/queue/enqueue.js';
import { acquire, openCircuit } from '../src/ai/rateLimiter.js';
import { resolveKey } from '../src/ai/keys.js';
import { launchPost, launchProject, NotLaunchableError } from '../src/services/publishNow.js';
import { ensureDefaultPrompts, resolvePrompt, savePromptVersion } from '../src/prompts/resolve.js';
import { insertTopics, needsReplenish, topicCounts } from '../src/services/topics.js';

/**
 * These run against real Postgres because the guarantees being tested *are*
 * Postgres features: SKIP LOCKED, partial unique indexes, interval arithmetic.
 * A mocked driver would only confirm the mock.
 */

async function reset(): Promise<void> {
  assertTestDatabase();
  await db.execute(
    sql`truncate ${jobs}, ${posts}, ${topics}, ${apiKeys}, ${projects} restart identity cascade`,
  );
}

async function makeProject(overrides: Partial<typeof projects.$inferInsert> = {}): Promise<Project> {
  const [row] = await db
    .insert(projects)
    .values({
      slug: `p-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Test',
      telegramChannelId: '@test_channel',
      schedule: { mode: 'slots', slots: ['09:00'], weekdays: [] },
      ...overrides,
    })
    .returning();
  return row!;
}

beforeEach(reset);
afterAll(async () => {
  await closeDatabase();
});

describe('queue claiming', () => {
  it('hands one job to exactly one worker under contention', async () => {
    for (let i = 0; i < 3; i++) await enqueue({ type: 'prune', dedupeKey: `c:${i}` });

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimJob(`worker-${i}`)),
    );
    const claimed = claims.filter((j) => j !== null);

    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((j) => j!.id)).size).toBe(3);
  });

  it('maps columns to camelCase, not the raw snake_case of returning *', async () => {
    // The bug this guards: raw SQL bypasses Drizzle's mapping, so `projectId`
    // read as undefined while `project_id` held the value — and only fields
    // whose names match in both conventions kept working.
    const project = await makeProject();
    await enqueue({
      type: 'replenish_topics',
      projectId: project.id,
      payload: { count: 7 },
      dedupeKey: 'map:1',
    });

    const job = await claimJob('w');
    expect(job?.projectId).toBe(project.id);
    expect(job?.payload).toEqual({ count: 7 });
    expect(job?.maxAttempts).toBe(5);
    expect(job?.runAfter).toBeInstanceOf(Date);
  });

  it('refuses a duplicate while one is in flight and allows reuse after', async () => {
    expect(await enqueue({ type: 'prune', dedupeKey: 'dup' })).not.toBeNull();
    expect(await enqueue({ type: 'prune', dedupeKey: 'dup' })).toBeNull();

    const job = await claimJob('w');
    await completeJob(job!.id);

    // Recurring slots depend on this: the same key must be usable again once
    // the previous job finishes.
    expect(await enqueue({ type: 'prune', dedupeKey: 'dup' })).not.toBeNull();
  });

  it('does not spend an attempt when rescheduling', async () => {
    await enqueue({ type: 'prune', dedupeKey: 'r:1' });
    const job = await claimJob('w');
    expect(job!.attempts).toBe(1);

    await rescheduleJob(job!.id, new Date(Date.now() + 60_000), 'quota');
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job!.id));

    expect(after!.status).toBe('pending');
    expect(after!.attempts).toBe(0);
  });

  it('backs off exponentially and dies once attempts run out', async () => {
    await enqueue({ type: 'prune', dedupeKey: 'b:1', maxAttempts: 3 });
    const waits: number[] = [];

    for (let i = 0; i < 3; i++) {
      const job = await claimJob('w');
      if (!job) break;
      const outcome = await failJob(job.id, 'boom', false);
      const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      if (outcome === 'dead') {
        expect(row!.status).toBe('dead');
        break;
      }
      waits.push(Math.round((row!.runAfter.getTime() - Date.now()) / 1000));
      await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.id));
    }

    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it('marks a permanent failure dead on the first attempt', async () => {
    await enqueue({ type: 'prune', dedupeKey: 'p:1', maxAttempts: 5 });
    const job = await claimJob('w');
    expect(await failJob(job!.id, 'broken forever', true)).toBe('dead');
  });

  it('reclaims jobs abandoned by a dead worker', async () => {
    await enqueue({ type: 'prune', dedupeKey: 'stuck' });
    const job = await claimJob('doomed');
    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(jobs.id, job!.id));

    expect(await reclaimStuckJobs(15 * 60_000)).toBe(1);
    const [revived] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(revived!.status).toBe('pending');
    expect(revived!.lockedBy).toBeNull();
  });
});

describe('slot booking', () => {
  it('cannot book the same slot twice even without the planner lock', async () => {
    const project = await makeProject();
    const slot = new Date('2026-09-01T09:00:00Z');

    const insert = () =>
      db
        .insert(posts)
        .values({ projectId: project.id, scheduledAt: slot, status: 'planned' })
        .onConflictDoNothing({ target: [posts.projectId, posts.scheduledAt] })
        .returning({ id: posts.id });

    const [first, second] = await Promise.all([insert(), insert()]);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
  });
});

describe('rate limiting', () => {
  async function makeKey(rpmLimit: number | null): Promise<string> {
    const [row] = await db
      .insert(apiKeys)
      .values({
        provider: 'gemini',
        label: 'test',
        secretEnc: encryptSecret('secret-value'),
        rpmLimit,
      })
      .returning({ id: apiKeys.id });
    return row!.id;
  }

  it('denies once the per-minute ceiling is passed', async () => {
    const keyId = await makeKey(2);
    const model = 'gemini-test';

    expect((await acquire(keyId, model, { rpmLimit: 2 })).ok).toBe(true);
    expect((await acquire(keyId, model, { rpmLimit: 2 })).ok).toBe(true);

    const third = await acquire(keyId, model, { rpmLimit: 2 });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('rpm_exceeded');
  });

  it('blocks exactly one key/model pair, leaving others alone', async () => {
    const keyA = await makeKey(null);
    const keyB = await makeKey(null);

    await openCircuit(keyA, 'model-x', 60_000, 'simulated 429');

    const blocked = await acquire(keyA, 'model-x', {});
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('circuit_open');

    // Deliberately per key: a 429 on one must not disable another that may
    // belong to a different account entirely.
    expect((await acquire(keyA, 'model-y', {})).ok).toBe(true);
    expect((await acquire(keyB, 'model-x', {})).ok).toBe(true);
  });

  it('reports when the circuit reopens so the job can be rescheduled', async () => {
    const keyId = await makeKey(null);
    const until = await openCircuit(keyId, 'model-z', 45_000, 'simulated');
    const result = await acquire(keyId, 'model-z', {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAt.getTime()).toBe(until.getTime());
  });
});

describe('manual launch', () => {
  async function makePost(
    projectId: string,
    overrides: Partial<typeof posts.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(posts)
      .values({
        projectId,
        scheduledAt: new Date(Date.now() + 3 * 3600_000),
        status: 'planned',
        ...overrides,
      })
      .returning({ id: posts.id });
    return row!.id;
  }

  it('publishes a ready post directly', async () => {
    const project = await makeProject();
    const postId = await makePost(project.id, { status: 'ready', textHtml: '<b>готово</b>' });

    const result = await launchPost(postId);
    expect(result.job).toBe('publish_post');

    const [job] = await db.select().from(jobs).where(eq(jobs.projectId, project.id));
    expect(job?.type).toBe('publish_post');
  });

  it('generates and publishes in one job when the post is not ready', async () => {
    const project = await makeProject();
    const postId = await makePost(project.id);

    const result = await launchPost(postId);
    expect(result.job).toBe('generate_and_publish');
  });

  it('drops the pending buffer job so the two cannot race', async () => {
    const project = await makeProject();
    const postId = await makePost(project.id);
    await enqueue({
      type: 'generate_post',
      projectId: project.id,
      payload: { postId },
      dedupeKey: `post:${postId}:generate`,
    });

    await launchPost(postId);

    const rows = await db.select().from(jobs).where(eq(jobs.projectId, project.id));
    expect(rows.map((r) => r.type)).toEqual(['generate_and_publish']);
  });

  it('refuses a post that is already published or in flight', async () => {
    const project = await makeProject();
    const published = await makePost(project.id, { status: 'published' });
    const running = await makePost(project.id, {
      status: 'generating',
      scheduledAt: new Date(Date.now() + 7 * 3600_000),
    });

    await expect(launchPost(published)).rejects.toBeInstanceOf(NotLaunchableError);
    await expect(launchPost(running)).rejects.toBeInstanceOf(NotLaunchableError);
  });

  it('prefers a ready post over an earlier planned one', async () => {
    const project = await makeProject();
    await makePost(project.id, { scheduledAt: new Date(Date.now() + 3600_000) });
    const ready = await makePost(project.id, {
      status: 'ready',
      textHtml: '<b>готово</b>',
      scheduledAt: new Date(Date.now() + 5 * 3600_000),
    });

    const result = await launchProject(project.id);
    expect(result.postId).toBe(ready);
    expect(result.job).toBe('publish_post');
  });

  it('creates a slot when the project keeps no buffer', async () => {
    const project = await makeProject({ postsBuffer: 0 });

    const result = await launchProject(project.id);
    expect(result.created).toBe(true);
    expect(result.job).toBe('generate_and_publish');

    const rows = await db.select().from(posts).where(eq(posts.projectId, project.id));
    expect(rows).toHaveLength(1);
  });
});

describe('key hierarchy', () => {
  async function makeKey(label: string, isDefault = false): Promise<string> {
    const [row] = await db
      .insert(apiKeys)
      .values({
        provider: 'gemini',
        label,
        secretEnc: encryptSecret(`secret-${label}`),
        isDefault,
      })
      .returning({ id: apiKeys.id });
    return row!.id;
  }

  it('falls back to the default key when nothing more specific is set', async () => {
    await makeKey('paid');
    await makeKey('free', true);
    const project = await makeProject();

    const key = await resolveKey(project.id, 'gemini', 'post_text');
    expect(key?.label).toBe('free');
    expect(key?.level).toBe('default');
  });

  it('prefers the project key over the default', async () => {
    await makeKey('free', true);
    const paid = await makeKey('paid');
    const project = await makeProject({ apiKeyId: paid });

    const key = await resolveKey(project.id, 'gemini', 'post_text');
    expect(key?.label).toBe('paid');
    expect(key?.level).toBe('project');
  });

  it('prefers the action key over the project key', async () => {
    const free = await makeKey('free', true);
    const paid = await makeKey('paid');
    const project = await makeProject({ apiKeyId: free });

    await db
      .insert(modelChains)
      .values({ projectId: project.id, action: 'image', enabled: true, apiKeyId: paid });

    const image = await resolveKey(project.id, 'gemini', 'image');
    expect(image?.label).toBe('paid');
    expect(image?.level).toBe('action');

    // The pin is per action: text must stay on the project key.
    const text = await resolveKey(project.id, 'gemini', 'post_text');
    expect(text?.label).toBe('free');
  });

  it('skips a disabled key instead of failing the call', async () => {
    const free = await makeKey('free', true);
    const paid = await makeKey('paid');
    await db.update(apiKeys).set({ enabled: false }).where(eq(apiKeys.id, paid));
    const project = await makeProject({ apiKeyId: paid });

    const key = await resolveKey(project.id, 'gemini', 'post_text');
    expect(key?.id).toBe(free);
    expect(key?.level).toBe('default');
  });
});

describe('prompt resolution', () => {
  it('prefers the most specific scope available', async () => {
    await db.delete(prompts);
    await ensureDefaultPrompts();
    const project = await makeProject();

    const global = await resolvePrompt('post_text', project.id, null);
    expect(global.scope).toBe('global');

    await savePromptVersion({
      action: 'post_text',
      scope: 'project',
      projectId: project.id,
      model: null,
      body: 'project-level',
    });
    expect((await resolvePrompt('post_text', project.id, null)).body).toBe('project-level');

    await savePromptVersion({
      action: 'post_text',
      scope: 'model',
      projectId: project.id,
      model: 'gemini-lite',
      body: 'model-level',
    });
    expect((await resolvePrompt('post_text', project.id, 'gemini-lite')).body).toBe('model-level');
    // A different model still falls back to the project scope.
    expect((await resolvePrompt('post_text', project.id, 'gemini-other')).body).toBe('project-level');
  });

  it('creates a new version instead of mutating the old one', async () => {
    const project = await makeProject();
    const first = await savePromptVersion({
      action: 'svg',
      scope: 'project',
      projectId: project.id,
      model: null,
      body: 'v1',
    });
    const second = await savePromptVersion({
      action: 'svg',
      scope: 'project',
      projectId: project.id,
      model: null,
      body: 'v2',
    });

    expect(second.version).toBe(first.version + 1);
    // Published posts reference the exact version that produced them, so the
    // old row has to survive.
    const [old] = await db.select().from(prompts).where(eq(prompts.id, first.id));
    expect(old!.body).toBe('v1');
  });
});

describe('topic bank', () => {
  it('collapses duplicates inside a batch and across batches', async () => {
    const project = await makeProject();

    const first = await insertTopics(
      project.id,
      [
        { title: 'Circuit Breaker у мікросервісах' },
        { title: 'Мікросервіси та Circuit Breaker' },
        { title: 'Ідемпотентність у чергах' },
      ],
      'manual',
    );
    expect(first.inserted).toBe(2);
    expect(first.duplicates).toBe(1);

    const second = await insertTopics(
      project.id,
      [{ title: 'Патерн Circuit Breaker мікросервіси' }],
      'ai',
    );
    expect(second.inserted).toBe(0);
  });

  it('counts only unclaimed topics against the replenish threshold', async () => {
    const project = await makeProject({ topicsBufferMin: 2 });
    await insertTopics(project.id, [{ title: 'Тема одна' }, { title: 'Тема друга' }], 'manual');

    expect(await needsReplenish(project.id, 2)).toBe(false);

    // A queued topic is attached to a post in flight; treating it as stock
    // would let the bank run dry while every row is spoken for.
    await db
      .update(topics)
      .set({ status: 'queued' })
      .where(and(eq(topics.projectId, project.id), eq(topics.title, 'Тема одна')));

    const counts = await topicCounts(project.id);
    expect(counts.fresh).toBe(1);
    expect(counts.queued).toBe(1);
    expect(await needsReplenish(project.id, 2)).toBe(true);
  });

  it('never replenishes when the bank is disabled', async () => {
    const project = await makeProject({ topicsBufferMin: 0 });
    expect(await needsReplenish(project.id, 0)).toBe(false);
  });
});
