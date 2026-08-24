import type { AiAction } from '@tcf/shared';
import { and, asc, eq, gte, inArray, isNull, isNotNull, lt, notExists, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batchJobs, posts, projects, type BatchJob, type Post } from '../db/schema.js';
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

/**
 * Скільки чекати на замовлення, перш ніж махнути рукою.
 *
 * Раніше поріг рахувався від слоту поста: до слоту менше доби — batch
 * недосяжний. Слотів у постів більше немає (ADR 0009), і це якраз спростило
 * задачу: пост у буфері не чекає жодної конкретної хвилини, тож єдиний
 * запобіжник — не тримати замовлення довше за стелю вендора. Прострочене
 * скасовується, і пост іде звичайним викликом.
 */
export const BATCH_DEADLINE_MS = BATCH_TURNAROUND_MS;

/**
 * Скільки постів максимум їде в одному замовленні.
 *
 * Стеля не від провайдера, а від здорового глузду: одне замовлення на весь
 * буфер означає, що збій одного замовлення лишає без тексту весь буфер одразу.
 */
export const BATCH_MAX_ITEMS = 20;

/**
 * Менше двох запитів — не замовлення.
 *
 * У batch платять за запит, а не за джобу, тож економія від одного запиту та
 * сама, що й від двадцяти, — але чекати доводиться однаково. Якщо в буфері
 * знайшовся лише один кандидат, це саме по собі сигнал: буфер замалий, розклад
 * рідкий або пости вже розібрані. Такий пост іде звичайним викликом, а в
 * режимі «лише batch» лишається чекати — і це видно в журналі.
 */
export const BATCH_MIN_ITEMS = 2;

/**
 * Пости, які варто покласти в одне замовлення разом із тим, що його викликав.
 *
 * Сусіди шукаються в тому ж проєкті й на тому ж кроці: у batch платять за
 * запит, тож двадцять постів в одному замовленні коштують рівно як двадцять
 * окремих, але це одне звернення і одне опитування замість двадцяти. Умови ті
 * самі, за якими постом займеться його власна джоба, — тож нікого не
 * «випереджаємо»: коли її черга дійде, вона знайде вже готову відповідь.
 */
export async function batchCandidates(input: {
  projectId: string;
  action: AiAction;
  /** `true` — потрібен уже готовий текст (крок ілюстрації), `false` — навпаки. */
  needsText: boolean;
  limit: number;
}): Promise<Post[]> {
  const notBatchedYet = notExists(
    db
      .select({ one: sql`1` })
      .from(batchJobs)
      .where(
        and(
          eq(batchJobs.postId, posts.id),
          eq(batchJobs.action, input.action),
          inArray(batchJobs.state, ['pending', 'succeeded']),
        ),
      ),
  );

  return db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.projectId, input.projectId),
        eq(posts.status, 'planned'),
        isNotNull(posts.topicTitle),
        input.needsText ? isNotNull(posts.textHtml) : isNull(posts.textHtml),
        input.needsText ? isNull(posts.imagePath) : sql`true`,
        // Закріплений часом пост може вийти вже за годину — доба очікування
        // йому не по кишені. Черга ж не чекає нічого конкретного.
        isNull(posts.scheduledAt),
        notBatchedYet,
      ),
    )
    .orderBy(sql`${posts.position} asc nulls last`, asc(posts.createdAt))
    .limit(input.limit);
}

/** Один пост усередині замовлення. */
export interface BatchItem {
  postId: string | null;
  variables: Record<string, string | number | undefined>;
}

export interface BatchSubmitInput {
  action: AiAction;
  projectId: string;
  items: BatchItem[];
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
 *
 * Одне замовлення везе запити кількох постів: ціна рахується за запит, тож
 * двадцять окремих джоб коштували б рівно стільки ж, але це двадцять звернень
 * до провайдера, двадцять опитувань кожні чверть години і двадцять способів
 * щось загубити. Рядок у `batch_jobs` лишається на кожен пост — його
 * `request_index` і зв'язує пост із його відповіддю.
 */
export async function submitBatch(input: BatchSubmitInput): Promise<BatchJob[]> {
  if (input.items.length === 0) return [];

  const chain = await resolveChain(input.action, input.projectId);
  const step = chain?.steps[0];
  if (!step) return [];

  const provider = providers[step.provider];
  if (!provider?.submitBatch) return [];

  const key = await resolveKey(input.projectId, step.provider, input.action);
  if (!key || !key.batchEnabled) return [];

  const prompt = await resolvePrompt(input.action, input.projectId, step.model, step.promptId);
  const items = input.items.slice(0, BATCH_MAX_ITEMS);

  try {
    const handle = await provider.submitBatch(
      key.secret,
      items.map((item) => ({
        model: step.model,
        prompt: renderPrompt(prompt.body, item.variables),
        temperature: step.params.temperature,
        maxOutputTokens: step.params.maxOutputTokens,
        thinkingBudget: step.params.thinkingBudget,
        responseSchema: input.responseSchema,
      })),
    );

    const rows = await db
      .insert(batchJobs)
      .values(
        items.map((item, index) => ({
          projectId: input.projectId,
          postId: item.postId ?? null,
          apiKeyId: key.id,
          action: input.action,
          model: step.model,
          providerName: handle.name,
          requestIndex: index,
          state: handle.state,
          promptId: prompt.id === 'builtin' ? null : prompt.id,
          promptVersion: prompt.version,
          deadline: input.deadline,
        })),
      )
      .returning();

    await record({
      projectId: input.projectId,
      postId: items.length === 1 ? (items[0]?.postId ?? null) : null,
      kind: 'note',
      action: input.action,
      model: step.model,
      keyLabel: key.label,
      source: 'auto',
      batch: true,
      message: `Відправлено в batch (−50% ціни, до 24 год), запитів: ${items.length} — ${handle.name}`,
    });
    logger.info(
      {
        project_id: input.projectId,
        action: input.action,
        name: handle.name,
        requests: items.length,
      },
      'batch submitted',
    );

    return rows;
  } catch (err) {
    // Batch is an optimisation. A key without the paid tier, a model that does
    // not support it — every such failure must fall through to the normal call
    // rather than cost the project its post.
    logger.warn({ err, action: input.action }, 'batch submit failed, falling back to sync');
    return [];
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

  /*
   * Замовлення одне на кілька постів, тож одне опитування закриває їх усі.
   * Інакше кожен пост ходив би до провайдера сам і питав про той самий стан —
   * двадцять запитів кожні чверть години замість одного.
   */
  const siblings = await db
    .select()
    .from(batchJobs)
    .where(and(eq(batchJobs.providerName, job.providerName), eq(batchJobs.state, 'pending')));

  let mine: BatchOutcome | null = null;

  for (const row of siblings) {
    const item = result.items[row.requestIndex];
    // Відповіді на цей запит немає — для цього поста замовлення не вдалося,
    // хай навіть сусідні відповіді прийшли.
    const state = result.state === 'succeeded' && item && !item.error ? 'succeeded' : 'failed';
    const error = item?.error ?? result.error ?? (item ? null : 'Відповіді на цей запит немає');

    const [updated] = await db
      .update(batchJobs)
      .set({
        state: result.state === 'succeeded' ? state : result.state,
        resultText: item?.text ?? null,
        error: state === 'succeeded' ? null : error,
        inputTokens: item?.usage?.inputTokens ?? null,
        outputTokens: item?.usage?.outputTokens ?? null,
        updatedAt: new Date(),
      })
      .where(eq(batchJobs.id, row.id))
      .returning();

    const final = updated ?? row;

    await record({
      projectId: row.projectId,
      postId: row.postId,
      kind: 'note',
      action: row.action,
      model: row.model,
      source: 'auto',
      batch: true,
      message:
        state === 'succeeded'
          ? `Batch завершився за ${row.model}`
          : `Batch завершився невдало (${result.state}): ${error ?? 'без деталей'}`,
      inputTokens: item?.usage?.inputTokens,
      outputTokens: item?.usage?.outputTokens,
      ok: state === 'succeeded',
    });

    if (row.id === job.id) {
      mine = {
        state: final.state,
        text: item?.text,
        image: item?.image,
        job: final,
      };
    }
  }

  return mine ?? { state: 'failed', job };
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
      batch: true,
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
