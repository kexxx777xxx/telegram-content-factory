import type { ApiKeyDto, ApiKeyInput, ApiKeyUpdate } from '@tcf/shared';
import { and, eq, sql } from 'drizzle-orm';
import { encryptSecret, maskStoredSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { apiKeys, apiKeyUsage, projects, rateLimitState } from '../db/schema.js';

export class ApiKeyConflictError extends Error {}
export class ApiKeyNotFoundError extends Error {}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listApiKeys(): Promise<ApiKeyDto[]> {
  const rows = await db
    .select({ key: apiKeys, projectName: projects.name })
    .from(apiKeys)
    .leftJoin(projects, eq(apiKeys.projectId, projects.id));

  const usage = await db
    .select({
      apiKeyId: apiKeyUsage.apiKeyId,
      requests: sql<number>`sum(${apiKeyUsage.requests})::int`,
      inputTokens: sql<number>`sum(${apiKeyUsage.inputTokens})::int`,
      outputTokens: sql<number>`sum(${apiKeyUsage.outputTokens})::int`,
    })
    .from(apiKeyUsage)
    .where(eq(apiKeyUsage.day, today()))
    .groupBy(apiKeyUsage.apiKeyId);

  const blocked = await db
    .select({
      apiKeyId: rateLimitState.apiKeyId,
      model: rateLimitState.model,
      blockedUntil: rateLimitState.blockedUntil,
    })
    .from(rateLimitState)
    .where(sql`${rateLimitState.blockedUntil} > now()`);

  const usageByKey = new Map(usage.map((u) => [u.apiKeyId, u]));

  return rows.map(({ key, projectName }) => ({
    id: key.id,
    provider: key.provider,
    label: key.label,
    secretMask: maskStoredSecret(key.secretEnc) ?? '···',
    scope: key.scope,
    projectId: key.projectId,
    projectName: projectName ?? null,
    enabled: key.enabled,
    rpmLimit: key.rpmLimit,
    dailyRequestBudget: key.dailyRequestBudget,
    usageToday: {
      requests: usageByKey.get(key.id)?.requests ?? 0,
      inputTokens: usageByKey.get(key.id)?.inputTokens ?? 0,
      outputTokens: usageByKey.get(key.id)?.outputTokens ?? 0,
    },
    blockedModels: blocked
      .filter((b) => b.apiKeyId === key.id && b.blockedUntil)
      .map((b) => ({ model: b.model, blockedUntil: b.blockedUntil!.toISOString() })),
    createdAt: key.createdAt.toISOString(),
  }));
}

export async function createApiKey(input: ApiKeyInput): Promise<string> {
  if (input.scope === 'project' && !input.projectId) {
    throw new ApiKeyConflictError('Для ключа з областю «проєкт» треба вказати проєкт');
  }
  if (input.scope === 'global' && input.projectId) {
    throw new ApiKeyConflictError('Глобальний ключ не належить проєкту');
  }

  // Mirrors api_keys_project_uniq: one key per project per provider, so the
  // chain runner never has to guess which of two project keys to prefer.
  if (input.scope === 'project' && input.projectId) {
    const [existing] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.projectId, input.projectId),
          eq(apiKeys.provider, input.provider),
          eq(apiKeys.scope, 'project'),
        ),
      )
      .limit(1);
    if (existing) throw new ApiKeyConflictError('У цього проєкту вже є ключ для цього провайдера');
  }

  const [row] = await db
    .insert(apiKeys)
    .values({
      provider: input.provider,
      label: input.label,
      secretEnc: encryptSecret(input.secret),
      scope: input.scope,
      projectId: input.projectId,
      enabled: input.enabled,
      rpmLimit: input.rpmLimit,
      dailyRequestBudget: input.dailyRequestBudget,
    })
    .returning({ id: apiKeys.id });

  if (!row) throw new Error('api key insert returned no row');
  return row.id;
}

export async function updateApiKey(id: string, patch: ApiKeyUpdate): Promise<void> {
  const values: Partial<typeof apiKeys.$inferInsert> = { updatedAt: new Date() };

  if (patch.label !== undefined) values.label = patch.label;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.rpmLimit !== undefined) values.rpmLimit = patch.rpmLimit;
  if (patch.dailyRequestBudget !== undefined) values.dailyRequestBudget = patch.dailyRequestBudget;
  // Empty string means "keep the stored secret" — same contract as bot tokens.
  if (patch.secret) values.secretEnc = encryptSecret(patch.secret);

  const [row] = await db.update(apiKeys).set(values).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id });
  if (!row) throw new ApiKeyNotFoundError('Ключ не знайдено');
}

export async function deleteApiKey(id: string): Promise<void> {
  const [row] = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id });
  if (!row) throw new ApiKeyNotFoundError('Ключ не знайдено');
}

export async function getApiKeySecret(id: string): Promise<{ provider: 'gemini'; secret: string }> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  if (!row) throw new ApiKeyNotFoundError('Ключ не знайдено');
  const { decryptSecret } = await import('../crypto/secrets.js');
  return { provider: row.provider, secret: decryptSecret(row.secretEnc) };
}
