import type { AiAction, PromptScope } from '@tcf/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { prompts } from '../db/schema.js';
import { logger } from '../logger.js';
import { DEFAULT_PROMPTS } from './defaults.js';

export interface ResolvedPrompt {
  id: string;
  version: number;
  scope: PromptScope;
  body: string;
}

/**
 * Resolution order, most specific first:
 *
 *   1. the chain step's own override      (this model, this step, nothing else)
 *   2. scope='model'   for this project   (a lite model that needs simpler wording)
 *   3. scope='project'                    (the channel's own voice)
 *   4. scope='global'                     (the shipped default)
 *
 * This is what makes "a prompt per model" affordable: most projects override
 * nothing, and a special case attaches to exactly the step that needs it rather
 * than forking the whole configuration.
 */
export async function resolvePrompt(
  action: AiAction,
  projectId: string | null,
  model: string | null,
  overrideId?: string | null,
): Promise<ResolvedPrompt> {
  if (overrideId) {
    const [row] = await db.select().from(prompts).where(eq(prompts.id, overrideId)).limit(1);
    if (row) return { id: row.id, version: row.version, scope: row.scope, body: row.body };
    logger.warn({ overrideId, action }, 'prompt override missing, falling back');
  }

  if (projectId && model) {
    const found = await latest(
      and(
        eq(prompts.action, action),
        eq(prompts.scope, 'model'),
        eq(prompts.projectId, projectId),
        eq(prompts.model, model),
        eq(prompts.isActive, true),
      ),
    );
    if (found) return found;
  }

  if (projectId) {
    const found = await latest(
      and(
        eq(prompts.action, action),
        eq(prompts.scope, 'project'),
        eq(prompts.projectId, projectId),
        eq(prompts.isActive, true),
      ),
    );
    if (found) return found;
  }

  const global = await latest(
    and(eq(prompts.action, action), eq(prompts.scope, 'global'), eq(prompts.isActive, true)),
  );
  if (global) return global;

  // Only reachable if seeding was skipped; better a working default than a
  // failed slot, but it is worth a loud line in the log.
  logger.error({ action }, 'no global prompt in database, using compiled-in default');
  return { id: 'builtin', version: 0, scope: 'global', body: DEFAULT_PROMPTS[action] };
}

async function latest(where: ReturnType<typeof and>): Promise<ResolvedPrompt | null> {
  const [row] = await db
    .select()
    .from(prompts)
    .where(where)
    .orderBy(desc(prompts.version))
    .limit(1);
  return row ? { id: row.id, version: row.version, scope: row.scope, body: row.body } : null;
}

/**
 * Inserts the shipped defaults once. Idempotent: an existing global prompt for
 * an action is never overwritten, so a operator's edits survive restarts.
 */
export async function ensureDefaultPrompts(): Promise<void> {
  for (const [action, body] of Object.entries(DEFAULT_PROMPTS)) {
    const [existing] = await db
      .select({ id: prompts.id })
      .from(prompts)
      .where(
        and(
          eq(prompts.action, action as AiAction),
          eq(prompts.scope, 'global'),
          isNull(prompts.projectId),
        ),
      )
      .limit(1);

    if (existing) continue;

    await db.insert(prompts).values({
      action: action as AiAction,
      scope: 'global',
      projectId: null,
      model: null,
      version: 1,
      body,
      isActive: true,
    });
    logger.info({ action }, 'seeded default global prompt');
  }
}

/**
 * Editing never mutates a row: published posts reference the exact version that
 * produced them, and that reference is the only way to explain a quality drop
 * after the fact (see docs/adr/0002 — the text itself is gone by then).
 */
export async function savePromptVersion(input: {
  action: AiAction;
  scope: PromptScope;
  projectId: string | null;
  model: string | null;
  body: string;
}): Promise<ResolvedPrompt> {
  const conditions = [
    eq(prompts.action, input.action),
    eq(prompts.scope, input.scope),
    input.projectId ? eq(prompts.projectId, input.projectId) : isNull(prompts.projectId),
    input.model ? eq(prompts.model, input.model) : isNull(prompts.model),
  ];

  const [current] = await db
    .select({ version: prompts.version })
    .from(prompts)
    .where(and(...conditions))
    .orderBy(desc(prompts.version))
    .limit(1);

  const [row] = await db
    .insert(prompts)
    .values({
      action: input.action,
      scope: input.scope,
      projectId: input.projectId,
      model: input.model,
      version: (current?.version ?? 0) + 1,
      body: input.body,
      isActive: true,
    })
    .returning();

  if (!row) throw new Error('prompt insert returned no row');
  return { id: row.id, version: row.version, scope: row.scope, body: row.body };
}

/** Drops an override so the level below takes over again. */
export async function clearPromptOverride(
  action: AiAction,
  scope: Exclude<PromptScope, 'global'>,
  projectId: string,
  model: string | null,
): Promise<void> {
  await db
    .update(prompts)
    .set({ isActive: false })
    .where(
      and(
        eq(prompts.action, action),
        eq(prompts.scope, scope),
        eq(prompts.projectId, projectId),
        model ? eq(prompts.model, model) : isNull(prompts.model),
      ),
    );
}

/** Fills {{placeholders}}; unknown keys collapse to empty rather than leaking braces. */
export function renderPrompt(body: string, vars: Record<string, string | number | undefined>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
}
