import type { AiAction, AiProvider, KeyLevel } from '@tcf/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { decryptSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { apiKeys, modelChains, projects } from '../db/schema.js';

export interface ResolvedKey {
  id: string;
  label: string;
  /** Which level supplied it — shown in the UI and in the attempt trail. */
  level: KeyLevel;
  secret: string;
  /** Whether this key may queue work on the batch tier. */
  batchEnabled: boolean;
  rpmLimit: number | null;
  dailyRequestBudget: number | null;
}

/**
 * Which key pays for this call.
 *
 *   action key  →  project key  →  default key
 *
 * One key, no list. There is deliberately no fall-through *between* keys: if
 * images are set to the paid key, they are paid for — a silent hop to the free
 * one would make the setting a suggestion rather than a decision. When the
 * chosen key is exhausted the chain moves to the next **model**, and that is
 * where an alternative belongs.
 */
export async function resolveKey(
  projectId: string | null,
  provider: AiProvider,
  action?: AiAction,
): Promise<ResolvedKey | null> {
  if (projectId && action) {
    const [chain] = await db
      .select({ apiKeyId: modelChains.apiKeyId })
      .from(modelChains)
      .where(and(eq(modelChains.action, action), eq(modelChains.projectId, projectId)))
      .limit(1);
    const fromAction = await load(chain?.apiKeyId ?? null, provider, 'action');
    if (fromAction) return fromAction;
  }

  // The global chain can carry a key too, so an action can be pinned once for
  // every project rather than repeated in each of them.
  if (action) {
    const [globalChain] = await db
      .select({ apiKeyId: modelChains.apiKeyId })
      .from(modelChains)
      .where(and(eq(modelChains.action, action), isNull(modelChains.projectId)))
      .limit(1);
    const fromGlobalAction = await load(globalChain?.apiKeyId ?? null, provider, 'action');
    if (fromGlobalAction) return fromGlobalAction;
  }

  if (projectId) {
    const [project] = await db
      .select({ apiKeyId: projects.apiKeyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const fromProject = await load(project?.apiKeyId ?? null, provider, 'project');
    if (fromProject) return fromProject;
  }

  const [fallback] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.provider, provider), eq(apiKeys.isDefault, true), eq(apiKeys.enabled, true)))
    .limit(1);

  return fallback ? toResolved(fallback, 'default') : null;
}

/** Returns null for a missing, disabled or wrong-provider key, so the next level applies. */
async function load(
  keyId: string | null,
  provider: AiProvider,
  level: KeyLevel,
): Promise<ResolvedKey | null> {
  if (!keyId) return null;
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.enabled, true)))
    .limit(1);
  return row && row.provider === provider ? toResolved(row, level) : null;
}

function toResolved(row: typeof apiKeys.$inferSelect, level: KeyLevel): ResolvedKey {
  return {
    id: row.id,
    label: row.label,
    level,
    secret: decryptSecret(row.secretEnc),
    batchEnabled: row.batchEnabled,
    rpmLimit: row.rpmLimit,
    dailyRequestBudget: row.dailyRequestBudget,
  };
}

/** What the settings screen shows next to each action. */
export async function describeKey(
  projectId: string | null,
  action: AiAction,
): Promise<{ level: KeyLevel; label: string | null; id: string | null }> {
  const key = await resolveKey(projectId, 'gemini', action);
  return key
    ? { level: key.level, label: key.label, id: key.id }
    : { level: 'default', label: null, id: null };
}

export async function hasAnyKey(provider: AiProvider = 'gemini'): Promise<boolean> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.provider, provider), eq(apiKeys.enabled, true)))
    .limit(1);
  return Boolean(row);
}
