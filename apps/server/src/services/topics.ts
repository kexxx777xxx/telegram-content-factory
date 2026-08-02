import type { TopicStatus } from '@tcf/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { runChain } from '../ai/chain.js';
import { db } from '../db/client.js';
import { topics, type Topic } from '../db/schema.js';
import { logger } from '../logger.js';

export class TopicNotFoundError extends Error {}

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

export interface TopicCounts {
  /** Unclaimed. This — not the bank size — is what the replenish threshold compares against. */
  fresh: number;
  /** Already handed to a post being generated; spoken for, not available. */
  queued: number;
  used: number;
  rejected: number;
  total: number;
}

export async function topicCounts(projectId: string): Promise<TopicCounts> {
  const rows = await db
    .select({ status: topics.status, count: sql<number>`count(*)::int` })
    .from(topics)
    .where(eq(topics.projectId, projectId))
    .groupBy(topics.status);

  const by = (status: TopicStatus) => rows.find((r) => r.status === status)?.count ?? 0;
  const fresh = by('new');
  const queued = by('queued');
  const used = by('used');
  const rejected = by('rejected');
  return { fresh, queued, used, rejected, total: fresh + queued + used + rejected };
}

/**
 * Whether the bank has dropped below the project's threshold.
 *
 * Counts only `new`: a queued topic is already attached to a post in flight, so
 * treating it as stock would let the bank run dry while every remaining row is
 * spoken for. `topicsBufferMin = 0` disables the bank entirely — topics are
 * then generated per post instead.
 */
export async function needsReplenish(projectId: string, topicsBufferMin: number): Promise<boolean> {
  if (topicsBufferMin <= 0) return false;
  const counts = await topicCounts(projectId);
  return counts.fresh < topicsBufferMin;
}

export async function listTopics(projectId: string, status?: TopicStatus): Promise<Topic[]> {
  return db
    .select()
    .from(topics)
    .where(status ? and(eq(topics.projectId, projectId), eq(topics.status, status)) : eq(topics.projectId, projectId))
    .orderBy(desc(topics.createdAt))
    .limit(500);
}

export interface InsertReport {
  inserted: number;
  duplicates: number;
  titles: string[];
}

/**
 * Inserts titles, silently dropping ones that collide on the normalized key.
 *
 * The uniqueness guarantee lives in `topics_project_hash_uniq`, not here — two
 * concurrent replenish jobs would otherwise both pass an in-memory check.
 */
export async function insertTopics(
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
    title: entry.title,
    normalizedHash: hash,
    category: entry.category,
    status: 'new' as const,
    source,
  }));

  const inserted = await db
    .insert(topics)
    .values(values)
    .onConflictDoNothing({ target: [topics.projectId, topics.normalizedHash] })
    .returning({ title: topics.title });

  return {
    inserted: inserted.length,
    duplicates: cleaned.length - inserted.length,
    titles: inserted.map((r) => r.title),
  };
}

export async function updateTopicStatus(id: string, status: TopicStatus): Promise<void> {
  const [row] = await db
    .update(topics)
    .set({ status, ...(status === 'used' ? { usedAt: new Date() } : {}) })
    .where(eq(topics.id, id))
    .returning({ id: topics.id });
  if (!row) throw new TopicNotFoundError('Тему не знайдено');
}

export async function deleteTopics(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const removed = await db.delete(topics).where(inArray(topics.id, ids)).returning({ id: topics.id });
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
export async function replenishTopics(
  projectId: string,
  count: number,
  persona: string,
  language: string,
): Promise<ReplenishReport> {
  const existing = await db
    .select({ title: topics.title })
    .from(topics)
    .where(eq(topics.projectId, projectId))
    .orderBy(desc(topics.createdAt))
    .limit(120);

  const result = await runChain({
    action: 'topics',
    projectId,
    responseSchema: TOPICS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    variables: {
      count,
      persona,
      language,
      existingTopics:
        existing.length > 0 ? existing.map((t) => `- ${t.title}`).join('\n') : '(банк порожній)',
    },
  });

  const parsed = parseTopics(result.text);
  const report = await insertTopics(projectId, parsed, 'ai');

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

  return { ...report, requested: count, generated: parsed.length, model: result.model };
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
 * Hands out the next topic for a post.
 *
 * With `topicsBufferMin = 0` there is no bank to draw from, so a topic is
 * generated on the spot — one more model call inside the critical path, which
 * is exactly the trade-off that mode makes explicit.
 */
export async function takeNextTopic(project: {
  id: string;
  persona: string;
  language: string;
  topicsBufferMin: number;
}): Promise<Topic | null> {
  const claimed = await claimOne(project.id);
  if (claimed) return claimed;

  logger.info({ projectId: project.id }, 'topic bank empty, generating on demand');
  await replenishTopics(project.id, project.topicsBufferMin === 0 ? 1 : 5, project.persona, project.language);
  return claimOne(project.id);
}

/**
 * `FOR UPDATE SKIP LOCKED` so two workers preparing different slots never hand
 * the same topic to both posts.
 */
async function claimOne(projectId: string): Promise<Topic | null> {
  const rows = await db.execute<Topic>(sql`
    update ${topics} set status = 'queued'
    where id = (
      select id from ${topics}
      where ${topics.projectId} = ${projectId} and ${topics.status} = 'new'
      order by ${topics.createdAt}
      for update skip locked
      limit 1
    )
    returning *
  `);

  const row = rows.rows?.[0] ?? (Array.isArray(rows) ? rows[0] : undefined);
  return (row as Topic | undefined) ?? null;
}
