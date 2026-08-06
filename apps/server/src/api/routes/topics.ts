import { replenishInputSchema, topicsImportSchema, TOPIC_STATUSES, type TopicDto } from '@tcf/shared';
import { Router } from 'express';
import { z } from 'zod';
import { ChainExhaustedError, ChainMissingError } from '../../ai/chain.js';
import type { Topic } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { getProject, ProjectNotFoundError } from '../../services/projects.js';
import {
  deleteTopics,
  insertTopics,
  listTopics,
  replenishTopics,
  topicCounts,
  TopicNotFoundError,
  updateTopicStatus,
} from '../../services/topics.js';
import { badRequest, firstIssue } from './helpers.js';

export const topicsRouter: Router = Router();

const projectParam = z.object({ id: z.string().uuid('Некоректний ідентифікатор проєкту') });

function toDto(row: Topic): TopicDto {
  return {
    id: row.id,
    title: row.title,
    normalizedHash: row.normalizedHash,
    category: row.category,
    status: row.status,
    source: row.source,
    usedAt: row.usedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

topicsRouter.get('/projects/:id/topics', async (req, res) => {
  const params = projectParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const query = z.object({ status: z.enum(TOPIC_STATUSES).optional() }).safeParse(req.query);
  if (!query.success) return badRequest(res, firstIssue(query.error));

  const [rows, counts] = await Promise.all([
    listTopics(params.data.id, query.data.status),
    topicCounts(params.data.id),
  ]);

  res.json({ topics: rows.map(toDto), counts });
});

/**
 * Free-text import: one topic per line, optionally `Категорія | Назва`.
 * Lines that collide with an existing normalized key are reported, not rejected —
 * pasting a list with a few known topics should not fail the whole import.
 */
topicsRouter.post('/projects/:id/topics/import', async (req, res) => {
  const params = projectParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = topicsImportSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  const entries = parsed.data.text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('|');
      if (separator === -1) return { title: line, category: null };
      return {
        category: line.slice(0, separator).trim() || null,
        title: line.slice(separator + 1).trim(),
      };
    })
    .filter((entry) => entry.title.length > 0);

  const report = await insertTopics(params.data.id, entries, 'manual');
  res.status(201).json(report);
});

/** Asks the model for fresh topics now, instead of waiting for the threshold. */
topicsRouter.post('/projects/:id/topics/replenish', async (req, res) => {
  const params = projectParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = replenishInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  let project;
  try {
    project = await getProject(params.data.id);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    // The button means "give me topics now", so it never batches — but it does
    // collect an answer a scheduled batch already produced.
    const report = await replenishTopics(
      project.id,
      parsed.data.count,
      project.persona,
      project.language,
    );

    if (report === 'batched') {
      res.status(202).json({ error: 'Теми ще готуються в batch-джобі, спробуйте за кілька хвилин' });
      return;
    }

    res.json(report);
  } catch (err) {
    if (err instanceof ChainMissingError || err instanceof ChainExhaustedError) {
      // Same reasoning as dry run: an exhausted chain is diagnostics, and the
      // operator needs the reason, not a 500.
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

topicsRouter.patch('/topics/:topicId', async (req, res) => {
  const params = z.object({ topicId: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = z.object({ status: z.enum(TOPIC_STATUSES) }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  try {
    await updateTopicStatus(params.data.topicId, parsed.data.status);
    res.status(204).end();
  } catch (err) {
    if (err instanceof TopicNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

topicsRouter.post('/topics/delete', async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  const removed = await deleteTopics(parsed.data.ids);
  logger.info({ removed }, 'topics deleted');
  res.json({ removed });
});
