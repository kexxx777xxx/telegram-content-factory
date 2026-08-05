import { apiKeyInputSchema, apiKeyUpdateSchema } from '@tcf/shared';
import { Router } from 'express';
import { z } from 'zod';
import { getModelCatalog, invalidateCatalog, NoUsableKeyError } from '../../ai/catalog.js';
import { providers } from '../../ai/gemini.js';
import { logger } from '../../logger.js';
import {
  ApiKeyConflictError,
  ApiKeyNotFoundError,
  createApiKey,
  deleteApiKey,
  getApiKeySecret,
  listApiKeys,
  updateApiKey,
} from '../../services/apiKeys.js';
import { badRequest, firstIssue } from './helpers.js';

export const keysRouter: Router = Router();

const idParam = z.object({ id: z.string().uuid('Некоректний ідентифікатор ключа') });

keysRouter.get('/keys', async (_req, res) => {
  res.json(await listApiKeys());
});

keysRouter.post('/keys', async (req, res) => {
  const parsed = apiKeyInputSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  try {
    const id = await createApiKey(parsed.data);
    invalidateCatalog(parsed.data.provider);
    logger.info({ keyId: id, isDefault: parsed.data.isDefault }, 'api key created');
    res.status(201).json({ id });
  } catch (err) {
    if (err instanceof ApiKeyConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

keysRouter.patch('/keys/:id', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  const parsed = apiKeyUpdateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  try {
    await updateApiKey(params.data.id, parsed.data);
    invalidateCatalog();
    res.status(204).end();
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

keysRouter.delete('/keys/:id', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  try {
    await deleteApiKey(params.data.id);
    invalidateCatalog();
    res.status(204).end();
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Proves a key works by listing models with it. Cheap, read-only, and it
 * answers the only question that matters at setup time: will this key be
 * accepted when a slot needs it.
 */
keysRouter.post('/keys/:id/verify', async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) return badRequest(res, firstIssue(params.error));

  try {
    const { provider, secret } = await getApiKeySecret(params.data.id);
    const adapter = providers[provider];
    if (!adapter) return badRequest(res, `Невідомий провайдер ${provider}`);

    const models = await adapter.listModels(secret);
    res.json({ ok: true, modelCount: models.length, problems: [] });
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.json({
      ok: false,
      modelCount: 0,
      problems: [err instanceof Error ? err.message : 'Не вдалося перевірити ключ'],
    });
  }
});

keysRouter.get('/models', async (req, res) => {
  const force = req.query.refresh === 'true';
  try {
    res.json(await getModelCatalog('gemini', force));
  } catch (err) {
    if (err instanceof NoUsableKeyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});
