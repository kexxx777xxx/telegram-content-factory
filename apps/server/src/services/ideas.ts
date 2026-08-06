import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { runChain } from '../ai/chain.js';
import { db } from '../db/client.js';
import { posts, type Post, type Project } from '../db/schema.js';
import { logger } from '../logger.js';
import { collectBatch, dropBatch, findProjectBatch, submitBatch } from '../ai/batch.js';
import { projectVariables } from '../prompts/variables.js';
import { record } from './activityLog.js';

/**
 * Ideas: posts that have a subject and nothing else yet.
 *
 * There is no separate table. An idea is a `posts` row with `status = 'idea'`
 * and no `scheduled_at`, and it becomes a scheduled post by gaining a slot —
 * the same row throughout. What used to be «the topic bank» is just the set of
 * rows still in that state, and what used to be «claiming a topic» is a row
 * changing status rather than one row pointing at another.
 */

export class IdeaNotFoundError extends Error {}

/**
 * Words that carry no distinguishing meaning in a topic title. Dropping them
 * lets "Патерн Circuit Breaker" and "Circuit Breaker" collapse to the same key.
 */
const STOPWORDS = new Set([
  // ukrainian
  'та', 'і', 'й', 'в', 'у', 'на', 'для', 'з', 'із', 'зі', 'до', 'про', 'як', 'що', 'це',
  'чи', 'але', 'бо', 'щоб', 'від', 'за', 'при', 'по', 'над', 'під', 'без', 'через',
  'патерн', 'патерни', 'підхід', 'огляд', 'вступ', 'основи',
  // english
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with', 'is', 'are',
  'pattern', 'patterns', 'intro', 'introduction', 'overview', 'basics', 'guide',
]);

/**
 * Ukrainian inflection endings, longest first so "мікросервісах" loses "ах"
 * rather than just "х".
 *
 * Declension is the dominant duplicate form in Ukrainian: without this,
 * "у мікросервісах" and "мікросервіси" are different keys and the dedup is far
 * weaker than it looks. Crude on purpose — over-stemming two genuinely
 * different topics into one key costs a skipped topic, while under-stemming
 * costs a duplicate post, and the former is the cheaper mistake.
 */
const UA_ENDINGS = [
  'ами', 'ями', 'ах', 'ях', 'ів', 'ов', 'ам', 'ям', 'ою', 'ею', 'ий', 'ій', 'их', 'іх',
  'ими', 'ими', 'ого', 'ому', 'ної', 'ний', 'на', 'не', 'ні',
  'а', 'я', 'у', 'ю', 'и', 'і', 'е', 'о',
].sort((a, b) => b.length - a.length);

const CYRILLIC_ONLY = /^[Ѐ-ӿ]+$/;

function stem(token: string): string {
  if (token.length <= 5 || !CYRILLIC_ONLY.test(token)) return token;
  for (const ending of UA_ENDINGS) {
    if (token.endsWith(ending) && token.length - ending.length >= 4) {
      return token.slice(0, -ending.length);
    }
  }
  return token;
}

/**
 * Builds the dedup key: lowercase, strip accents and punctuation, drop
 * stopwords, stem Ukrainian tokens, sort what is left.
 *
 * Sorting is what makes it word-order independent — the model happily produces
 * "Circuit Breaker у мікросервісах" and "Мікросервіси та Circuit Breaker" as if
 * they were different topics.
 *
 * Deliberately lexical. It does not catch synonyms or rephrasings; that job is
 * delegated to the prompt, which receives the existing titles and is asked to
 * avoid them. Claiming otherwise would be overselling a string comparison.
 */
export function normalizeTopic(title: string): string {
  const tokens = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);

  const unique = [...new Set(tokens)].sort();
  // Everything was a stopword: fall back to the raw squashed title rather than
  // producing an empty key that would collide with every other such title.
  return unique.length > 0 ? unique.join('-') : title.toLowerCase().replace(/\s+/g, '-');
}

export interface IdeaCounts {
  /** Still without a slot. This — not the total — is what the threshold compares against. */
  fresh: number;
  /** Given a slot and on their way; spoken for, not available. */
  scheduled: number;
  published: number;
  total: number;
}

export async function ideaCounts(projectId: string): Promise<IdeaCounts> {
  const rows = await db
    .select({ status: posts.status, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(eq(posts.projectId, projectId))
    .groupBy(posts.status);

  const by = (status: string) => rows.find((r) => r.status === status)?.count ?? 0;
  const fresh = by('idea');
  const published = by('published');
  const scheduled =
    by('planned') + by('generating') + by('ready') + by('awaiting_approval') + by('publishing');
  return { fresh, scheduled, published, total: rows.reduce((n, r) => n + r.count, 0) };
}

/**
 * Whether the bank has dropped below the project's threshold.
 *
 * Counts only rows still in `idea`: one that already has a slot is spoken for,
 * so treating it as stock would let the bank run dry while every remaining row
 * is committed. `topicsBufferMin = 0` disables the bank entirely — a subject is
 * then generated per post instead.
 */
export async function needsReplenish(projectId: string, topicsBufferMin: number): Promise<boolean> {
  if (topicsBufferMin <= 0) return false;
  const counts = await ideaCounts(projectId);
  return counts.fresh < topicsBufferMin;
}

/**
 * The smallest refill worth making a model call for.
 *
 * Without a floor the threshold behaves absurdly: a bank of 49 against a
 * minimum of 50 would spend a whole request to fetch one topic, and do it again
 * tomorrow. So a refill always tops the bank up **to the minimum**, and never
 * asks for fewer than this many at once.
 */
export const MIN_REFILL_BATCH = 10;

/** How many topics to ask for so the bank ends up back at its minimum. */
export function refillCount(fresh: number, topicsBufferMin: number): number {
  const missing = Math.max(topicsBufferMin - fresh, 0);
  return Math.min(Math.max(missing, MIN_REFILL_BATCH), 50);
}

/** The bank: rows that still have only a subject. */
export async function listIdeas(projectId: string): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(and(eq(posts.projectId, projectId), eq(posts.status, 'idea')))
    .orderBy(desc(posts.createdAt))
    .limit(500);
}

export interface InsertReport {
  inserted: number;
  duplicates: number;
  titles: string[];
}

/**
 * Files new subjects, silently dropping ones that collide on the normalized key.
 *
 * The uniqueness guarantee lives in `posts_project_hash_uniq`, not here — two
 * concurrent replenish jobs would otherwise both pass an in-memory check. The
 * index spans every status, so a subject already published never comes back as
 * a fresh idea.
 */
export async function insertIdeas(
  projectId: string,
  entries: { title: string; category?: string | null }[],
  source: 'ai' | 'manual',
): Promise<InsertReport> {
  const cleaned = entries
    .map((e) => ({ title: e.title.trim(), category: e.category?.trim() || null }))
    .filter((e) => e.title.length > 0 && e.title.length <= 300);

  if (cleaned.length === 0) return { inserted: 0, duplicates: 0, titles: [] };

  // Collapse duplicates inside this batch first; ON CONFLICT cannot resolve two
  // conflicting rows within the same INSERT statement.
  const byHash = new Map<string, { title: string; category: string | null }>();
  for (const entry of cleaned) {
    const hash = normalizeTopic(entry.title);
    if (!byHash.has(hash)) byHash.set(hash, entry);
  }

  const values = [...byHash.entries()].map(([hash, entry]) => ({
    projectId,
    topicTitle: entry.title,
    normalizedHash: hash,
    category: entry.category,
    // No slot: that absence is what makes it an idea rather than a post.
    scheduledAt: null,
    status: 'idea' as const,
    source,
  }));

  const inserted = await db
    .insert(posts)
    .values(values)
    /*
     * The index is partial (`where normalized_hash is not null`), and Postgres
     * will not infer a partial arbiter unless the same predicate is repeated
     * here — without it the insert fails outright rather than skipping the dupe.
     */
    .onConflictDoNothing({
      target: [posts.projectId, posts.normalizedHash],
      where: sql`${posts.normalizedHash} is not null`,
    })
    .returning({ id: posts.id, title: posts.topicTitle });

  for (const row of inserted) {
    await record({
      projectId,
      postId: row.id,
      kind: 'topic_created',
      source: source === 'ai' ? 'auto' : 'manual',
      message: `Тема ${source === 'ai' ? 'згенерована' : 'додана вручну'}: ${row.title ?? ''}`,
    });
  }

  return {
    inserted: inserted.length,
    duplicates: cleaned.length - inserted.length,
    titles: inserted.map((r) => r.title ?? ''),
  };
}

/**
 * Drops ideas outright.
 *
 * Restricted to rows still in `idea`: once a subject has a slot it is a post
 * with work behind it, and deleting it from the bank view would be a surprise.
 * A published row must survive regardless — its hash is what stops the same
 * subject coming back.
 */
export async function deleteIdeas(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const removed = await db
    .delete(posts)
    .where(and(inArray(posts.id, ids), eq(posts.status, 'idea')))
    .returning({ id: posts.id });
  return removed.length;
}

const TOPICS_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      category: { type: 'string' },
    },
    required: ['title'],
  },
} as const;

export interface ReplenishReport extends InsertReport {
  requested: number;
  generated: number;
  model: string;
}

/**
 * Asks the model for fresh topics and files the ones that are actually new.
 *
 * Existing titles go into the prompt so the model can avoid semantic repeats —
 * the normalized-key check below only catches lexical ones.
 */
export async function replenishIdeas(
  project: Project,
  count: number,
  options: { allowBatch?: boolean } = {},
): Promise<ReplenishReport | 'batched' | 'blocked'> {
  const projectId = project.id;
  const common = await projectVariables(project);
  // Every subject the project has ever had, not just the unused ones: the model
  // is being asked to avoid repeats, and a topic already published is the one it
  // must avoid most.
  const existing = await db
    .select({ title: posts.topicTitle })
    .from(posts)
    .where(and(eq(posts.projectId, projectId), sql`${posts.topicTitle} is not null`))
    .orderBy(desc(posts.createdAt))
    .limit(120);

  const variables = {
    ...common,
    count,
    existingTopics:
      existing.length > 0 ? existing.map((t) => `- ${t.title ?? ''}`).join('\n') : '(банк порожній)',
  };

  /*
   * Topics are the one thing with no deadline at all — they are needed
   * "sometime", not by a slot — so they are the natural first customer of the
   * half-price tier. The threshold that triggers a refill is deliberately a
   * *minimum*, which means the bank still has topics while the batch cooks.
   */
  const batched = await batchedTopics(project, variables, options.allowBatch === true);
  if (batched === 'waiting') return 'batched';
  if (batched === 'blocked') return 'blocked';

  const result =
    batched ??
    (await runChain({
      action: 'topics',
      projectId,
      responseSchema: TOPICS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      variables,
    }));

  const parsed = parseTopics(result.text);
  const report = await insertIdeas(projectId, parsed, 'ai');

  logger.info(
    {
      projectId,
      model: result.model,
      requested: count,
      generated: parsed.length,
      inserted: report.inserted,
      duplicates: report.duplicates,
    },
    'topics replenished',
  );

  await record({
    projectId,
    kind: 'topics_replenished',
    action: 'topics',
    model: result.model,
    source: 'auto',
    message: `Банк тем поповнено: запитано ${count}, отримано ${parsed.length}, додано ${report.inserted}, дублікатів ${report.duplicates}`,
  });

  return { ...report, requested: count, generated: parsed.length, model: result.model };
}

/** Batch topics: submit when allowed, read when ready, otherwise say nothing. */
async function batchedTopics(
  project: Project,
  variables: Record<string, string | number | undefined>,
  allowBatch: boolean,
): Promise<{ text: string; model: string } | 'waiting' | 'blocked' | null> {
  const projectId = project.id;
  const pending = await findProjectBatch(projectId, 'topics');
  if (pending) {
    const outcome = await collectBatch(pending.id);
    if (outcome?.state === 'pending') return 'waiting';

    await dropBatch(pending.id);
    return outcome?.state === 'succeeded' && outcome.text
      ? { text: outcome.text, model: pending.model }
      : null;
  }

  /*
   * `allowBatch` is false for the button in the UI: «дай теми зараз» cannot
   * mean «за добу», so a manual refill takes the normal pipeline whatever the
   * project's batch mode says.
   */
  if (!allowBatch || project.batchMode === 'off') return null;

  const submitted = await submitBatch({
    action: 'topics',
    projectId,
    variables,
    responseSchema: TOPICS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    // A bank refill that has not arrived in two days is not worth waiting for;
    // by then the threshold has almost certainly triggered again.
    deadline: new Date(Date.now() + 2 * 24 * 3600_000),
  });

  if (submitted) return 'waiting';
  return project.batchMode === 'batch_only' ? 'blocked' : null;
}

/**
 * Structured output should already be clean JSON, but a model that ignores the
 * schema must not take the whole job down — strip fences and try again before
 * giving up.
 */
function parseTopics(text: string): { title: string; category?: string | null }[] {
  const candidates = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()];

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!Array.isArray(parsed)) continue;
      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          title: String(item.title ?? '').trim(),
          category: item.category ? String(item.category).trim() : null,
        }))
        .filter((item) => item.title.length > 0);
    } catch {
      // try the next candidate
    }
  }

  logger.warn({ sample: text.slice(0, 200) }, 'could not parse topics response as JSON');
  return [];
}

/**
 * Gives a slot-less subject to a post that has none.
 *
 * Used only by the paths that make a bare post first — a just-in-time slot or a
 * manual «publish now» on a project. The idea row is *absorbed*: its subject,
 * hash and provenance move onto the waiting post and the idea row is deleted,
 * so one subject never exists as two rows.
 *
 * With `topicsBufferMin = 0` there is no bank to draw from, so a subject is
 * generated on the spot — one more model call inside the critical path, which
 * is exactly the trade-off that mode makes explicit.
 */
export async function ensureSubject(post: Post, project: Project): Promise<Post | null> {
  if (post.topicTitle && post.normalizedHash) return post;

  const absorbed = await absorbIdea(post.id, project.id);
  if (absorbed) return absorbed;

  logger.info({ projectId: project.id }, 'idea bank empty, generating on demand');
  // No batching here by design: this call happens because a post needs a subject
  // *now*, which is the one situation a 24-hour tier cannot serve.
  await replenishIdeas(project, project.topicsBufferMin === 0 ? 1 : 5);
  return absorbIdea(post.id, project.id);
}

/**
 * Moves the oldest idea's subject onto `postId` and deletes the idea row.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers preparing different slots never take
 * the same subject. Both statements run in one transaction: a crash between
 * them would either duplicate the subject or lose it.
 */
export async function absorbIdea(postId: string, projectId: string): Promise<Post | null> {
  return db.transaction(async (tx) => {
    const [idea] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.projectId, projectId), eq(posts.status, 'idea')))
      .orderBy(asc(posts.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!idea) return null;

    await tx.delete(posts).where(eq(posts.id, idea.id));

    const [updated] = await tx
      .update(posts)
      .set({
        topicTitle: idea.topicTitle,
        normalizedHash: idea.normalizedHash,
        category: idea.category,
        source: idea.source,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId))
      .returning();

    return updated ?? null;
  });
}

/**
 * Hands the next idea its slot — the planner's path.
 *
 * Promoting an existing row is what keeps the two states one entity: the
 * alternative, inserting a fresh post and marking the idea consumed, is exactly
 * the two-row arrangement this merge removed. Returns null when the bank is
 * empty, and the caller creates a bare slot instead.
 */
export async function promoteIdeaToSlot(projectId: string, slot: Date): Promise<Post | null> {
  return db.transaction(async (tx) => {
    /*
     * The slot may already hold a post from an earlier tick — the planner is
     * idempotent and re-plans the same window every minute. Checking first
     * keeps `posts_slot_uniq` as the backstop it was meant to be rather than a
     * routine exception; the index still catches the race between two
     * instances.
     */
    const [taken] = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.projectId, projectId), eq(posts.scheduledAt, slot)))
      .limit(1);
    if (taken) return null;

    const [idea] = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.projectId, projectId), eq(posts.status, 'idea'), isNull(posts.scheduledAt)))
      .orderBy(asc(posts.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!idea) return null;

    const [promoted] = await tx
      .update(posts)
      .set({ scheduledAt: slot, status: 'planned', updatedAt: new Date() })
      .where(eq(posts.id, idea.id))
      .returning();

    return promoted ?? null;
  });
}
