import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../src/db/client.js';
import { assertTestDatabase } from './guard.js';
import {
  apiKeys,
  appSettings,
  jobs,
  modelChains,
  batchJobs,
  logs,
  posts,
  projects,
  prompts,
  type Project,
} from '../src/db/schema.js';
import { encryptSecret } from '../src/crypto/secrets.js';
import { claimJob, completeJob, failJob, rescheduleJob } from '../src/queue/claim.js';
import { enqueue, reclaimStuckJobs } from '../src/queue/enqueue.js';
import { acquire, openCircuit } from '../src/ai/rateLimiter.js';
import { resolveKey } from '../src/ai/keys.js';
import { ensureDefaultChains } from '../src/ai/chains.js';
import { planTick } from '../src/scheduler/planner.js';
import { launchPost, launchProject, NotLaunchableError } from '../src/services/publishNow.js';
import { logEnabled, postLog, projectLog, pruneLogs, record } from '../src/services/activityLog.js';
import {
  abandonExpired,
  BATCH_MAX_ITEMS,
  BATCH_MIN_ITEMS,
  BATCH_MIN_SLACK_MS,
  batchCandidates,
  submitBatch,
} from '../src/ai/batch.js';
import {
  ensureDefaultPrompts,
  renderPrompt,
  resolvePrompt,
  savePromptVersion,
} from '../src/prompts/resolve.js';
import { BUILTIN_STYLE, DEFAULT_PROMPTS } from '../src/prompts/defaults.js';
import { projectVariables } from '../src/prompts/variables.js';
import { COMMON_VARIABLES, promptVariables } from '@tcf/shared';
import { forgetSettings, resolveStyle, saveSettings } from '../src/services/settings.js';
import { ideaCounts, insertIdeas, needsReplenish } from '../src/services/ideas.js';
import {
  generatePostText,
  listPosts,
  PostTooLongError,
  resetForRegeneration,
  updatePostText,
} from '../src/services/posts.js';
import { removeStagedImage, writeStagedImage } from '../src/media/staging.js';
import { createApiKey, updateApiKey } from '../src/services/apiKeys.js';
import { updateProject } from '../src/services/projects.js';
import { computeSlots } from '../src/scheduler/slots.js';
import { publisherTick, reclaimStuckPublishing } from '../src/scheduler/publisher.js';
import { saveActionConfig } from '../src/services/generationConfig.js';

/**
 * These run against real Postgres because the guarantees being tested *are*
 * Postgres features: SKIP LOCKED, partial unique indexes, interval arithmetic.
 * A mocked driver would only confirm the mock.
 */

async function reset(): Promise<void> {
  assertTestDatabase();
  await db.execute(
    sql`truncate ${jobs}, ${posts}, ${logs}, ${batchJobs}, ${apiKeys}, ${projects} restart identity cascade`,
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
  it('makes a job claimable immediately, whatever the app clock says', async () => {
    // The database compares `run_after <= now()` against *its* clock. A job
    // stamped from the app's clock is invisible until the skew elapses, which
    // on a container that lags the host silently delays every job.
    await enqueue({ type: 'prune', dedupeKey: 'clock:1' });
    expect(await claimJob('w')).not.toBeNull();
  });

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

describe('batch tier', () => {
  it('does not submit on a key without the batch flag', async () => {
    const project = await makeProject();
    await db.insert(apiKeys).values({
      provider: 'gemini',
      label: 'free',
      secretEnc: encryptSecret('secret'),
      isDefault: true,
    });

    const submitted = await submitBatch({
      action: 'topics',
      projectId: project.id,
      items: [{ postId: null, variables: {} }],
      deadline: new Date(Date.now() + 3600_000),
    });

    // Falling back to the normal call is the only safe behaviour: batch is a
    // paid-tier feature and submitting would fail at the vendor.
    expect(submitted).toEqual([]);
    expect(await db.select().from(batchJobs)).toHaveLength(0);
  });

  it('збирає в одне замовлення всі пости буфера, а не по одному', async () => {
    /*
     * У batch платять за запит, не за джобу: двадцять постів в одному
     * замовленні коштують як двадцять окремих, але це одне звернення і одне
     * опитування. Тому кандидати шукаються по всьому буферу — і саме тут
     * відсіюються ті, кому це не підходить.
     */
    const project = await makeProject();
    const far = new Date(Date.now() + 8 * 3600_000);

    const [first] = await db
      .insert(posts)
      .values([
        { projectId: project.id, status: 'planned', scheduledAt: far, topicTitle: 'Раз' },
        {
          projectId: project.id,
          status: 'planned',
          scheduledAt: new Date(far.getTime() + 3600_000),
          topicTitle: 'Два',
        },
        // Слот за півгодини — чекати на дешевий тариф уже нікуди.
        {
          projectId: project.id,
          status: 'planned',
          scheduledAt: new Date(Date.now() + 30 * 60_000),
          topicTitle: 'Близький',
        },
        // Текст уже є — цей крок для нього пройдено.
        {
          projectId: project.id,
          status: 'planned',
          scheduledAt: new Date(far.getTime() + 2 * 3600_000),
          topicTitle: 'Готовий',
          textHtml: '<b>є</b>',
        },
      ])
      .returning();

    const candidates = await batchCandidates({
      projectId: project.id,
      action: 'post_text',
      minSlackMs: BATCH_MIN_SLACK_MS,
      needsText: false,
      limit: BATCH_MAX_ITEMS,
    });

    expect(candidates.map((c) => c.topicTitle)).toEqual(['Раз', 'Два']);

    // Пост, який уже в чужому замовленні, не потрапляє в наступне: інакше та
    // сама відповідь була б замовлена і оплачена двічі.
    const [key] = await db
      .insert(apiKeys)
      .values({ provider: 'gemini', label: 'p', secretEnc: encryptSecret('s'), batchEnabled: true })
      .returning();
    await db.insert(batchJobs).values({
      projectId: project.id,
      postId: first!.id,
      apiKeyId: key!.id,
      action: 'post_text',
      model: 'gemini-3.5-flash',
      providerName: 'batches/x',
      state: 'pending',
      deadline: far,
    });

    const after = await batchCandidates({
      projectId: project.id,
      action: 'post_text',
      minSlackMs: BATCH_MIN_SLACK_MS,
      needsText: false,
      limit: BATCH_MAX_ITEMS,
    });
    expect(after.map((c) => c.topicTitle)).toEqual(['Два']);
    // А один кандидат — це вже не замовлення.
    expect(after.length).toBeLessThan(BATCH_MIN_ITEMS);
  });

  it('abandons a job past its deadline so the slot can be generated normally', async () => {
    const project = await makeProject();
    const [key] = await db
      .insert(apiKeys)
      .values({
        provider: 'gemini',
        label: 'paid',
        secretEnc: encryptSecret('secret'),
        isDefault: true,
        batchEnabled: true,
      })
      .returning({ id: apiKeys.id });

    await db.insert(batchJobs).values({
      projectId: project.id,
      apiKeyId: key!.id,
      action: 'topics',
      model: 'gemini-test',
      providerName: 'batches/expired',
      state: 'pending',
      deadline: new Date(Date.now() - 60_000),
    });

    expect(await abandonExpired()).toBe(1);
    expect(await db.select().from(batchJobs)).toHaveLength(0);
  });
});

describe('activity log', () => {
  it('writes nothing while the project switch is off', async () => {
    const off = await makeProject();
    expect(await logEnabled(off.id)).toBe(false);

    await record({ projectId: off.id, kind: 'note', message: 'не має зберегтись' });
    expect(await db.select().from(logs)).toHaveLength(0);
  });

  it('drops entries past the project retention, keeping fresher ones', async () => {
    const project = await makeProject({ logRetentionDays: 1, logEnabled: true });
    const [post] = await db
      .insert(posts)
      .values({ projectId: project.id, scheduledAt: new Date(), status: 'planned' })
      .returning({ id: posts.id });

    await db.insert(logs).values([
      {
        postId: post!.id,
        projectId: project.id,
        kind: 'model_request',
        message: 'старий',
        createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
      },
      { postId: post!.id, projectId: project.id, kind: 'model_response', message: 'свіжий' },
    ]);

    expect(await pruneLogs()).toBe(1);
    const left = await postLog(post!.id);
    expect(left.map((e) => e.message)).toEqual(['свіжий']);
  });

  it('records where a topic came from', async () => {
    const project = await makeProject({ logEnabled: true });
    await insertIdeas(project.id, [{ title: 'Ідемпотентність у чергах' }], 'manual');

    const [entry] = await projectLog(project.id);
    expect(entry?.kind).toBe('topic_created');
    expect(entry?.source).toBe('manual');
  });
});

describe('key tier and batching', () => {
  /*
   * Batch is a paid-plan feature. A free key with the flag set fails at the
   * vendor — a day later, on a post that had counted on the cheap tier — so the
   * pair is resolved server-side rather than trusted from the form.
   */
  it('refuses to enable batch on a free key', async () => {
    const id = await createApiKey({
      provider: 'gemini',
      label: 'free one',
      secret: 'secret-value',
      isDefault: false,
      enabled: true,
      tier: 'free',
      batchEnabled: true,
      rpmLimit: null,
      dailyRequestBudget: null,
    });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    expect(row?.batchEnabled).toBe(false);
  });

  it('switches batching off when a key moves back to free', async () => {
    const id = await createApiKey({
      provider: 'gemini',
      label: 'paid one',
      secret: 'secret-value',
      isDefault: false,
      enabled: true,
      tier: 'paid',
      batchEnabled: true,
      rpmLimit: null,
      dailyRequestBudget: null,
    });
    expect((await db.select().from(apiKeys).where(eq(apiKeys.id, id)))[0]?.batchEnabled).toBe(true);

    await updateApiKey(id, { tier: 'free' });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    expect(row?.batchEnabled).toBe(false);
  });

  it('keeps limits editable after creation', async () => {
    const id = await createApiKey({
      provider: 'gemini',
      label: 'limits',
      secret: 'secret-value',
      isDefault: false,
      enabled: true,
      tier: 'free',
      batchEnabled: false,
      rpmLimit: 4,
      dailyRequestBudget: 20,
    });

    await updateApiKey(id, { rpmLimit: 10, dailyRequestBudget: 500 });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    expect(row?.rpmLimit).toBe(10);
    expect(row?.dailyRequestBudget).toBe(500);
  });
});

describe('the posts list', () => {
  /*
   * The regression this pins: ideas carry no slot, Postgres sorts NULLs first
   * in a DESC order, and the limit was spent entirely on them — so a project
   * with more ideas than the limit showed an empty list while the status chips
   * still counted the posts that never arrived.
   */
  it('shows scheduled posts even when ideas outnumber them', async () => {
    const project = await makeProject();
    await insertIdeas(
      project.id,
      Array.from({ length: 30 }, (_, i) => ({ title: `Ідея номер ${i}` })),
      'manual',
    );
    await db.insert(posts).values({
      projectId: project.id,
      status: 'published',
      scheduledAt: new Date(Date.now() - 3600_000),
      topicTitle: 'Опублікований',
    });

    const listed = await listPosts(project.id, 5);

    // The scheduled one comes first, not after thirty ideas.
    expect(listed[0]?.topicTitle).toBe('Опублікований');
    expect(listed.some((p) => p.status === 'idea')).toBe(true);
  });
});

describe('batch reaches the buffer at all', () => {
  /*
   * The defect this pins down: eligibility for the batch tier is decided from
   * the slack left before the slot, but the check ran inside the generation
   * job — which the planner scheduled for `leadTimeMinutes` (3h) before that
   * slot. Three hours of slack against the threshold is always "no", so
   * batching for post text never happened once on a buffered project.
   */
  async function makeBatchKey(batchEnabled: boolean) {
    await db.insert(apiKeys).values({
      provider: 'gemini',
      label: batchEnabled ? 'paid' : 'free',
      secretEnc: encryptSecret('secret'),
      isDefault: true,
      batchEnabled,
    });
  }

  async function firstGenerateJob(projectId: string) {
    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), eq(jobs.type, 'generate_post')))
      .orderBy(jobs.runAfter)
      .limit(1);
    return job;
  }

  it('starts far-off posts immediately when the key can batch', async () => {
    await ensureDefaultPrompts();
    await makeBatchKey(true);
    // Seven daily slots: every one past the first is well over the threshold
    // the batch tier needs.
    const project = await makeProject({ postsBuffer: 7, leadTimeMinutes: 180, status: 'active' });
    await ensureDefaultChains();

    await planTick();

    const job = await firstGenerateJob(project.id);
    expect(job).toBeDefined();
    // Immediately — within the 15-minute spread that keeps projects sharing a
    // slot from firing in the same second — rather than three hours before a
    // slot that is days away.
    const waitMinutes = (job!.runAfter.getTime() - Date.now()) / 60_000;
    expect(waitMinutes).toBeLessThan(16);
    // And well before the batch window would have closed.
    expect(job!.runAfter.getTime()).toBeLessThan(Date.now() + BATCH_MIN_SLACK_MS);
  });

  it('щогодинний розклад із малим буфером теж дотягується до batch', async () => {
    /*
     * Той самий дефект, але з боку, який жоден тест не ловив: поріг у 26 годин
     * перевищував увесь горизонт планування. Буфер створює рівно `postsBuffer`
     * слотів, тож на розкладі «щогодини» з буфером 20 найдальший слот — за 20
     * годин, і жоден пост ніколи не проходив умову. Тут перевіряється не число,
     * а те, що воно лишається меншим за реальний горизонт буфера.
     */
    await ensureDefaultPrompts();
    await makeBatchKey(true);
    const project = await makeProject({
      postsBuffer: 20,
      leadTimeMinutes: 180,
      status: 'active',
      schedule: { mode: 'interval', intervalMinutes: 60, anchor: '08:00' },
    });
    await ensureDefaultChains();

    await planTick();

    const job = await firstGenerateJob(project.id);
    expect(job).toBeDefined();
    expect((job!.runAfter.getTime() - Date.now()) / 60_000).toBeLessThan(16);
  });

  it('keeps the lead time when the project turned batch off', async () => {
    // The key can batch; the project said not to. Without this the mode was a
    // label on a form — the planner would still start the post days early to
    // wait for a batch that the generation step then refuses to submit.
    await ensureDefaultPrompts();
    await makeBatchKey(true);
    const project = await makeProject({
      postsBuffer: 7,
      leadTimeMinutes: 180,
      status: 'active',
      batchMode: 'off',
    });
    await ensureDefaultChains();

    await planTick();

    const job = await firstGenerateJob(project.id);
    expect(job).toBeDefined();
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it('keeps the lead time when the key cannot batch', async () => {
    await ensureDefaultPrompts();
    await makeBatchKey(false);
    const project = await makeProject({ postsBuffer: 7, leadTimeMinutes: 180, status: 'active' });
    await ensureDefaultChains();

    await planTick();

    const job = await firstGenerateJob(project.id);
    expect(job).toBeDefined();
    // Nothing to gain by generating days early without the cheap tier.
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });
});

describe('зміна розкладу', () => {
  it('переставляє ще не опубліковані пости на нові слоти', async () => {
    /*
     * Без цього канал якийсь час живе за двома розкладами: нові слоти
     * рахуються по-новому, а два десятки вже запланованих постів виходять у
     * старі години — тобто «перевів канал на вечір» починало діяти лише за
     * добу-дві.
     */
    const project = await makeProject({
      schedule: { mode: 'slots', slots: ['09:00'], weekdays: [] },
      timezone: 'UTC',
    });
    const day = 24 * 3600_000;
    const rows = await db
      .insert(posts)
      .values([
        {
          projectId: project.id,
          status: 'ready',
          scheduledAt: new Date(Date.now() + day),
          topicTitle: 'Перший',
          textHtml: '<b>1</b>',
        },
        {
          projectId: project.id,
          status: 'planned',
          scheduledAt: new Date(Date.now() + 2 * day),
          topicTitle: 'Другий',
        },
        // Уже опублікований лишається там, де вийшов: переписувати історію нема
        // сенсу й нема як — пост у каналі вже стоїть.
        {
          projectId: project.id,
          status: 'published',
          scheduledAt: new Date(Date.now() - day),
          topicTitle: 'Старий',
        },
      ])
      .returning();

    const updated = await updateProject(project.id, {
      schedule: { mode: 'interval', intervalMinutes: 60, anchor: '08:00' },
    });
    expect(updated.schedule.mode).toBe('interval');

    const after = await db.select().from(posts).where(eq(posts.projectId, project.id));
    const byTopic = new Map(after.map((p) => [p.topicTitle, p]));

    const expected = computeSlots(
      { mode: 'interval', intervalMinutes: 60, anchor: '08:00' },
      'UTC',
      new Date(),
      2,
    );
    expect(byTopic.get('Перший')!.scheduledAt!.getTime()).toBe(expected[0]!.getTime());
    expect(byTopic.get('Другий')!.scheduledAt!.getTime()).toBe(expected[1]!.getTime());
    // Зміст лишився на місці — переставляли час, а не пости.
    expect(byTopic.get('Перший')!.textHtml).toBe('<b>1</b>');
    // Опублікований не рухався.
    expect(byTopic.get('Старий')!.scheduledAt!.getTime()).toBe(
      rows.find((r) => r.topicTitle === 'Старий')!.scheduledAt!.getTime(),
    );
  });

  it('посуває джобу генерації разом зі слотом', async () => {
    // Джоба прив'язана до старого слоту своїм `run_after`: пост, що поїхав на
    // день пізніше, згенерувався б за старим часом і чекав добу готовим.
    const project = await makeProject({
      schedule: { mode: 'slots', slots: ['09:00'], weekdays: [] },
      timezone: 'UTC',
      leadTimeMinutes: 60,
    });
    const [post] = await db
      .insert(posts)
      .values({
        projectId: project.id,
        status: 'planned',
        scheduledAt: new Date(Date.now() + 10 * 24 * 3600_000),
        topicTitle: 'Далекий',
      })
      .returning();
    await enqueue({
      type: 'generate_post',
      projectId: project.id,
      payload: { postId: post!.id },
      runAfter: new Date(Date.now() + 9 * 24 * 3600_000),
      dedupeKey: `post:${post!.id}:generate`,
    });

    await updateProject(project.id, {
      schedule: { mode: 'interval', intervalMinutes: 60, anchor: '08:00' },
    });

    const [after] = await db.select().from(posts).where(eq(posts.id, post!.id));
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `post:${post!.id}:generate`));

    expect(after!.scheduledAt!.getTime()).toBeLessThan(Date.now() + 2 * 3600_000);
    expect(job!.runAfter.getTime()).toBeLessThan(after!.scheduledAt!.getTime());
  });
});

describe('групове batch-замовлення', () => {
  it('розкладає відповіді по всіх постах замовлення, а не лише по своєму', async () => {
    /*
     * Дефект, який це ловить: відповідь лежала в рядку `batch_jobs`, доки до
     * поста не дійде його власна джоба — тобто годину-дві. Тридцять оплачених
     * відповідей чекали неспожитими, а стан «текст є, картинки немає» ніколи
     * не тримав двох постів одночасно, тож замовлення на малювання не
     * збиралось і кожна ілюстрація йшла за повну ціну.
     */
    const project = await makeProject({ imageMode: 'none' });
    const far = new Date(Date.now() + 8 * 3600_000);
    const [key] = await db
      .insert(apiKeys)
      .values({ provider: 'gemini', label: 'p', secretEnc: encryptSecret('s'), batchEnabled: true })
      .returning();

    const rows = await db
      .insert(posts)
      .values([
        { projectId: project.id, status: 'planned', scheduledAt: far, topicTitle: 'Свій', normalizedHash: 'sviy' },
        {
          projectId: project.id,
          status: 'planned',
          scheduledAt: new Date(far.getTime() + 3600_000),
          topicTitle: 'Сусід',
          normalizedHash: 'susid',
        },
      ])
      .returning();

    const order = 'batches/group-1';
    await db.insert(batchJobs).values(
      rows.map((row, index) => ({
        projectId: project.id,
        postId: row.id,
        apiKeyId: key!.id,
        action: 'post_text' as const,
        model: 'gemini-3.5-flash',
        providerName: order,
        requestIndex: index,
        state: 'succeeded' as const,
        resultText: `<b>Текст ${index}</b>`,
        deadline: far,
      })),
    );

    expect(await generatePostText(rows[0]!.id)).toBe('generated');

    const after = await db.select().from(posts).where(eq(posts.projectId, project.id));
    const byTopic = new Map(after.map((p) => [p.topicTitle, p.textHtml]));
    // Свій пост дійшов до кінця, сусід дістав свій текст і чекає лише на
    // ілюстрацію — його джоба вже не проситиме модель писати вдруге.
    expect(byTopic.get('Свій')).toBe('<b>Текст 0</b>');
    expect(byTopic.get('Сусід')).toBe('<b>Текст 1</b>');
    // Замовлення спожите цілком: рядки прибрано, платити за них удруге нічим.
    expect(await db.select().from(batchJobs)).toHaveLength(0);
  });
});

describe('пропущені слоти', () => {
  it('«лише останній» лишає найсвіжіший, а старші позначає пропущеними', async () => {
    /*
     * Сценарій — не гіпотетичний: на ключі скінчились гроші, за ніч набралось
     * десять невиконаних слотів, гроші поповнили. `publish_late` вивалив би в
     * канал усю чергу за раз. Читачеві потрібен свіжий пост, а не вчорашня
     * черга, тож публікується лише останній прострочений.
     */
    const project = await makeProject({ status: 'active', missPolicy: 'publish_last' });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

    const rows = await db
      .insert(posts)
      .values([
        { projectId: project.id, status: 'ready', scheduledAt: hoursAgo(5), topicTitle: 'Найстаріший' },
        { projectId: project.id, status: 'ready', scheduledAt: hoursAgo(3), topicTitle: 'Середній' },
        { projectId: project.id, status: 'ready', scheduledAt: hoursAgo(1), topicTitle: 'Найсвіжіший' },
      ])
      .returning();

    const report = await publisherTick();

    expect(report.skipped).toBe(2);
    expect(report.queued).toBe(1);

    const after = await db.select().from(posts).where(eq(posts.projectId, project.id));
    const byTopic = new Map(after.map((p) => [p.topicTitle, p.status]));
    expect(byTopic.get('Найстаріший')).toBe('skipped');
    expect(byTopic.get('Середній')).toBe('skipped');
    expect(byTopic.get('Найсвіжіший')).toBe('ready');

    const queuedJobs = await db.select().from(jobs).where(eq(jobs.projectId, project.id));
    expect(queuedJobs.map((j) => (j.payload as { postId?: string }).postId)).toEqual([
      rows.find((r) => r.topicTitle === 'Найсвіжіший')!.id,
    ]);
  });

  it('«всі прострочені» лишає чергу як є', async () => {
    const project = await makeProject({ status: 'active', missPolicy: 'publish_late' });
    await db.insert(posts).values([
      {
        projectId: project.id,
        status: 'ready',
        scheduledAt: new Date(Date.now() - 5 * 3600_000),
        topicTitle: 'Старий',
      },
      {
        projectId: project.id,
        status: 'ready',
        scheduledAt: new Date(Date.now() - 3600_000),
        topicTitle: 'Свіжий',
      },
    ]);

    const report = await publisherTick();

    expect(report.skipped).toBe(0);
    expect(report.queued).toBe(2);
  });
});

describe('повторний захід генерації', () => {
  it('не генерує текст удруге, якщо він уже збережений', async () => {
    /*
     * Це те, на чому тримається batch для ілюстрації: текст зберігається до
     * замовлення картинки, джоба паркується, і наступний її захід має піти
     * одразу до ілюстрації. Якби він починав із тексту, парковка коштувала б
     * другого виклику моделі поверх уже написаного.
     *
     * Мережі в тестах немає — тож будь-яке звернення до моделі тут просто
     * впало б. Прохід без помилки і є доказом, що жодного виклику не сталось.
     */
    const project = await makeProject({ imageMode: 'none', publishMode: 'auto' });
    const [post] = await db
      .insert(posts)
      .values({
        projectId: project.id,
        status: 'planned',
        scheduledAt: new Date(Date.now() + 30 * 60_000),
        topicTitle: 'Тема, яка вже має текст',
        // Разом із хешем: без нього тема вважається невизначеною, і генерація
        // піде по неї в банк.
        normalizedHash: 'tema-yaka-vzhe-maye-tekst',
        textHtml: '<b>Готовий текст</b>',
      })
      .returning();

    expect(await generatePostText(post!.id)).toBe('generated');

    const [after] = await db.select().from(posts).where(eq(posts.id, post!.id));
    expect(after!.status).toBe('ready');
    expect(after!.textHtml).toBe('<b>Готовий текст</b>');
  });
});

describe('launching an idea', () => {
  /*
   * The merge's payoff, stated as a test: an idea needs no special launch path
   * because it already *is* a post. `launchPost` gives it a slot and runs it,
   * the same call the list makes for every other row.
   */
  async function newIdea(projectId: string, title = 'Тема для запуску') {
    await insertIdeas(projectId, [{ title }], 'manual');
    const [row] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.projectId, projectId), eq(posts.topicTitle, title)))
      .limit(1);
    return row!;
  }

  it('is a post already, so launching it only assigns a slot', async () => {
    const project = await makeProject();
    const idea = await newIdea(project.id);
    expect(idea.status).toBe('idea');
    expect(idea.scheduledAt).toBeNull();

    const result = await launchPost(idea.id);

    // The same row, not a new one — that is the whole point of one entity.
    expect(result.postId).toBe(idea.id);
    const [after] = await db.select().from(posts).where(eq(posts.id, idea.id)).limit(1);
    expect(after?.scheduledAt).not.toBeNull();
    expect(after?.topicTitle).toBe('Тема для запуску');
    expect(result.job).toBe('generate_and_publish');
  });

  it('creates no second row for the same subject', async () => {
    const project = await makeProject();
    const idea = await newIdea(project.id);

    await launchPost(idea.id);
    const rows = await db.select().from(posts).where(eq(posts.projectId, project.id));

    expect(rows).toHaveLength(1);
  });

  it('refuses one that is already published', async () => {
    const project = await makeProject();
    const idea = await newIdea(project.id);
    await db
      .update(posts)
      .set({ status: 'published', scheduledAt: new Date() })
      .where(eq(posts.id, idea.id));

    await expect(launchPost(idea.id)).rejects.toBeInstanceOf(NotLaunchableError);
  });

  it('keeps the subject when the planner gives it a slot', async () => {
    const project = await makeProject({ status: 'active', postsBuffer: 1 });
    await ensureDefaultPrompts();
    const idea = await newIdea(project.id, 'Тема під планувальник');

    await planTick();

    const [after] = await db.select().from(posts).where(eq(posts.id, idea.id)).limit(1);
    expect(after?.status).toBe('planned');
    expect(after?.scheduledAt).not.toBeNull();
    expect(after?.topicTitle).toBe('Тема під планувальник');
  });
});

describe('resume trail for a partially published post', () => {
  /*
   * The ids of already-delivered messages are what stop a retry from reposting
   * the photo. They therefore have to survive a failed publish — and must not
   * survive a regeneration, where the post becomes different content.
   */
  it('is cleared by regeneration, so a new post sends its own photo', async () => {
    const project = await makeProject();
    const [row] = await db
      .insert(posts)
      .values({
        projectId: project.id,
        scheduledAt: new Date(Date.now() + 3600_000),
        status: 'ready',
        textHtml: '<b>старий</b>',
        tgMessageId: 500,
        tgExtraMessageIds: [501, 502],
      })
      .returning({ id: posts.id });

    const after = await resetForRegeneration(row!.id, true);

    expect(after.tgMessageId).toBeNull();
    expect(after.tgExtraMessageIds).toBeNull();
  });

  it('survives a failed publish so the retry can skip what arrived', async () => {
    const project = await makeProject();
    const [row] = await db
      .insert(posts)
      .values({
        projectId: project.id,
        scheduledAt: new Date(Date.now() + 3600_000),
        status: 'publishing',
        textHtml: '<b>частково</b>',
        tgMessageId: 600,
      })
      .returning({ id: posts.id });

    // What the scheduler does to a post whose worker died mid-send.
    await reclaimStuckPublishing(0);

    const [after] = await db.select().from(posts).where(eq(posts.id, row!.id)).limit(1);
    expect(after?.status).toBe('ready');
    expect(after?.tgMessageId).toBe(600);
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

  it('порожнє поле у проєкті повертає глобальний промпт, а не зберігає порожній', async () => {
    // У формі глобальний текст стоїть плейсхолдером, тож очистити поле — це те,
    // як оператор відмовляється від власної версії. Якби порожнє тіло
    // збереглося, генерація пішла б у модель без жодної інструкції.
    await db.delete(prompts);
    await ensureDefaultPrompts();
    const project = await makeProject();

    await saveActionConfig('post_text', project.id, { promptBody: 'лише для цього проєкту' });
    expect((await resolvePrompt('post_text', project.id, null)).scope).toBe('project');

    await saveActionConfig('post_text', project.id, { promptBody: '   ' });

    const back = await resolvePrompt('post_text', project.id, null);
    expect(back.scope).toBe('global');
    expect(back.body).toBe(DEFAULT_PROMPTS.post_text);
  });

  it('глобальний промпт не можна стерти порожнім полем', async () => {
    // Глобальному нема на що відкотитись: порожній текст зупинив би генерацію
    // в усіх проєктах одразу.
    await db.delete(prompts);
    await ensureDefaultPrompts();

    await saveActionConfig('post_text', null, { promptBody: '' });

    expect((await resolvePrompt('post_text', null, null)).body).toBe(DEFAULT_PROMPTS.post_text);
  });
});

describe('topic bank', () => {
  it('collapses duplicates inside a batch and across batches', async () => {
    const project = await makeProject();

    const first = await insertIdeas(
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

    const second = await insertIdeas(
      project.id,
      [{ title: 'Патерн Circuit Breaker мікросервіси' }],
      'ai',
    );
    expect(second.inserted).toBe(0);
  });

  it('counts only slot-less ideas against the replenish threshold', async () => {
    const project = await makeProject({ topicsBufferMin: 2 });
    await insertIdeas(project.id, [{ title: 'Тема одна' }, { title: 'Тема друга' }], 'manual');

    expect(await needsReplenish(project.id, 2)).toBe(false);

    // Given a slot, a row is spoken for; counting it as stock would let the
    // bank run dry while every remaining subject is already committed.
    await db
      .update(posts)
      .set({ status: 'planned', scheduledAt: new Date(Date.now() + 3600_000) })
      .where(and(eq(posts.projectId, project.id), eq(posts.topicTitle, 'Тема одна')));

    const counts = await ideaCounts(project.id);
    expect(counts.fresh).toBe(1);
    expect(counts.scheduled).toBe(1);
    expect(await needsReplenish(project.id, 2)).toBe(true);
  });

  it('never replenishes when the bank is disabled', async () => {
    const project = await makeProject({ topicsBufferMin: 0 });
    expect(await needsReplenish(project.id, 0)).toBe(false);
  });
});

describe('illustration style', () => {
  beforeEach(async () => {
    await db.delete(appSettings);
    forgetSettings();
  });

  it('falls back from the project to the global setting, and then to the built-in one', async () => {
    // The built-in style used to be read straight from a constant at the call
    // site, which made "звідки цей стиль" unanswerable from the admin UI. The
    // chain now has a middle rung, and this is what proves all three exist.
    expect(await resolveStyle('')).toBe(BUILTIN_STYLE);

    await saveSettings({ defaultStyle: 'акварель, тепле світло' });
    expect(await resolveStyle('')).toBe('акварель, тепле світло');
    expect(await resolveStyle('технічне креслення')).toBe('технічне креслення');
  });

  it('treats an empty global style as "not set" rather than as an empty style', async () => {
    await saveSettings({ defaultStyle: 'акварель' });
    await saveSettings({ defaultStyle: '   ' });

    // Storing a blank row would leave illustrations with no style at all, which
    // is not what clearing the field means.
    expect(await db.select().from(appSettings)).toHaveLength(0);
    expect(await resolveStyle('')).toBe(BUILTIN_STYLE);
  });
});

describe('post length', () => {
  it('reaches the prompt as a variable rather than a number typed into it', async () => {
    const project = await makeProject({ postMaxChars: 600 });
    const rendered = renderPrompt('Тримайся в межах {{maxChars}} символів', {
      maxChars: project.postMaxChars,
    });
    expect(rendered).toBe('Тримайся в межах 600 символів');
  });

  it('ships a default prompt that asks for the configured length', async () => {
    // A prompt with the limit written out is a prompt an operator has to edit
    // to change the limit — which is exactly what the setting exists to avoid.
    expect(DEFAULT_PROMPTS.post_text).toContain('{{maxChars}}');
    expect(DEFAULT_PROMPTS.post_text).not.toContain('1024');
  });
});

describe('prompt variables', () => {
  beforeEach(async () => {
    await db.delete(appSettings);
    forgetSettings();
  });

  it('gives every action the channel-wide set, not just its own', async () => {
    // The reference in the UI promises these are usable anywhere. They are only
    // usable if every call site actually passes them — an illustration prompt
    // mentioning {{persona}} used to render an empty string, silently.
    const project = await makeProject({
      persona: 'Практик',
      language: 'uk',
      hashtags: ['#arch', '#db'],
      postMaxChars: 700,
    });

    const vars = await projectVariables(project);

    expect(vars).toMatchObject({
      persona: 'Практик',
      language: 'uk',
      hashtags: '#arch #db',
      // Не 700: ліміт стосується всього повідомлення, а хештеги в нього входять,
      // тож моделі дістається залишок під сам текст.
      maxChars: 700 - '\n\n#arch #db'.length,
    });
    // Style falls through the same chain resolveStyle owns.
    expect(vars.style).toBe(BUILTIN_STYLE);
  });

  it('lists in the reference exactly what a prompt may use', async () => {
    // Both sides of the same fact: the shared record the UI renders, and the
    // variables the server passes. A name in one and not the other is a lie in
    // whichever direction it happens.
    const project = await makeProject();
    const passed = Object.keys(await projectVariables(project));

    for (const variable of COMMON_VARIABLES) {
      expect(passed).toContain(variable.name);
    }
    expect(promptVariables('post_text').map((v) => v.name)).toContain('topic');
    expect(promptVariables('svg').map((v) => v.name)).toContain('persona');
  });
});

describe('ліміт довжини поста', () => {
  /** Один пост, одна готова batch-відповідь: моделі тут не питають. */
  async function withBatchedText(project: Project, text: string, imagePath?: string) {
    const far = new Date(Date.now() + 8 * 3600_000);
    const [key] = await db
      .insert(apiKeys)
      .values({ provider: 'gemini', label: 'k', secretEnc: encryptSecret('s'), batchEnabled: true })
      .returning();

    const [post] = await db
      .insert(posts)
      .values({
        projectId: project.id,
        status: 'planned',
        scheduledAt: far,
        topicTitle: 'Тема з готовою відповіддю',
        normalizedHash: `h-${Math.random().toString(36).slice(2, 10)}`,
        ...(imagePath ? { imagePath, imageKind: 'image_model' as const } : {}),
      })
      .returning();

    await db.insert(batchJobs).values({
      projectId: project.id,
      postId: post!.id,
      apiKeyId: key!.id,
      action: 'post_text',
      model: 'gemini-3.5-flash',
      providerName: `batches/${post!.id}`,
      requestIndex: 0,
      state: 'succeeded',
      resultText: text,
      deadline: far,
    });

    return post!;
  }

  it('не зберігає текст, довший за ліміт, і лишає пост незавершеним', async () => {
    /*
     * Ліміт задають, щоб пост влазив у підпис під фото. Текст понад нього
     * розривався б на друге повідомлення рівно там, де налаштування обіцяло
     * цього не допустити, — тож він не лягає на рядок узагалі.
     */
    const project = await makeProject({ imageMode: 'none', postMaxChars: 300, hashtags: ['#тег'] });
    const post = await withBatchedText(project, 'а'.repeat(400));

    await expect(generatePostText(post.id)).rejects.toBeInstanceOf(PostTooLongError);

    const [after] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(after!.textHtml).toBeNull();
    expect(after!.status).toBe('planned');
    expect(after!.error).toContain('ліміт');
  });

  it('рахує ліміт разом із хештегами, яких у тексті ще немає', async () => {
    // Текст рівно в ліміт, але хвіст тегів дописується при публікації — і саме
    // на нього пост і виїжджав за межу, яку налаштування мало тримати.
    const project = await makeProject({ imageMode: 'none', postMaxChars: 300, hashtags: ['#тег'] });
    const post = await withBatchedText(project, 'а'.repeat(300));

    await expect(generatePostText(post.id)).rejects.toBeInstanceOf(PostTooLongError);
  });

  it('лишає намальовану ілюстрацію відхиленому посту', async () => {
    /*
     * Найдорожчий виклик у пості — малювання, і до довжини тексту він не має
     * стосунку: картинка намальована до теми, а тема та сама. Перемальовувати
     * її на кожній невдалій спробі тексту означало б платити за чужу помилку.
     *
     * Доказ — `imageKind`: проєкт малює SVG, а на рядку лежить `image_model`.
     * Якби ілюстрація генерувалась заново, вид змінився б.
     */
    const project = await makeProject({ imageMode: 'svg', postMaxChars: 1024 });
    const staged = await writeStagedImage(`test-${Date.now()}`, Buffer.from('png'), 'png');
    const post = await withBatchedText(project, '<b>Короткий текст</b>', staged);

    expect(await generatePostText(post.id)).toBe('generated');

    const [after] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(after!.status).toBe('ready');
    expect(after!.imagePath).toBe(staged);
    expect(after!.imageKind).toBe('image_model');

    await removeStagedImage(staged);
  });

  it('не дає обійти ліміт правкою руками', async () => {
    // Інакше редактор був би способом покласти в буфер те, чого генерація не
    // приймає, — і про це дізнавались би вже в каналі.
    const project = await makeProject({ postMaxChars: 300 });
    const [post] = await db
      .insert(posts)
      .values({ projectId: project.id, status: 'ready', textHtml: 'коротко' })
      .returning();

    await expect(updatePostText(post!.id, 'а'.repeat(400))).rejects.toBeInstanceOf(PostTooLongError);

    const [after] = await db.select().from(posts).where(eq(posts.id, post!.id));
    expect(after!.textHtml).toBe('коротко');
  });
});
