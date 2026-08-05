import type { AiProvider, KeyPreference } from '@tcf/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { decryptSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';

export interface ResolvedKey {
  id: string;
  label: string;
  scope: 'global' | 'project';
  secret: string;
  rpmLimit: number | null;
  dailyRequestBudget: number | null;
}

/**
 * Keys to spend for one chain step, in order.
 *
 * The project's own key goes first and the global one is the shared fallback —
 * which is exactly why the global key deserves the tightest `rpmLimit` and a
 * `dailyRequestBudget`: without them, one project's burst drains the safety net
 * for every other project.
 */
export async function resolveKeys(
  projectId: string | null,
  provider: AiProvider,
  preference: KeyPreference,
  pinnedKeyId?: string | null,
): Promise<ResolvedKey[]> {
  /*
   * A pinned key wins outright, with no fallback to the others.
   *
   * That is the point: pinning a paid key to image generation means images
   * must be paid for, not "paid for unless something else is cheaper". If the
   * pinned key is unavailable the step is skipped and the *next chain step*
   * decides — which is where an alternative belongs.
   */
  if (pinnedKeyId) {
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, pinnedKeyId), eq(apiKeys.enabled, true)))
      .limit(1);
    if (!row || row.provider !== provider) return [];
    return [toResolved(row, row.scope)];
  }

  const wantProject = preference !== 'global_only' && projectId !== null;
  const wantGlobal = preference !== 'project_only';

  const resolved: ResolvedKey[] = [];

  if (wantProject && projectId) {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.projectId, projectId),
          eq(apiKeys.provider, provider),
          eq(apiKeys.scope, 'project'),
          eq(apiKeys.enabled, true),
        ),
      );
    for (const row of rows) resolved.push(toResolved(row, 'project'));
  }

  if (wantGlobal) {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          isNull(apiKeys.projectId),
          eq(apiKeys.provider, provider),
          eq(apiKeys.scope, 'global'),
          eq(apiKeys.enabled, true),
        ),
      );
    for (const row of rows) resolved.push(toResolved(row, 'global'));
  }

  return resolved;
}

function toResolved(row: typeof apiKeys.$inferSelect, scope: 'global' | 'project'): ResolvedKey {
  return {
    id: row.id,
    label: row.label,
    scope,
    secret: decryptSecret(row.secretEnc),
    rpmLimit: row.rpmLimit,
    dailyRequestBudget: row.dailyRequestBudget,
  };
}

/** Any usable key at all — used by the UI to warn before the first slot fails. */
export async function hasUsableKey(projectId: string | null, provider: AiProvider): Promise<boolean> {
  const keys = await resolveKeys(projectId, provider, 'project_then_global');
  return keys.length > 0;
}
