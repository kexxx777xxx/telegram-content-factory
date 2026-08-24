import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, posts, projects, type Post } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueue } from '../queue/enqueue.js';
import { getPost, PostNotFoundError } from './posts.js';

/** Raised for states where "publish now" cannot mean anything sensible. */
export class NotLaunchableError extends Error {}

export interface LaunchResult {
  postId: string;
  /** Яким шляхом пішов пост, щоб UI не перевиводив це зі статусу. */
  job: 'publish_post' | 'generate_and_publish';
}

/** Статуси, з яких пост іще може поїхати в канал. */
const LAUNCHABLE: Post['status'][] = ['idea', 'planned', 'ready', 'awaiting_approval', 'failed'];

/**
 * Наступний пост черги — той, що поїде в найближчий слот.
 *
 * Порядок читається згори вниз і саме в такому вигляді описаний оператору:
 *
 *   1. ручний пріоритет — менше число раніше;
 *   2. серед рівних — готовий випереджає ненаписаний: у слот краще віддати те,
 *      за що вже заплачено, ніж чекати на модель просто зараз;
 *   3. решта — випадково, щоб канал не читався як один згенерований захід
 *      підряд.
 *
 * Закріплені часом пости сюди не потрапляють: у них власний момент, і черга їх
 * не чіпає.
 */
export async function nextInQueue(projectId: string): Promise<Post | null> {
  const [row] = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.projectId, projectId),
        isNull(posts.scheduledAt),
        inArray(posts.status, ['idea', 'planned', 'ready']),
      ),
    )
    .orderBy(
      sql`${posts.position} asc nulls last`,
      sql`case when ${posts.status} = 'ready' then 0 else 1 end`,
      sql`random()`,
    )
    .limit(1);

  return row ?? null;
}

/**
 * Runs a post immediately, whatever state it is in.
 *
 * Ready posts go straight to the publisher; unfinished ones take the
 * generate-then-publish path in a single job. That is the same job the
 * just-in-time mode uses, so a manual launch cannot leave a freshly generated
 * post sitting with nothing to publish it.
 */
export async function launchPost(postId: string): Promise<LaunchResult> {
  return launch(await getPost(postId), { source: 'manual' });
}

/**
 * The project-level launch: takes whatever the queue would publish next.
 *
 * Раніше тут доводилось вигадувати посту слот, якщо жодного не було. Тепер
 * слоту не існує як власності поста, тож кнопка просто бере голову черги — а
 * якщо черга порожня, чесно про це каже замість того, щоб створити порожній
 * рядок і згенерувати пост нізвідки.
 */
export async function launchProject(projectId: string): Promise<LaunchResult> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new NotLaunchableError('Проєкт не знайдено');

  const next = await nextInQueue(projectId);
  if (!next) throw new NotLaunchableError('Черга порожня: немає ні готового поста, ні теми');

  return launch(next, { source: 'manual' });
}

export async function launch(
  post: Post,
  opts: { source: 'auto' | 'manual' },
): Promise<LaunchResult> {
  const log = logger.child({ post_id: post.id, project_id: post.projectId });
  const manual = opts.source === 'manual';

  if (post.status === 'published') throw new NotLaunchableError('Пост уже опубліковано');
  if (!LAUNCHABLE.includes(post.status)) {
    throw new NotLaunchableError(`Пост уже в роботі: статус «${post.status}»`);
  }

  if ((post.status === 'ready' || post.status === 'awaiting_approval') && post.textHtml) {
    await enqueue({
      type: 'publish_post',
      projectId: post.projectId,
      payload: { postId: post.id, manual },
      priority: manual ? 50 : 20,
      dedupeKey: `post:${post.id}:publish`,
    });
    log.info({ source: opts.source }, 'publish queued');
    return { postId: post.id, job: 'publish_post' };
  }

  // Тема стає постом рівно в цей момент: слот більше не потрібен, потрібен лише
  // статус, з якого генерація має право початись.
  if (post.status === 'idea' || post.status === 'failed') {
    await db
      .update(posts)
      .set({ status: 'planned', error: null, updatedAt: new Date() })
      .where(eq(posts.id, post.id));
  }

  // A generate job may already be pending from the buffer. Leaving it would let
  // both run: one generates while the other finds the post still unfinished and
  // fails the publish. Pending jobs are safe to drop — a running one is not, and
  // the dedupe key protects that case.
  await db
    .delete(jobs)
    .where(and(eq(jobs.status, 'pending'), eq(jobs.dedupeKey, `post:${post.id}:generate`)));

  await enqueue({
    type: 'generate_and_publish',
    projectId: post.projectId,
    payload: { postId: post.id, manual },
    priority: manual ? 40 : 30,
    dedupeKey: `post:${post.id}:generate_publish`,
  });
  log.info({ status: post.status, source: opts.source }, 'generate-and-publish queued');
  return { postId: post.id, job: 'generate_and_publish' };
}

export { PostNotFoundError };
