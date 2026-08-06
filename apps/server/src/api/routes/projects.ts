import { projectInputSchema, projectUpdateSchema } from '@tcf/shared';
import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../../logger.js';
import {
  cacheChannelUsername,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectBotToken,
  ProjectConflictError,
  ProjectNotFoundError,
  toDto,
  updateProject,
} from '../../services/projects.js';
import { projectLog } from '../../services/activityLog.js';
import { launchProject, NotLaunchableError } from '../../services/publishNow.js';
import { verifyTelegram } from '../../telegram/verify.js';

export const projectsRouter: Router = Router();

const idParam = z.object({ id: z.string().uuid('Некоректний ідентифікатор проєкту') });

projectsRouter.get('/projects', async (_req, res) => {
  res.json(await listProjects());
});

projectsRouter.post('/projects', async (req, res) => {
  const parsed = projectInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  try {
    const project = await createProject(parsed.data);
    logger.info({ projectId: project.id, slug: project.slug }, 'project created');
    res.status(201).json(project);
  } catch (err) {
    if (err instanceof ProjectConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

projectsRouter.get('/projects/:id', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: firstIssue(params.error) });
    return;
  }

  try {
    res.json(toDto(await getProject(params.data.id)));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

projectsRouter.patch('/projects/:id', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: firstIssue(params.error) });
    return;
  }
  const parsed = projectUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  try {
    const project = await updateProject(params.data.id, parsed.data);
    logger.info({ projectId: project.id }, 'project updated');
    res.json(project);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

projectsRouter.delete('/projects/:id', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: firstIssue(params.error) });
    return;
  }

  try {
    await deleteProject(params.data.id);
    logger.warn({ projectId: params.data.id }, 'project deleted');
    res.status(204).end();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Probes the channel with the project's bot. Also caches the channel username
 * on success — that is what later lets the publisher build a public
 * `t.me/name/123` permalink instead of the opaque `t.me/c/…` form.
 */
projectsRouter.post('/projects/:id/verify-telegram', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: firstIssue(params.error) });
    return;
  }

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

  const token = projectBotToken(project);
  if (!token) {
    res.json({
      ok: false,
      bot: null,
      chat: null,
      canPost: false,
      problems: ['Для проєкту не задано токен бота.'],
    });
    return;
  }

  const check = await verifyTelegram(token, project.telegramChannelId);

  if (check.chat) {
    await cacheChannelUsername(project.id, check.chat.username);
  }

  logger.info(
    { projectId: project.id, ok: check.ok, canPost: check.canPost },
    'telegram verification',
  );
  res.json(check);
});

/** The channel's timeline: topics, buffer refills, generation steps, publications. */
projectsRouter.get('/projects/:id/log', async (req, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: firstIssue(params.error) });
    return;
  }

  const query = z
    .object({ scope: z.enum(['all', 'project']).default('project'), limit: z.coerce.number().int().min(1).max(500).default(100) })
    .safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: firstIssue(query.error) });
    return;
  }

  res.json(
    await projectLog(params.data.id, {
      limit: query.data.limit,
      onlyProjectWide: query.data.scope === 'project',
    }),
  );
});

/**
 * Publishes the project's nearest slot right now, creating one if the project
 * keeps no buffer. The single button behind "запустити зараз".
 */
projectsRouter.post('/projects/:id/publish-now', async (req, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: firstIssue(params.error) });
    return;
  }

  try {
    const result = await launchProject(params.data.id);
    logger.info({ projectId: params.data.id, ...result }, 'manual project launch');
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof NotLaunchableError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Некоректні дані';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
