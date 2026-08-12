import type { PostStatus } from '@tcf/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ChainExhaustedError, ChainMissingError, runChain, type ChainRunResult } from '../ai/chain.js';
import { db } from '../db/client.js';
import { batchJobs, posts, projects, type Post, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { generateImage } from '../media/pipeline.js';
import { removeStagedImage } from '../media/staging.js';
import { sendApprovalCard } from '../telegram/adminBot.js';
import { sanitizeTelegramHtml, visibleLength } from '../telegram/html.js';
import {
  BATCH_DEADLINE_MARGIN_MS,
  BATCH_MAX_ITEMS,
  BATCH_MIN_ITEMS,
  BATCH_MIN_SLACK_MS,
  batchCandidates,
  collectBatch,
  dropBatch,
  findBatch,
  submitBatch,
} from '../ai/batch.js';
import { projectVariables } from '../prompts/variables.js';
import { record } from './activityLog.js';
import { ensureSubject, insertIdeas } from './ideas.js';

export class PostNotFoundError extends Error {}

/**
 * Text from the batch tier, or a decision about waiting for it.
 *
 * Returns a chain-shaped result when the answer is already in, `'waiting'`
 * while it is still cooking, `'blocked'` when the project asked for batch and
 * nothing else, and `null` when the normal pipeline should just run.
 */
async function batchedText(
  post: Post,
  project: Project,
  variables: Record<string, string | number | undefined>,
): Promise<ChainRunResult | 'waiting' | 'blocked' | null> {
  const log = logger.child({ post_id: post.id, project_id: project.id });
  /*
   * No slot means nobody is waiting on a schedule — which sounds like the ideal
   * batch candidate but is the opposite. A post without a slot is being run by
   * hand, right now, and the cheap tier answers in up to a day.
   */
  const slot = post.scheduledAt;

  const existing = await findBatch(post.id, 'post_text');
  if (existing) {
    const outcome = await collectBatch(existing.id);
    if (outcome?.state === 'pending') return 'waiting';

    // Замовлення прийшло цілком — розкладаємо його по всіх постах одразу, ще до
    // того, як до кожного дійде своя джоба.
    await distributeGroupText(existing.providerName, post.id);
    await dropBatch(existing.id);
    if (outcome?.state === 'succeeded' && outcome.text) {
      return {
        text: outcome.text,
        model: existing.model,
        apiKeyId: existing.apiKeyId,
        promptId: existing.promptId ?? 'builtin',
        promptVersion: existing.promptVersion ?? 0,
        usage: {
          inputTokens: outcome.job.inputTokens ?? 0,
          outputTokens: outcome.job.outputTokens ?? 0,
        },
        attempts: [],
      };
    }
    // Failed, cancelled or expired: fall through to the normal call rather
    // than leave the slot with nothing.
    return null;
  }

  /*
   * Too close to the slot — or no slot at all, which means someone pressed a
   * button just now. Either way there is no day to spare, so the mode does not
   * enter into it: the normal pipeline runs.
   */
  if (!slot || slot.getTime() - Date.now() < BATCH_MIN_SLACK_MS) return null;

  if (project.batchMode === 'off') return null;

  /*
   * Замовлення збирається на весь буфер, а не на цей пост: у batch платять за
   * запит, тож двадцять постів в одному замовленні коштують як двадцять
   * окремих, але це одне звернення і одне опитування. Сусідів шукаємо за тими
   * самими умовами, за якими сюди дійшов цей пост, — коли черга дійде до них,
   * вони знайдуть готову відповідь замість того, щоб замовляти ще раз.
   */
  const candidates = await batchCandidates({
    projectId: project.id,
    action: 'post_text',
    minSlackMs: BATCH_MIN_SLACK_MS,
    needsText: false,
    limit: BATCH_MAX_ITEMS,
  });

  /*
   * Один кандидат — не замовлення. Економія від одного запиту та сама, що й від
   * двадцяти, а чекати доводиться однаково; та й сам факт, що в буфері лишився
   * один придатний пост, каже, що буфер замалий для дешевого тарифу. Такий пост
   * іде звичайним викликом, а в режимі «лише batch» це видно в журналі.
   */
  if (candidates.length < BATCH_MIN_ITEMS) {
    log.info(
      { candidates: candidates.length },
      'too few posts ready for one batch order, generating synchronously',
    );
    return null;
  }

  const shared = await projectVariables(project);
  const submitted = await submitBatch({
    action: 'post_text',
    projectId: project.id,
    items: candidates.map((candidate) => ({
      postId: candidate.id,
      variables: { ...shared, topic: candidate.topicTitle ?? '' },
    })),
    // Дедлайн — за найближчим слотом у замовленні: воно приходить цілком, тож
    // корисним має лишитись для найтерміновішого з постів.
    deadline: new Date(earliestSlot(candidates, slot).getTime() - BATCH_DEADLINE_MARGIN_MS),
  });

  if (submitted.length > 0) return 'waiting';

  /*
   * «Лише batch» is a statement about price, and generating at full price is
   * exactly what it forbids. The slot is left empty rather than filled at twice
   * the cost — the miss policy then decides what happens when it arrives.
   */
  return project.batchMode === 'batch_only' ? 'blocked' : null;
}

/**
 * Розкладає відповіді одного замовлення по постах, яким вони належать.
 *
 * Без цього готовий текст лежав у рядку `batch_jobs`, доки до поста не дійде
 * його власна джоба — а вона прокидається за годину-дві. Наслідків було два, і
 * обидва видно в журналі: тридцять оплачених відповідей чекали неспожитими, а
 * ілюстрація щоразу малювалась поодинці, бо в стані «текст є, картинки немає»
 * ніколи не було двох постів одночасно — а отже, і замовлення на малювання не
 * збиралось.
 *
 * Поточний пост пропускається: його відповідь повертається викликачу і
 * зберігається звичайним шляхом разом з усією метаінформацією про генерацію.
 */
async function distributeGroupText(providerName: string, currentPostId: string): Promise<void> {
  const siblings = await db
    .select()
    .from(batchJobs)
    .where(and(eq(batchJobs.providerName, providerName), eq(batchJobs.state, 'succeeded')));

  for (const row of siblings) {
    if (!row.postId || row.postId === currentPostId || !row.resultText) continue;

    const [target] = await db.select().from(posts).where(eq(posts.id, row.postId)).limit(1);
    // Пост міг піти далі сам — синхронною генерацією або руками. Перезаписувати
    // готовий текст відповіддю, яку ніхто вже не чекав, не можна.
    if (!target || target.textHtml || target.status !== 'planned') {
      await dropBatch(row.id);
      continue;
    }

    const clean = sanitizeTelegramHtml(row.resultText);
    await db
      .update(posts)
      .set({
        textHtml: clean.html,
        generation: {
          ...(target.generation as GenerationMeta),
          model: row.model,
          promptId: row.promptId ?? undefined,
          promptVersion: row.promptVersion ?? undefined,
          inputTokens: row.inputTokens ?? undefined,
          outputTokens: row.outputTokens ?? undefined,
          generatedAt: new Date().toISOString(),
          removedTags: clean.removedTags,
          visibleLength: visibleLength(clean.html),
        },
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, row.postId));

    await record({
      projectId: row.projectId,
      postId: row.postId,
      kind: 'generation_step',
      action: 'post_text',
      model: row.model,
      source: 'auto',
      message: `Текст із batch-замовлення: ${visibleLength(clean.html)} символів, модель ${row.model}`,
      inputTokens: row.inputTokens ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
    });

    await dropBatch(row.id);
  }
}

/** Найраніший слот у замовленні — за ним і рахується, доки відповідь корисна. */
function earliestSlot(candidates: Post[], fallback: Date): Date {
  const slots = candidates.map((c) => c.scheduledAt).filter((s): s is Date => s !== null);
  return slots.length > 0 ? new Date(Math.min(...slots.map((s) => s.getTime()))) : fallback;
}

/** Statuses a generation job may legitimately start from. */
const GENERATABLE: PostStatus[] = ['idea', 'planned', 'failed'];

export interface GenerationMeta {
  model?: string;
  imageKind?: string | null;
  imageModel?: string | null;
  imageNotes?: string[];
  promptId?: string;
  promptVersion?: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts?: number;
  generatedAt?: string;
  removedTags?: string[];
  visibleLength?: number;
}

export async function getPost(id: string): Promise<Post> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

/**
 * The whole list: scheduled posts first, then the idea bank.
 *
 * `NULLS LAST` is load-bearing, not cosmetic. Ideas carry no slot, and Postgres
 * sorts NULLs *first* in a DESC order — so a project with more ideas than the
 * limit returned nothing but ideas, while the status chips (counted by a
 * separate query) still advertised posts that never appeared. The list looked
 * empty for the one channel that had used it most.
 */
export async function listPosts(projectId: string, limit = 500): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(eq(posts.projectId, projectId))
    .orderBy(sql`${posts.scheduledAt} desc nulls last`, desc(posts.createdAt))
    .limit(limit);
}

/**
 * Produces the post text for a planned slot.
 *
 * Idempotent by status: a job that runs twice (a retry after an ambiguous
 * failure, say) finds the post already past `planned` and does nothing rather
 * than spending another model call and overwriting a draft someone may have
 * edited by hand.
 */
export async function generatePostText(
  postId: string,
): Promise<'generated' | 'skipped' | 'batched'> {
  const post = await getPost(postId);
  const log = logger.child({ post_id: post.id, project_id: post.projectId });

  if (!GENERATABLE.includes(post.status)) {
    log.info({ status: post.status }, 'post already past planning, generation skipped');
    return 'skipped';
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, post.projectId)).limit(1);
  if (!project) throw new ChainMissingError('Проєкт поста не існує');

  /*
   * The topic is claimed before anything else, because both paths need it: the
   * batch prompt is rendered from it, and so is the synchronous one.
   */
  const withSubject = await ensureSubject(post, project);
  if (!withSubject?.topicTitle) {
    throw new ChainMissingError('Немає доступної теми і не вдалося згенерувати нову');
  }
  const topicTitle = withSubject.topicTitle;

  const variables = { ...(await projectVariables(project)), topic: topicTitle };

  /*
   * Batch first, when the slot is far enough away to afford a 24-hour answer.
   *
   * The status stays `planned` while waiting on purpose: `generating` means a
   * model is working on it right now, and a post parked for a day is not that.
   * It also keeps the post recoverable — a stuck-generation reaper would have
   * nothing to reclaim here, because nothing is stuck.
   */
  /*
   * Невдача будь-якого кроку повертає пост у `planned`, щоб черга підхопила
   * його чисто. Тема лишається на рядку — повтор бере її, а не спорожнює банк
   * по одній спробі за раз.
   */
  const fail = async (err: unknown): Promise<never> => {
    const terminal = err instanceof ChainMissingError;
    await db
      .update(posts)
      .set({
        status: terminal ? 'failed' : 'planned',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));

    throw err;
  };

  /*
   * Текст уже на рядку — отже, попередній захід зберіг його і припаркувався на
   * замовленні ілюстрації. Генерувати вдруге не можна: це і зайвий виклик, і
   * перезапис того, що вже могли поправити руками.
   */
  let textHtml = post.textHtml;
  let textMeta: GenerationMeta | null = null;

  if (!textHtml) {
    const batched = await batchedText(post, project, variables);
    if (batched === 'waiting') return 'batched';

    if (batched === 'blocked') {
      log.warn('batch-only project cannot batch this slot, generation skipped');
      await record({
        projectId: project.id,
        postId: post.id,
        kind: 'note',
        action: 'post_text',
        source: 'auto',
        ok: false,
        message:
          'Режим «лише batch»: замовлення не прийнято (ключ без batch або провайдер відмовив), ' +
          'тому синхронна генерація не запускалась',
      });
      return 'skipped';
    }

    await db
      .update(posts)
      .set({ status: 'generating', error: null, updatedAt: new Date() })
      .where(eq(posts.id, post.id));

    try {
      const result =
        batched ??
        (await runChain({
          action: 'post_text',
          projectId: project.id,
          postId: post.id,
          variables,
        }));

      // The model was asked for a restricted tag set; this is what enforces it.
      const clean = sanitizeTelegramHtml(result.text);
      if (clean.removedTags.length > 0) {
        log.info({ removedTags: clean.removedTags }, 'model returned markup outside the allowed set');
      }

      textHtml = clean.html;
      textMeta = {
        model: result.model,
        promptId: result.promptId,
        promptVersion: result.promptVersion,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        attempts: result.attempts.length,
        generatedAt: new Date().toISOString(),
        removedTags: clean.removedTags,
        visibleLength: visibleLength(clean.html),
      };

      /*
       * Текст лягає в базу до ілюстрації, а не разом із нею. Ілюстрація теж
       * може поїхати в batch, і тоді джоба засинає на чверть години; без цього
       * запису вона прокинулась би з порожнім постом і замовила текст удруге —
       * за гроші й поверх уже написаного. Статус повертається в `planned` з тієї
       * ж причини, з якої там стоїть текстовий batch: `generating` означає, що
       * просто зараз працює модель, а пост у черзі на дешевий тариф — це не те.
       */
      await db
        .update(posts)
        .set({
          textHtml,
          status: 'planned',
          generation: { ...(post.generation as GenerationMeta), ...textMeta },
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(posts.id, post.id));

      await record({
        projectId: project.id,
        postId: post.id,
        kind: 'generation_step',
        action: 'post_text',
        model: result.model,
        source: 'auto',
        message: `Текст готовий: ${visibleLength(clean.html)} символів, модель ${result.model}, промпт v${result.promptVersion}`,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    } catch (err) {
      return fail(err);
    }
  }

  try {
    // Image generation happens after the text so the image-model branch can
    // describe what the post actually says, not just its topic.
    const image = await generateImage(
      { id: post.id, topicTitle, textHtml, scheduledAt: post.scheduledAt },
      project,
    );
    if (image === 'waiting') return 'batched';

    const meta: GenerationMeta = {
      ...(post.generation as GenerationMeta),
      ...(textMeta ?? {}),
      imageKind: image?.kind ?? null,
      imageModel: image?.model ?? null,
      imageNotes: image?.notes ?? [],
    };

    await db
      .update(posts)
      .set({
        textHtml,
        imagePath: image?.path ?? null,
        imageKind: image?.kind ?? null,
        // `svgSource` is kept only while the post is buffered; publishing clears it.
        svgSource: image?.svgSource ?? null,
        status: project.publishMode === 'approval' ? 'awaiting_approval' : 'ready',
        generation: meta,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));

    if (image) {
      await record({
        projectId: project.id,
        postId: post.id,
        kind: 'generation_step',
        action: image.kind === 'image_model' ? 'image' : 'svg',
        model: image.model,
        source: 'auto',
        message:
          image.kind === 'svg_fallback'
            ? 'Ілюстрація: резервна схема, модель не дала валідного SVG'
            : `Ілюстрація готова (${image.kind}), модель ${image.model}`,
        detail: image.notes.length > 0 ? image.notes.join('\n') : null,
      });
    }

    log.info(
      { chars: meta.visibleLength, topic: topicTitle, image: image?.kind ?? 'none' },
      'post generated',
    );

    // Approval mode is useless if nobody is told a verdict is needed. A failure
    // to deliver the card must not undo a successful generation, though.
    if (project.publishMode === 'approval') {
      await sendApprovalCard(post.id).catch((err: unknown) =>
        log.warn({ err }, 'could not send approval card'),
      );
    }

    return 'generated';
  } catch (err) {
    return fail(err);
  }
}

/**
 * Puts the post's subject back in the bank and strips it from the post.
 *
 * Used by «інша тема». The subject is re-filed as its own idea row rather than
 * discarded: it was curated work, and the dedup hash travels with it so it
 * cannot be proposed twice. A hash collision means an equivalent idea already
 * exists, and dropping this one is then the right outcome.
 */
async function detachSubject(post: Post): Promise<void> {
  if (post.topicTitle && post.normalizedHash) {
    await db
      .insert(posts)
      .values({
        projectId: post.projectId,
        status: 'idea',
        scheduledAt: null,
        topicTitle: post.topicTitle,
        normalizedHash: post.normalizedHash,
        category: post.category,
        source: post.source,
      })
      .onConflictDoNothing({
        target: [posts.projectId, posts.normalizedHash],
        where: sql`${posts.normalizedHash} is not null`,
      });
  }
}

/** Manual edit of a draft. Sanitised on the way in, same as generated text. */
export async function updatePostText(id: string, textHtml: string): Promise<Post> {
  const post = await getPost(id);
  if (post.status === 'published') {
    throw new PostNotFoundError('Опублікований пост редагувати не можна — текст уже стерто');
  }

  const clean = sanitizeTelegramHtml(textHtml);

  // `removedTags` must describe *this* edit, not the original generation —
  // otherwise the editor reports nothing while quietly rewriting what was typed.
  const meta: GenerationMeta & { editedAt: string } = {
    ...(post.generation as GenerationMeta),
    editedAt: new Date().toISOString(),
    removedTags: clean.removedTags,
    visibleLength: visibleLength(clean.html),
  };

  const [row] = await db
    .update(posts)
    .set({ textHtml: clean.html, generation: meta, updatedAt: new Date() })
    .where(eq(posts.id, id))
    .returning();

  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

/** Puts a post back to `planned` so a fresh generation job can run. */
export async function resetForRegeneration(id: string, keepTopic: boolean): Promise<Post> {
  const post = await getPost(id);
  if (post.status === 'published') {
    throw new PostNotFoundError('Опублікований пост не перегенерувати');
  }

  if (!keepTopic) await detachSubject(post);
  // Without this the previous render stays on disk with nothing referencing it.
  await removeStagedImage(post.imagePath);

  const [row] = await db
    .update(posts)
    .set({
      status: 'planned',
      textHtml: null,
      imagePath: null,
      imageKind: null,
      svgSource: null,
      /*
       * Cleared, or the fresh post would inherit the previous attempt's resume
       * trail and skip sending its own photo — publishing a new text under an
       * old image.
       */
      tgMessageId: null,
      tgExtraMessageIds: null,
      error: null,
      ...(keepTopic ? {} : { topicTitle: null, normalizedHash: null, category: null }),
      updatedAt: new Date(),
    })
    .where(eq(posts.id, id))
    .returning();

  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

export async function postCounts(projectId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: posts.status, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(eq(posts.projectId, projectId))
    .groupBy(posts.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** Posts still ahead of their slot — the buffer depth the dashboard reports. */
export async function upcomingPosts(projectId: string): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.projectId, projectId),
        inArray(posts.status, ['planned', 'generating', 'ready', 'awaiting_approval']),
      ),
    )
    .orderBy(asc(posts.scheduledAt));
}

export { ChainExhaustedError };
