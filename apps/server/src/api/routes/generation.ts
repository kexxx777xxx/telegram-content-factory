import { AI_ACTIONS, dryRunInputSchema, saveActionConfigSchema, type AiAction } from '@tcf/shared';
import { Router } from 'express';
import { z } from 'zod';
import { ChainExhaustedError, ChainMissingError, runChain } from '../../ai/chain.js';
import { logger } from '../../logger.js';
import { renderPrompt, resolvePrompt } from '../../prompts/resolve.js';
import { projectVariables } from '../../prompts/variables.js';
import {
  clearActionOverrides,
  getGenerationConfig,
  saveActionConfig,
} from '../../services/generationConfig.js';
import { getProject, ProjectNotFoundError } from '../../services/projects.js';
import { badRequest, firstIssue } from './helpers.js';

export const generationRouter: Router = Router();

const scopeQuery = z.object({ projectId: z.string().uuid().optional() });
const actionParam = z.object({ action: z.enum(AI_ACTIONS) });

generationRouter.get('/config/generation', async (req, res) => {
  const query = scopeQuery.safeParse(req.query);
  if (!query.success) return badRequest(res, firstIssue(query.error));

  res.json(await getGenerationConfig(query.data.projectId ?? null));
});

generationRouter.put('/config/generation/:action', async (req, res) => {
  const params = actionParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const query = scopeQuery.safeParse(req.query);
  if (!query.success) return badRequest(res, firstIssue(query.error));

  const parsed = saveActionConfigSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  if (
    parsed.data.steps === undefined &&
    parsed.data.promptBody === undefined &&
    parsed.data.apiKeyId === undefined
  ) {
    return badRequest(res, 'Нічого зберігати: передайте steps, promptBody або apiKeyId');
  }

  await saveActionConfig(params.data.action, query.data.projectId ?? null, parsed.data);
  logger.info(
    { action: params.data.action, projectId: query.data.projectId ?? null },
    'generation config saved',
  );
  res.json(await getGenerationConfig(query.data.projectId ?? null));
});

/** Drops a project override so the global configuration applies again. */
generationRouter.delete('/config/generation/:action', async (req, res) => {
  const params = actionParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const query = z
    .object({
      projectId: z.string().uuid(),
      chain: z.enum(['true', 'false']).optional(),
      prompt: z.enum(['true', 'false']).optional(),
    })
    .safeParse(req.query);
  if (!query.success) return badRequest(res, firstIssue(query.error));

  await clearActionOverrides(params.data.action, query.data.projectId, {
    chain: query.data.chain !== 'false',
    prompt: query.data.prompt !== 'false',
  });
  res.json(await getGenerationConfig(query.data.projectId));
});

/**
 * Runs one action for real, without storing or publishing anything.
 *
 * It returns the full attempt trail, not just the text: when a chain is
 * misconfigured the useful answer is *which step answered and why the earlier
 * ones did not*, and that is invisible from the output alone.
 */
generationRouter.post('/projects/:id/dry-run', async (req, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = dryRunInputSchema.safeParse(req.body);
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

  // The same base every real call gets, so a dry run exercises the prompt an
  // operator will actually ship — not a reduced version of it.
  const variables = {
    ...(await projectVariables(project)),
    ...sampleVariables(parsed.data.action),
    ...parsed.data.variables,
  };

  const prompt = await resolvePrompt(parsed.data.action, project.id, null);
  const renderedPrompt = renderPrompt(prompt.body, variables);

  try {
    // The configured chain, exactly as generation would run it.
    const result = await runChain({
      action: parsed.data.action,
      projectId: project.id,
      variables,
    });

    res.json({
      ok: true,
      text: result.text,
      model: result.model,
      promptScope: prompt.scope,
      promptVersion: result.promptVersion,
      usage: result.usage,
      attempts: result.attempts,
      error: null,
      renderedPrompt,
    });
  } catch (err) {
    if (err instanceof ChainMissingError) {
      res.json({
        ok: false,
        text: null,
        model: null,
        promptScope: prompt.scope,
        promptVersion: prompt.version,
        usage: null,
        attempts: [],
        error: err.message,
        renderedPrompt,
      });
      return;
    }
    if (err instanceof ChainExhaustedError) {
      res.json({
        ok: false,
        text: null,
        model: null,
        promptScope: prompt.scope,
        promptVersion: prompt.version,
        usage: null,
        attempts: err.attempts,
        error: err.retryAt
          ? `${err.message}. Найраніша спроба: ${err.retryAt.toISOString()}`
          : err.message,
        renderedPrompt,
      });
      return;
    }
    throw err;
  }
});

/**
 * Stand-ins for the values a real run would carry from the pipeline.
 *
 * Only the action-specific ones: everything that describes the channel comes
 * from the project itself, because a test run that invented a persona would be
 * testing a prompt nobody ships.
 */
function sampleVariables(action: AiAction): Record<string, string> {
  const topic = 'Ідемпотентність у чергах повідомлень';

  switch (action) {
    case 'topics':
      return { count: '5', existingTopics: '(банк порожній)' };
    case 'post_text':
    case 'svg':
      return { topic };
    case 'svg_repair':
      return { topic, error: 'Кореневий елемент не <svg>', svgSource: '<div>not an svg</div>' };
    case 'image_prompt':
      return {
        topic,
        postText: 'Коротка нотатка про те, чому повторна доставка повідомлень неминуча.',
      };
    case 'image':
      return {};
  }
}
