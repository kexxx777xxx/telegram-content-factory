import { appSettingsSchema } from '@tcf/shared';
import { Router } from 'express';
import { logger } from '../../logger.js';
import { getSettingsDto, saveSettings } from '../../services/settings.js';
import { badRequest, firstIssue } from './helpers.js';

export const settingsRouter: Router = Router();

settingsRouter.get('/settings', async (_req, res) => {
  res.json(await getSettingsDto());
});

settingsRouter.put('/settings', async (req, res) => {
  const parsed = appSettingsSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, firstIssue(parsed.error));

  const saved = await saveSettings(parsed.data);
  logger.info('global settings saved');
  res.json(saved);
});
