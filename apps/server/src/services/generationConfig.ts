import { AI_ACTIONS, type ActionConfig, type AiAction, type ChainStepInput } from '@tcf/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { clearChainOverride, resolveChain, saveChain } from '../ai/chains.js';
import { describeKey } from '../ai/keys.js';
import { db } from '../db/client.js';
import { modelChains, prompts } from '../db/schema.js';
import { clearPromptOverride, resolvePrompt, savePromptVersion } from '../prompts/resolve.js';

/**
 * Assembles the effective configuration for every action plus provenance flags.
 *
 * The flags are the whole point of the UI contract: an operator must be able to
 * see at a glance that a project inherits the global setup, and overriding must
 * be an explicit act rather than a side effect of opening a form.
 */
export async function getGenerationConfig(projectId: string | null): Promise<ActionConfig[]> {
  const configs: ActionConfig[] = [];

  for (const action of AI_ACTIONS) {
    const ownChain = projectId
      ? await db
          .select({ id: modelChains.id })
          .from(modelChains)
          .where(and(eq(modelChains.action, action), eq(modelChains.projectId, projectId)))
          .limit(1)
      : [];

    // For the global view there is nothing above to inherit from.
    const chain = projectId
      ? await resolveChain(action, projectId)
      : await globalChain(action);

    const ownPrompt = projectId
      ? await db
          .select({ id: prompts.id })
          .from(prompts)
          .where(
            and(
              eq(prompts.action, action),
              eq(prompts.scope, 'project'),
              eq(prompts.projectId, projectId),
              eq(prompts.isActive, true),
            ),
          )
          .limit(1)
      : [];

    const prompt = await resolvePrompt(action, projectId, null);
    const key = await describeKey(projectId, action);

    configs.push({
      action,
      steps: (chain?.steps ?? []).map((step) => ({
        provider: step.provider,
        model: step.model,
        params: step.params,
        promptId: step.promptId,
      })),
      apiKeyId: chain?.apiKeyId ?? null,
      keyLevel: key.level,
      keyLabel: key.label,
      chainInherited: projectId !== null && ownChain.length === 0,
      prompt: { body: prompt.body, version: prompt.version, scope: prompt.scope },
      promptInherited: projectId !== null && ownPrompt.length === 0,
    });
  }

  return configs;
}

async function globalChain(action: AiAction) {
  const [chain] = await db
    .select()
    .from(modelChains)
    .where(and(eq(modelChains.action, action), isNull(modelChains.projectId)))
    .limit(1);
  if (!chain) return null;
  // resolveChain needs a project; for the global view load through the same
  // path by asking for the chain we just found.
  return resolveChainById(chain, action);
}

async function resolveChainById(chain: typeof modelChains.$inferSelect, action: AiAction) {
  const chainId = chain.id;
  const { modelChainSteps } = await import('../db/schema.js');
  const steps = await db
    .select()
    .from(modelChainSteps)
    .where(eq(modelChainSteps.chainId, chainId));

  return {
    id: chainId,
    projectId: null,
    action,
    enabled: true,
    apiKeyId: chain.apiKeyId,
    steps: steps
      .sort((a, b) => a.position - b.position)
      .map((step) => ({
        id: step.id,
        position: step.position,
        provider: step.provider,
        model: step.model,
        params: (step.params ?? {}) as ChainStepInput['params'],
        promptId: step.promptId,
      })),
  };
}

export async function saveActionConfig(
  action: AiAction,
  projectId: string | null,
  input: { steps?: ChainStepInput[]; promptBody?: string; apiKeyId?: string | null },
): Promise<void> {
  if (input.steps) {
    await saveChain(
      action,
      projectId,
      input.steps.map((step) => ({
        provider: step.provider,
        model: step.model,
        params: step.params,
        promptId: step.promptId,
      })),
    );
  }

  // Pinning a key creates the project's own chain row if it had none, because
  // the key lives on the chain — inheriting the chain and overriding only the
  // key would otherwise have nowhere to be stored.
  if (input.apiKeyId !== undefined) {
    await setChainKey(action, projectId, input.apiKeyId);
  }

  if (input.promptBody !== undefined) {
    await savePromptVersion({
      action,
      scope: projectId ? 'project' : 'global',
      projectId,
      model: null,
      body: input.promptBody,
    });
  }
}

/** Reverts a project to the global setup for one action. */
export async function clearActionOverrides(
  action: AiAction,
  projectId: string,
  what: { chain?: boolean; prompt?: boolean },
): Promise<void> {
  if (what.chain) await clearChainOverride(action, projectId);
  if (what.prompt) await clearPromptOverride(action, 'project', projectId, null);
}

async function setChainKey(
  action: AiAction,
  projectId: string | null,
  apiKeyId: string | null,
): Promise<void> {
  const where = and(
    eq(modelChains.action, action),
    projectId ? eq(modelChains.projectId, projectId) : isNull(modelChains.projectId),
  );

  const [existing] = await db.select({ id: modelChains.id }).from(modelChains).where(where).limit(1);

  if (existing) {
    await db
      .update(modelChains)
      .set({ apiKeyId, updatedAt: new Date() })
      .where(eq(modelChains.id, existing.id));
    return;
  }

  const inherited = projectId ? await resolveChain(action, projectId) : null;
  await saveChain(
    action,
    projectId,
    (inherited?.steps ?? []).map((step) => ({
      provider: step.provider,
      model: step.model,
      params: step.params,
      promptId: step.promptId,
    })),
  );
  await db.update(modelChains).set({ apiKeyId }).where(where);
}
