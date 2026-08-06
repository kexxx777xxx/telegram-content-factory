import { gzipSync } from 'node:zlib';
import { config, env } from '../config.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  apiKeys,
  modelChains,
  modelChainSteps,
  posts,
  projects,
  prompts,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { adminApi } from '../telegram/adminApi.js';

/**
 * A JSON snapshot of everything that is not reproducible.
 *
 * Deliberately not `pg_dump`: that would add a client binary to the image and
 * couple it to the server's version, for a database that holds configuration
 * and metadata rather than content (ADR 0002). `pg_dump` stays the documented
 * restore path in the runbook; this is the copy that lands in Telegram
 * automatically.
 *
 * Secrets are exported in their encrypted form. The backup is therefore useless
 * without `APP_ENCRYPTION_KEY`, which is exactly the intended property — the
 * file travels through a chat.
 */
export interface BackupResult {
  filename: string;
  bytes: number;
  counts: Record<string, number>;
}

export async function createBackup(): Promise<{ data: Buffer; meta: BackupResult }> {
  const [projectRows, keyRows, promptRows, chainRows, stepRows, ideaRows] = await Promise.all([
    db.select().from(projects),
    db.select().from(apiKeys),
    db.select().from(prompts),
    db.select().from(modelChains),
    db.select().from(modelChainSteps),
    /*
     * Only the idea rows, not every post. A curated bank of subjects is work
     * that cannot be reproduced; a generated post can be, and published ones
     * live in Telegram (ADR 0002).
     */
    db
      .select({
        projectId: posts.projectId,
        topicTitle: posts.topicTitle,
        normalizedHash: posts.normalizedHash,
        category: posts.category,
        source: posts.source,
      })
      .from(posts)
      .where(eq(posts.status, 'idea')),
  ]);

  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    note: 'Секрети зашифровані; без APP_ENCRYPTION_KEY бекап марний.',
    projects: projectRows,
    apiKeys: keyRows,
    prompts: promptRows,
    modelChains: chainRows,
    modelChainSteps: stepRows,
    ideas: ideaRows,
  };

  const data = gzipSync(Buffer.from(JSON.stringify(snapshot, null, 1), 'utf8'));
  const filename = `tcf-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;

  return {
    data,
    meta: {
      filename,
      bytes: data.byteLength,
      counts: {
        projects: projectRows.length,
        apiKeys: keyRows.length,
        prompts: promptRows.length,
        chains: chainRows.length,
        ideas: ideaRows.length,
      },
    },
  };
}

/**
 * Ships the snapshot to the admin chat.
 *
 * Once a day rather than after every publication as the original PRD proposed:
 * at fifty projects that would be dozens of near-identical files daily, and the
 * database no longer grows with published content anyway.
 */
export async function sendBackup(): Promise<BackupResult | null> {
  if (!config.adminBotEnabled) {
    logger.info('backup skipped: admin bot not configured');
    return null;
  }

  const chatId = config.adminUserIds[0];
  if (!chatId) {
    logger.warn('backup skipped: ADMIN_USER_IDS is empty');
    return null;
  }

  const { data, meta } = await createBackup();
  const caption = [
    '🗄 Бекап конфігурації',
    'Секрети зашифровані — без APP_ENCRYPTION_KEY не відновити.',
  ].join('\n');

  await adminApi.sendDocument(env.ADMIN_BOT_TOKEN, chatId, meta.filename, data, caption);
  logger.info(meta, 'backup sent to admin chat');
  return meta;
}
