import type { ModelInfo } from '@tcf/shared';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { logger } from '../logger.js';
import { providers } from './gemini.js';

/**
 * The list of models comes from the provider, never from a constant.
 *
 * This is not pedantry: the original PRD named `gemini-3.0-flash`, which does
 * not exist in the catalog at all — a hardcoded chain would have failed at the
 * first slot with an opaque 404.
 */

interface CacheEntry {
  models: ModelInfo[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export class NoUsableKeyError extends Error {}

export async function getModelCatalog(provider = 'gemini', force = false): Promise<ModelInfo[]> {
  const cached = cache.get(provider);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  const adapter = providers[provider];
  if (!adapter) throw new NoUsableKeyError(`Невідомий провайдер ${provider}`);

  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.enabled, true));

  const usable = keys.filter((k) => k.provider === provider);
  if (usable.length === 0) {
    throw new NoUsableKeyError('Немає жодного активного API-ключа — каталог моделей недоступний');
  }

  // Any enabled key can read the catalog; try them in turn so one revoked key
  // does not hide the list.
  let lastError: unknown;
  for (const key of usable) {
    try {
      const models = await adapter.listModels(decryptSecret(key.secretEnc));
      cache.set(provider, { models, fetchedAt: Date.now() });
      logger.info({ provider, count: models.length, keyId: key.id }, 'model catalog refreshed');
      return models;
    } catch (err) {
      lastError = err;
      logger.warn({ err, keyId: key.id }, 'model catalog fetch failed for key');
    }
  }

  if (cached) {
    logger.warn('serving stale model catalog: every key failed to refresh it');
    return cached.models;
  }
  throw lastError instanceof Error ? lastError : new Error('не вдалося отримати каталог моделей');
}

export function invalidateCatalog(provider = 'gemini'): void {
  cache.delete(provider);
}
