import { replenishInputSchema, ideasImportSchema } from '@tcf/shared';
import { Router } from 'express';
import { z } from 'zod';
import { ChainExhaustedError, ChainMissingError } from '../../ai/chain.js';
import { logger } from '../../logger.js';
import { getProject, ProjectNotFoundError } from '../../services/projects.js';
import { deleteIdeas, insertIdeas, replenishIdeas } from '../../services/ideas.js';
import { badRequest, firstIssue } from './helpers.js';

/**
 * Ideas are posts, so there is no list endpoint here — `GET /projects/:id/posts`
 * already returns them, with `status: 'idea'` and no slot. What remains are the
 * three things that only make sense while a row is still just a subject:
 * importing a batch of them, asking a model for more, and throwing some away.
 */
export const ideasRouter: Router = Router();

const projectParam = z.object({ id: z.string().uuid('Некоректний ідентифікатор проєкту') });

ideasRouter.post('/projects/:id/ideas/import', async (req, res) => {
  const params = projectParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = ideasImportSchema.safeParse(req.body);
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

  const report = await insertIdeas(params.data.id, entries, 'manual');
  res.status(201).json(report);
});

ideasRouter.post('/projects/:id/ideas/replenish', async (req, res) => {
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
    const report = await replenishIdeas(project, parsed.data.count);

    if (report === 'blocked') {
      res.status(409).json({
        error: 'Режим «лише batch»: провайдер не прийняв замовлення, теми не поповнено',
      });
      return;
    }

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

ideasRouter.post('/ideas/delete', async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  const removed = await deleteIdeas(parsed.data.ids);
  logger.info({ removed }, 'topics deleted');
  res.json({ removed });
});
