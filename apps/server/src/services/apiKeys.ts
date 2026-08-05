import type { ApiKeyDto, ApiKeyInput, ApiKeyUpdate } from '@tcf/shared';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { encryptSecret, maskStoredSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { apiKeys, apiKeyUsage, rateLimitState } from '../db/schema.js';

export class ApiKeyConflictError extends Error {}
export class ApiKeyNotFoundError extends Error {}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listApiKeys(): Promise<ApiKeyDto[]> {
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.isDefault), asc(apiKeys.createdAt));

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

  return rows.map((key) => ({
    id: key.id,
    provider: key.provider,
    label: key.label,
    secretMask: maskStoredSecret(key.secretEnc) ?? '···',
    isDefault: key.isDefault,
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
  return db.transaction(async (tx) => {
    // api_keys_default_uniq allows one default per provider, so the previous
    // one is demoted rather than letting the insert fail: marking a key default
    // is an unambiguous instruction, not a request to resolve a conflict.
    if (input.isDefault) await clearDefault(tx, input.provider, null);

    const [row] = await tx
      .insert(apiKeys)
      .values({
        provider: input.provider,
        label: input.label,
        secretEnc: encryptSecret(input.secret),
        isDefault: input.isDefault,
        enabled: input.enabled,
        rpmLimit: input.rpmLimit,
        dailyRequestBudget: input.dailyRequestBudget,
      })
      .returning({ id: apiKeys.id });

    if (!row) throw new Error('api key insert returned no row');
    return row.id;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function clearDefault(tx: Tx, provider: 'gemini', keepId: string | null): Promise<void> {
  await tx
    .update(apiKeys)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(apiKeys.provider, provider),
        eq(apiKeys.isDefault, true),
        ...(keepId ? [ne(apiKeys.id, keepId)] : []),
      ),
    );
}

export async function updateApiKey(id: string, patch: ApiKeyUpdate): Promise<void> {
  const values: Partial<typeof apiKeys.$inferInsert> = { updatedAt: new Date() };

  if (patch.label !== undefined) values.label = patch.label;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.isDefault !== undefined) values.isDefault = patch.isDefault;
  if (patch.rpmLimit !== undefined) values.rpmLimit = patch.rpmLimit;
  if (patch.dailyRequestBudget !== undefined) values.dailyRequestBudget = patch.dailyRequestBudget;
  // Empty string means "keep the stored secret" — same contract as bot tokens.
  if (patch.secret) values.secretEnc = encryptSecret(patch.secret);

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    if (!current) throw new ApiKeyNotFoundError('Ключ не знайдено');

    if (patch.isDefault) await clearDefault(tx, current.provider, id);

    await tx.update(apiKeys).set(values).where(eq(apiKeys.id, id));
  });
}

export async function deleteApiKey(id: string): Promise<void> {
  const [row] = await db
    .delete(apiKeys)
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id, isDefault: apiKeys.isDefault, provider: apiKeys.provider });
  if (!row) throw new ApiKeyNotFoundError('Ключ не знайдено');

  // Projects and chains pointing at it fall back by ON DELETE SET NULL, but if
  // the default itself is gone nothing generates at all — promote the oldest
  // remaining key rather than leaving the system silently keyless.
  if (row.isDefault) {
    const [next] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.provider, row.provider), eq(apiKeys.enabled, true)))
      .orderBy(asc(apiKeys.createdAt))
      .limit(1);
    if (next) await db.update(apiKeys).set({ isDefault: true }).where(eq(apiKeys.id, next.id));
  }
}

export async function getApiKeySecret(id: string): Promise<{ provider: 'gemini'; secret: string }> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  if (!row) throw new ApiKeyNotFoundError('Ключ не знайдено');
  const { decryptSecret } = await import('../crypto/secrets.js');
  return { provider: row.provider, secret: decryptSecret(row.secretEnc) };
}
