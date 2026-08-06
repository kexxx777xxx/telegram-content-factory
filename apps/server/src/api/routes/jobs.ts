import { JOB_STATUSES } from '@tcf/shared';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobs, posts, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { jobCounts, retryJob } from '../../queue/enqueue.js';
import { planTick } from '../../scheduler/planner.js';
import { env } from '../../config.js';
import { sendBackup } from '../../services/backup.js';
import { getDashboard } from '../../services/dashboard.js';
import { badRequest, firstIssue } from './helpers.js';

export const jobsRouter: Router = Router();

/**
 * Statuses a job can be deleted in.
 *
 * `pending` and `running` are excluded deliberately: deleting a job the planner
 * is counting on (or a worker is holding) loses the work silently, and the queue
 * has no way to notice it went missing. Everything terminal is fair game.
 */
const PURGEABLE = ['done', 'failed', 'dead'] as const;

jobsRouter.get('/jobs', async (req, res) => {
  const query = z
    .object({
      status: z.enum(JOB_STATUSES).optional(),
      projectId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .safeParse(req.query);
  if (!query.success) return badRequest(res, firstIssue(query.error));

  const conditions: SQL[] = [];
  if (query.data.status) conditions.push(eq(jobs.status, query.data.status));
  // Filtering in SQL, not after the fact: a project filter applied to an already
  // truncated page showed "нічого" whenever the newest 50 jobs belonged to
  // another project.
  if (query.data.projectId) conditions.push(eq(jobs.projectId, query.data.projectId));

  const rows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      projectId: jobs.projectId,
      // The id answers nothing when read; the name is why the row is here.
      projectName: projects.name,
      payload: jobs.payload,
      status: jobs.status,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      runAfter: jobs.runAfter,
      lastError: jobs.lastError,
      dedupeKey: jobs.dedupeKey,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .leftJoin(projects, eq(jobs.projectId, projects.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(jobs.updatedAt))
    .limit(query.data.limit);

  /*
   * The subject of each job, resolved in one query rather than per row.
   *
   * A queue row saying `publish_post` and nothing else is unactionable: the one
   * question in front of it is «який пост?», and the answer — its topic and a
   * link — lives two tables away. Jobs whose target has since been deleted come
   * back with a null topic, which is itself the answer: nothing to fix, only to
   * remove.
   */
  const postIds = [...new Set(rows.map(payloadPostId).filter((id): id is string => id !== null))];
  const subjects = postIds.length
    ? await db
        .select({ id: posts.id, topicTitle: posts.topicTitle, status: posts.status })
        .from(posts)
        .where(inArray(posts.id, postIds))
    : [];
  const byId = new Map(subjects.map((row) => [row.id, row]));

  res.json({
    counts: await jobCounts(),
    jobs: rows.map(({ payload, ...row }) => {
      const postId = payloadPostId({ payload });
      const post = postId ? byId.get(postId) : undefined;
      return {
        ...row,
        postId: postId,
        /** null both when the job has no post and when that post is gone. */
        postTopic: post?.topicTitle ?? null,
        postStatus: post?.status ?? null,
        postExists: postId !== null && post !== undefined,
        runAfter: row.runAfter.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  });
});

/** Every job that works on a post carries its id here; the rest carry nothing. */
function payloadPostId(row: { payload: unknown }): string | null {
  const postId = (row.payload as { postId?: unknown } | null)?.postId;
  return typeof postId === 'string' ? postId : null;
}

/** Resets attempts and requeues — for jobs that died on a since-fixed cause. */
jobsRouter.post('/jobs/:id/retry', async (req, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const ok = await retryJob(params.data.id);
  if (!ok) {
    res.status(409).json({ error: 'Перезапустити можна лише джобу зі статусом failed або dead' });
    return;
  }
  logger.info({ job_id: params.data.id }, 'job requeued manually');
  res.status(204).end();
});

/** Throws away one finished job. Retry stays the answer while it can still run. */
jobsRouter.delete('/jobs/:id', async (req, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const [row] = await db
    .delete(jobs)
    .where(and(eq(jobs.id, params.data.id), inArray(jobs.status, [...PURGEABLE])))
    .returning({ id: jobs.id });

  if (!row) {
    res.status(409).json({
      error: 'Видалити можна лише завершену джобу (done, failed або dead) — така не знайдена',
    });
    return;
  }
  logger.info({ job_id: params.data.id }, 'job deleted manually');
  res.status(204).end();
});

/**
 * Empties a whole status at once.
 *
 * A queue that accumulated thousands of dead jobs cannot be cleaned one row at
 * a time, and leaving them there costs more than the rows: the counts stop
 * meaning anything, so a *new* failure is invisible among the old ones.
 */
jobsRouter.post('/jobs/purge', async (req, res) => {
  const parsed = z
    .object({
      status: z.enum(PURGEABLE),
      projectId: z.string().uuid().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  const conditions: SQL[] = [eq(jobs.status, parsed.data.status)];
  if (parsed.data.projectId) conditions.push(eq(jobs.projectId, parsed.data.projectId));

  const removed = await db
    .delete(jobs)
    .where(and(...conditions))
    .returning({ id: jobs.id });

  logger.info(
    { status: parsed.data.status, projectId: parsed.data.projectId ?? null, removed: removed.length },
    'queue purged',
  );
  res.json({ removed: removed.length });
});

jobsRouter.get('/dashboard', async (_req, res) => {
  res.json(await getDashboard(env.PUBLISH_GRACE_MINUTES));
});

/** Runs a backup now and reports where it went. */
jobsRouter.post('/backup', async (_req, res) => {
  const meta = await sendBackup();
  if (!meta) {
    res.status(409).json({
      error: 'Адмін-бот не налаштований — бекап нікуди відправляти (ADMIN_BOT_TOKEN / ADMIN_USER_IDS)',
    });
    return;
  }
  res.json(meta);
});

/** Forces a planning pass instead of waiting for the tick — useful after edits. */
jobsRouter.post('/scheduler/plan', async (_req, res) => {
  res.json(await planTick());
});
