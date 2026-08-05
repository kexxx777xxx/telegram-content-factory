import { AI_ACTIONS, type AiAction } from '@tcf/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { modelChains, modelChainSteps } from '../db/schema.js';
import { logger } from '../logger.js';

export interface ChainStep {
  id: string;
  position: number;
  provider: 'gemini';
  model: string;
  params: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
  promptId: string | null;
}

export interface ResolvedChain {
  id: string;
  /** null = the global default chain is in use, the project has no override. */
  projectId: string | null;
  action: AiAction;
  enabled: boolean;
  /** Key for this action; null means inherit from project, then default. */
  apiKeyId: string | null;
  steps: ChainStep[];
}

/**
 * Starting points, not hardcoded truth: the catalog endpoint reads the real
 * list from the provider, and any of these can be replaced in the UI.
 */
const DEFAULT_TEXT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'] as const;

/**
 * SVG leads with the lite model on purpose, and it is a measurement rather than
 * a preference: a schematic runs to ~4000 output tokens, which the larger
 * models do not finish inside the 60-second budget, while the lite one returns
 * in about eleven seconds. Ordering them the usual way made every illustration
 * burn a full timeout before producing anything.
 */
const DEFAULT_SVG_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite'] as const;

const DEFAULT_IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image'] as const;

function defaultModelsFor(action: AiAction): readonly string[] {
  if (action === 'image') return DEFAULT_IMAGE_MODELS;
  if (action === 'svg' || action === 'svg_repair') return DEFAULT_SVG_MODELS;
  return DEFAULT_TEXT_MODELS;
}

export async function resolveChain(action: AiAction, projectId: string): Promise<ResolvedChain | null> {
  const own = await loadChain(and(eq(modelChains.action, action), eq(modelChains.projectId, projectId)));
  if (own?.enabled && own.steps.length > 0) return own;

  const global = await loadChain(and(eq(modelChains.action, action), isNull(modelChains.projectId)));
  if (global?.enabled && global.steps.length > 0) return global;

  return null;
}

async function loadChain(where: ReturnType<typeof and>): Promise<ResolvedChain | null> {
  const [chain] = await db.select().from(modelChains).where(where).limit(1);
  if (!chain) return null;

  const steps = await db
    .select()
    .from(modelChainSteps)
    .where(eq(modelChainSteps.chainId, chain.id))
    .orderBy(asc(modelChainSteps.position));

  return {
    id: chain.id,
    projectId: chain.projectId,
    action: chain.action,
    enabled: chain.enabled,
    apiKeyId: chain.apiKeyId,
    steps: steps.map((step) => ({
      id: step.id,
      position: step.position,
      provider: step.provider,
      model: step.model,
      params: (step.params ?? {}) as ChainStep['params'],
      promptId: step.promptId,
    })),
  };
}

/** Seeds one global chain per action if none exists. Never touches existing rows. */
export async function ensureDefaultChains(): Promise<void> {
  for (const action of AI_ACTIONS) {
    const [existing] = await db
      .select({ id: modelChains.id })
      .from(modelChains)
      .where(and(eq(modelChains.action, action), isNull(modelChains.projectId)))
      .limit(1);
    if (existing) continue;

    const [chain] = await db
      .insert(modelChains)
      .values({ projectId: null, action, enabled: true })
      .returning();
    if (!chain) continue;

    await db.insert(modelChainSteps).values(
      defaultModelsFor(action).map((model, index) => ({
        chainId: chain.id,
        position: index,
        provider: 'gemini' as const,
        model,
        params: {},
        promptId: null,
      })),
    );

    logger.info({ action, models: defaultModelsFor(action) }, 'seeded default global chain');
  }
}

/** Replaces a chain's steps wholesale — the editor always submits the full order. */
export async function saveChain(
  action: AiAction,
  projectId: string | null,
  steps: Omit<ChainStep, 'id' | 'position'>[],
  enabled = true,
): Promise<ResolvedChain> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(modelChains)
      .where(
        and(
          eq(modelChains.action, action),
          projectId ? eq(modelChains.projectId, projectId) : isNull(modelChains.projectId),
        ),
      )
      .limit(1);

    const chainId =
      existing?.id ??
      (
        await tx.insert(modelChains).values({ projectId, action, enabled }).returning()
      )[0]?.id;

    if (!chainId) throw new Error('chain upsert returned no row');

    if (existing) {
      await tx
        .update(modelChains)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(modelChains.id, chainId));
      await tx.delete(modelChainSteps).where(eq(modelChainSteps.chainId, chainId));
    }

    if (steps.length > 0) {
      await tx.insert(modelChainSteps).values(
        steps.map((step, index) => ({
          chainId,
          position: index,
          provider: step.provider,
          model: step.model,
          params: step.params,
          promptId: step.promptId,
        })),
      );
    }

    const saved = await loadChainTx(tx, chainId);
    if (!saved) throw new Error('chain vanished after save');
    return saved;
  });
}

async function loadChainTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  chainId: string,
): Promise<ResolvedChain | null> {
  const [chain] = await tx.select().from(modelChains).where(eq(modelChains.id, chainId)).limit(1);
  if (!chain) return null;

  const steps = await tx
    .select()
    .from(modelChainSteps)
    .where(eq(modelChainSteps.chainId, chainId))
    .orderBy(asc(modelChainSteps.position));

  return {
    id: chain.id,
    projectId: chain.projectId,
    action: chain.action,
    enabled: chain.enabled,
    apiKeyId: chain.apiKeyId,
    steps: steps.map((step) => ({
      id: step.id,
      position: step.position,
      provider: step.provider,
      model: step.model,
      params: (step.params ?? {}) as ChainStep['params'],
      promptId: step.promptId,
    })),
  };
}

/** Removes a project override so the global chain applies again. */
export async function clearChainOverride(action: AiAction, projectId: string): Promise<void> {
  await db
    .delete(modelChains)
    .where(and(eq(modelChains.action, action), eq(modelChains.projectId, projectId)));
}
