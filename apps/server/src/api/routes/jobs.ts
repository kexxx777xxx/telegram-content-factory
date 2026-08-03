import { JOB_STATUSES } from '@tcf/shared';
import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobs } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { jobCounts, retryJob } from '../../queue/enqueue.js';
import { planTick } from '../../scheduler/planner.js';
import { sendBackup } from '../../services/backup.js';
import { badRequest, firstIssue } from './helpers.js';

export const jobsRouter: Router = Router();

jobsRouter.get('/jobs', async (req, res) => {
  const query = z
    .object({
      status: z.enum(JOB_STATUSES).optional(),
      projectId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .safeParse(req.query);
  if (!query.success) return badRequest(res, firstIssue(query.error));

  const rows = await db
    .select()
    .from(jobs)
    .where(query.data.status ? eq(jobs.status, query.data.status) : undefined)
    .orderBy(desc(jobs.updatedAt))
    .limit(query.data.limit);

  res.json({
    counts: await jobCounts(),
    jobs: rows
      .filter((row) => !query.data.projectId || row.projectId === query.data.projectId)
      .map((row) => ({
        id: row.id,
        type: row.type,
        projectId: row.projectId,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        runAfter: row.runAfter.toISOString(),
        lastError: row.lastError,
        dedupeKey: row.dedupeKey,
        updatedAt: row.updatedAt.toISOString(),
      })),
  });
});

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
