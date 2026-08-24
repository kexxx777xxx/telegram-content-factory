import type { PostStatus } from '@tcf/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ChainExhaustedError, ChainMissingError, runChain, type ChainRunResult } from '../ai/chain.js';
import { db } from '../db/client.js';
import { batchJobs, posts, projects, type Post, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { generateImage, type ImageResult } from '../media/pipeline.js';
import { removeStagedImage, stagedImageExists } from '../media/staging.js';
import { sendApprovalCard } from '../telegram/adminBot.js';
import {
  postOverflow,
  sanitizeTelegramHtml,
  stripTrailingHashtags,
  visibleLength,
  type SanitizeResult,
} from '../telegram/html.js';
import {
  BATCH_DEADLINE_MS,
  BATCH_MAX_ITEMS,
  BATCH_MIN_ITEMS,
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
 * Текст довший за ліміт проєкту — не пост, а чернетка, яку ще треба переписати.
 *
 * Ліміт задають, щоб пост влазив у підпис під фото; текст, який його перевищив,
 * розривається на друге повідомлення саме там, де налаштування обіцяло цього не
 * допустити. Тому такий текст не зберігається взагалі: пост лишається
 * незавершеним, а наступний захід пише новий. Ілюстрації це не стосується —
 * вона намальована до теми, а не до конкретної відповіді, і перемальовувати її
 * означало б платити за чужу помилку.
 */
export class PostTooLongError extends Error {}

/**
 * Відповідь моделі у тому вигляді, в якому вона може лягти на рядок поста.
 *
 * Хештеги зрізаються тут, а не при публікації: на рядку має лежати рівно те,
 * що редагує оператор, а теги дописує код перед відправкою.
 */
function cleanPostText(raw: string): SanitizeResult {
  const clean = sanitizeTelegramHtml(raw);
  return { ...clean, html: stripTrailingHashtags(clean.html) };
}

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
  allowBatch: boolean,
): Promise<ChainRunResult | 'waiting' | 'blocked' | null> {
  const log = logger.child({ post_id: post.id, project_id: project.id });

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
   * Хтось чекає просто зараз — ручний запуск, закріплена хвилина або порожній
   * буфер, який пише пост у момент публікації. Доби на дешевий тариф немає, і
   * режим тут ні до чого: працює звичайний ланцюжок.
   */
  if (!allowBatch) return null;

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
    deadline: new Date(Date.now() + BATCH_DEADLINE_MS),
  });

  if (submitted.length > 0) return 'waiting';

  /*
   * «Лише batch» is a statement about price, and generating at full price is
   * exactly what it forbids. Пост лишається ненаписаним і просто не рухається
   * чергою — слоту, який через це згорів би, більше не існує.
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

  const projectCache = new Map<string, Project | undefined>();

  for (const row of siblings) {
    if (!row.postId || row.postId === currentPostId || !row.resultText) continue;

    const [target] = await db.select().from(posts).where(eq(posts.id, row.postId)).limit(1);
    // Пост міг піти далі сам — синхронною генерацією або руками. Перезаписувати
    // готовий текст відповіддю, яку ніхто вже не чекав, не можна.
    if (!target || target.textHtml || target.status !== 'planned') {
      await dropBatch(row.id);
      continue;
    }

    if (!projectCache.has(row.projectId)) {
      const [found] = await db.select().from(projects).where(eq(projects.id, row.projectId)).limit(1);
      projectCache.set(row.projectId, found);
    }
    const owner = projectCache.get(row.projectId);
    if (!owner) {
      await dropBatch(row.id);
      continue;
    }

    const clean = cleanPostText(row.resultText);

    /*
     * Той самий ліміт, що й у синхронному шляху: відповідь із дешевого тарифу
     * не стає винятком лише тому, що за неї вже заплачено. Пост лишається
     * `planned` — його власна джоба напише текст заново, а намальована
     * ілюстрація на рядку доживе до нього.
     */
    const over = postOverflow(clean.html, owner.hashtags, owner.postMaxChars);
    if (over > 0) {
      await record({
        projectId: row.projectId,
        postId: row.postId,
        kind: 'note',
        action: 'post_text',
        model: row.model,
        source: 'auto',
        ok: false,
        message: `Текст із batch-замовлення відхилено: на ${over} символів довший за ліміт ${owner.postMaxChars}`,
      });
      await dropBatch(row.id);
      continue;
    }
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
      batch: true,
      message: `Текст із batch-замовлення: ${visibleLength(clean.html)} символів, модель ${row.model}`,
      inputTokens: row.inputTokens ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
    });

    await dropBatch(row.id);
  }
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
 * Список у тому порядку, у якому оператор про нього думає: спершу те, що вже
 * вийшло, потім черга.
 *
 * Всередині черги порядок той самий, що й у публікатора, — закріплений час,
 * далі ручний пріоритет. Випадковість сюди не тягнеться навмисно: список, який
 * перемішується на кожне оновлення, неможливо читати.
 */
export async function listPosts(projectId: string, limit = 500): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(eq(posts.projectId, projectId))
    .orderBy(
      sql`${posts.publishedAt} desc nulls last`,
      sql`${posts.scheduledAt} asc nulls last`,
      sql`${posts.position} asc nulls last`,
      desc(posts.createdAt),
    )
    .limit(limit);
}

/** Місце в черзі змінюють лише поки пост іще не пішов. */
const QUEUE_EDITABLE: PostStatus[] = ['idea', 'planned', 'generating', 'ready', 'awaiting_approval'];

/**
 * Місце поста в черзі: закріплений час, ручний пріоритет або обидва.
 *
 * `null` в обох полях — це не «не чіпати», а «прибрати»: саме так пост
 * повертається у звичайну чергу, а без явного скидання закріплений час не було
 * б як зняти.
 */
export async function updatePostQueue(
  id: string,
  patch: { position?: number | null; scheduledAt?: Date | null },
): Promise<Post> {
  const post = await getPost(id);
  if (!QUEUE_EDITABLE.includes(post.status)) {
    throw new PostNotFoundError(`Пост у статусі «${post.status}» уже поза чергою`);
  }

  const values: Partial<typeof posts.$inferInsert> = { updatedAt: new Date() };
  if (patch.position !== undefined) values.position = patch.position;
  if (patch.scheduledAt !== undefined) values.scheduledAt = patch.scheduledAt;

  const [row] = await db.update(posts).set(values).where(eq(posts.id, id)).returning();
  if (!row) throw new PostNotFoundError('Пост не знайдено');
  return row;
}

/**
 * Ставить пост на початок черги.
 *
 * Окрема дія, а не «введіть число на одиницю менше за найменше»: «хочу, щоб цей
 * пішов наступним» — це те, чого від черги хочуть найчастіше.
 */
export async function bumpToFront(id: string): Promise<Post> {
  const post = await getPost(id);
  const [row] = await db
    .select({ min: sql<number | null>`min(${posts.position})` })
    .from(posts)
    .where(and(eq(posts.projectId, post.projectId), inArray(posts.status, QUEUE_EDITABLE)));

  return updatePostQueue(id, { position: (row?.min ?? 1) - 1 });
}

/**
 * Produces the post text for a queued post.
 *
 * Idempotent by status: a job that runs twice (a retry after an ambiguous
 * failure, say) finds the post already past `planned` and does nothing rather
 * than spending another model call and overwriting a draft someone may have
 * edited by hand.
 *
 * `allowBatch` каже, чи має пост право чекати добу на дешевий тариф. Це
 * властивість не поста, а того, хто його запустив: буферна джоба нікуди не
 * поспішає, а генерація в момент публікації — навпаки. Раніше відповідь
 * виводилась із запасу до слоту, і саме тому batch для тексту не траплявся
 * ніколи: джоба прокидалась за три години до слоту.
 */
export async function generatePostText(
  postId: string,
  opts: { allowBatch?: boolean } = {},
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
    const batched = await batchedText(post, project, variables, opts.allowBatch === true);
    if (batched === 'waiting') return 'batched';

    if (batched === 'blocked') {
      log.warn('batch-only project cannot batch this post, generation skipped');
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
      const clean = cleanPostText(result.text);
      if (clean.removedTags.length > 0) {
        log.info({ removedTags: clean.removedTags }, 'model returned markup outside the allowed set');
      }

      /*
       * Довжину теж просили в промпті — і так само не отримали гарантії. Текст
       * понад ліміт не лягає на рядок узагалі: інакше пост дійшов би до слоту
       * «готовим» і поїхав у канал двома повідомленнями замість підпису під
       * фото. Пост вертається в `planned` (це робить `fail`), ілюстрація на
       * рядку лишається, і наступний захід пише лише текст.
       */
      const over = postOverflow(clean.html, project.hashtags, project.postMaxChars);
      if (over > 0) {
        await record({
          projectId: project.id,
          postId: post.id,
          kind: 'note',
          action: 'post_text',
          model: result.model,
          source: 'auto',
          ok: false,
          message: `Текст відхилено: на ${over} символів довший за ліміт ${project.postMaxChars} (з хештегами)`,
        });
        throw new PostTooLongError(
          `Текст на ${over} символів довший за ліміт проєкту (${project.postMaxChars} символів разом із хештегами)`,
        );
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
        batch: batched !== null,
        message:
          `Текст готовий: ${visibleLength(clean.html)} символів, модель ${result.model}, ` +
          `промпт v${result.promptVersion}` +
          (batched !== null ? ' — batch-тариф, −50%' : ' — звичайний виклик'),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    } catch (err) {
      return fail(err);
    }
  }

  try {
    /*
     * Ілюстрація могла лишитись від попереднього заходу — найчастіше тому, що
     * текст відхилили за довжиною. Вона намальована до теми, а тема та сама,
     * тож малювати вдруге означало б платити за те саме: найдорожчий виклик у
     * пості повторюється через помилку, до якої не має стосунку. Свідома
     * перегенерація (`resetForRegeneration`) стирає і файл, і шлях — після неї
     * тут уже нічого не знайдеться.
     */
    const staged: ImageResult | null = stagedImageExists(post.imagePath)
      ? {
          path: post.imagePath!,
          kind: (post.imageKind as ImageResult['kind'] | null) ?? 'svg',
          svgSource: post.svgSource,
          model: null,
          attempts: 0,
          notes: [],
          viaBatch: false,
        }
      : null;

    // Image generation happens after the text so the image-model branch can
    // describe what the post actually says, not just its topic.
    const image =
      staged ??
      (await generateImage({ id: post.id, topicTitle, textHtml }, project, {
        allowBatch: opts.allowBatch === true,
      }));
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

    if (image && !staged) {
      await record({
        projectId: project.id,
        postId: post.id,
        kind: 'generation_step',
        action: image.kind === 'image_model' ? 'image' : 'svg',
        model: image.model,
        source: 'auto',
        batch: image.viaBatch,
        message:
          image.kind === 'svg_fallback'
            ? 'Ілюстрація: резервна схема, модель не дала валідного SVG'
            : `Ілюстрація готова (${image.kind}), модель ${image.model}` +
              (image.viaBatch ? ' — batch-тариф, −50%' : ' — звичайний виклик'),
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

  const clean = cleanPostText(textHtml);

  // Правка руками — така сама межа, як і генерація: пост із текстом понад ліміт
  // не існує ні в якому вигляді, інакше правка була б способом його обійти.
  const [owner] = await db.select().from(projects).where(eq(projects.id, post.projectId)).limit(1);
  if (owner) {
    const over = postOverflow(clean.html, owner.hashtags, owner.postMaxChars);
    if (over > 0) {
      throw new PostTooLongError(
        `Текст на ${over} символів довший за ліміт проєкту (${owner.postMaxChars} символів разом із хештегами)`,
      );
    }
  }

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

/** Пости, які ще стоять у черзі, — глибина буфера для дашборда. */
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
    .orderBy(sql`${posts.scheduledAt} asc nulls last`, sql`${posts.position} asc nulls last`);
}

export { ChainExhaustedError };
