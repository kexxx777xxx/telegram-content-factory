import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { scheduleSchema } from '@tcf/shared';
import { db } from '../db/client.js';
import { jobs, posts, projects, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { launch, nextInQueue } from '../services/publishNow.js';
import { dueSlot } from './slots.js';

export interface PublisherReport {
  /** Проєктів, у яких настав слот розкладу. */
  due: number;
  /** Постів, відправлених у роботу цим тиком. */
  launched: number;
  /** Із них — закріплених на конкретну хвилину. */
  pinned: number;
}

/**
 * Одна публікація на слот, і вирішує це черга, а не календар.
 *
 * Раніше кожен пост народжувався з власною хвилиною, і пост, який до неї не
 * встиг, втрачав її назавжди: політика «пропустити» позначала його `skipped`,
 * джоба генерації падала на півдорозі, і канал мовчав, маючи повний буфер
 * готових текстів. Тепер розклад відповідає лише на питання «чи час говорити»,
 * а хто саме поїде — визначає черга (ADR 0009).
 *
 * Наслідок, заради якого все й робилось: пропустити пост неможливо. Слот, у
 * який ніхто не встиг, просто лишається невикористаним, і та сама черга поїде
 * в наступний.
 */
export async function publisherTick(): Promise<PublisherReport> {
  const now = new Date();
  const active = await db.select().from(projects).where(eq(projects.status, 'active'));

  let due = 0;
  let launched = 0;
  let pinned = 0;

  for (const project of active) {
    try {
      // Щось із цього проєкту вже пишеться або відправляється — другий пост у
      // тому ж слоті означав би пачку в каналі.
      if (await busy(project.id)) continue;

      const fired = await publishPinned(project, now);
      pinned += fired;
      launched += fired;

      // Закріплений пост щойно зайняв ефір проєкту; черга дочекається
      // наступного слоту, щоб два пости не вийшли одне за одним.
      if (fired > 0) continue;

      const slot = await slotDue(project, now);
      if (!slot) continue;
      due++;

      const next = await nextInQueue(project.id);
      if (!next) {
        logger.child({ project_id: project.id }).warn({ slot }, 'slot arrived with an empty queue');
        continue;
      }

      await launch(next, { source: 'auto' });
      launched++;
    } catch (err) {
      // Один зламаний проєкт не має зупиняти решту каналів.
      logger.error({ err, project_id: project.id }, 'publisher pass failed for project');
    }
  }

  return { due, launched, pinned };
}

/**
 * Пости, яким час обрала людина.
 *
 * Йдуть поза чергою і поза розкладом: «саме цей і саме о 19:00» не має
 * означати «якщо до 19:00 дійде черга». Прострочене закріплення теж
 * публікується — воно не згорає, бо ніхто його не скасовував.
 */
async function publishPinned(project: Project, now: Date): Promise<number> {
  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.projectId, project.id),
        lte(posts.scheduledAt, now),
        inArray(posts.status, ['idea', 'planned', 'ready']),
      ),
    )
    .orderBy(asc(posts.scheduledAt))
    // Більше одного за тик — це вже вивалювання черги в канал, а саме від
    // нього ця модель і рятує.
    .limit(1);

  const post = rows[0];
  if (!post) return 0;

  await launch(post, { source: 'auto' });
  logger.child({ project_id: project.id, post_id: post.id }).info(
    { pinnedAt: post.scheduledAt },
    'pinned post launched',
  );
  return 1;
}

/** Чи настав слот, у який проєкт іще не говорив. */
async function slotDue(project: Project, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ last: sql<string | Date | null>`max(${posts.publishedAt})` })
    .from(posts)
    .where(and(eq(posts.projectId, project.id), eq(posts.status, 'published')));

  const last = row?.last ? new Date(row.last) : project.createdAt;
  return dueSlot(scheduleSchema.parse(project.schedule), project.timezone, last, now);
}

/**
 * Чи вже щось із цього проєкту в дорозі.
 *
 * Генерація в момент публікації триває хвилини, а тик минає щохвилини: без цієї
 * перевірки той самий слот запустив би другий пост, поки перший ще пишеться, і
 * канал отримав би пачку замість одного поста.
 */
async function busy(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        inArray(jobs.type, ['publish_post', 'generate_and_publish']),
        inArray(jobs.status, ['pending', 'running']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Posts stuck in `generating` after their worker died.
 *
 * Generation refuses to start from `generating`, so without this the post is
 * permanently frozen: the job is reclaimed and re-run, sees a status it may not
 * start from, reports "skipped", and the post never becomes anything. Found the
 * hard way — a Rust panic in the SVG renderer aborted the process mid-generation
 * and left the post that way.
 */
export async function reclaimStuckGenerating(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(posts)
    .set({ status: 'planned', updatedAt: new Date() })
    .where(and(eq(posts.status, 'generating'), sql`${posts.updatedAt} < ${cutoff}`))
    .returning({ id: posts.id });

  if (rows.length > 0) logger.warn({ count: rows.length }, 'reclaimed posts stuck in generating');
  return rows.length;
}

/**
 * Posts sitting in `publishing` longer than any send could take.
 *
 * Safe to retry because publishing resumes rather than restarts: a worker that
 * died after Telegram accepted the photo left the message id on the row, so the
 * re-run skips it and sends only what is missing. Before that, this reclaim was
 * itself a way to get the same image posted twice.
 */
export async function reclaimStuckPublishing(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(posts)
    .set({ status: 'ready', updatedAt: new Date() })
    .where(and(eq(posts.status, 'publishing'), sql`${posts.updatedAt} < ${cutoff}`))
    .returning({ id: posts.id });

  if (rows.length > 0) logger.warn({ count: rows.length }, 'reclaimed posts stuck in publishing');
  return rows.length;
}
