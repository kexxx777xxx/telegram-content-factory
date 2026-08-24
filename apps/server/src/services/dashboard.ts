import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { scheduleSchema } from '@tcf/shared';
import { db } from '../db/client.js';
import { apiKeys, apiKeyUsage, jobs, posts, projects, rateLimitState } from '../db/schema.js';
import { computeSlots } from '../scheduler/slots.js';
import { logger } from '../logger.js';

/**
 * The one screen that answers "is anything about to go wrong".
 *
 * Everything here is a leading indicator rather than a tally of the past:
 * buffer depth predicts a missed slot hours before it happens, an open circuit
 * explains why generation stopped, and budget pressure shows before a key runs
 * out — which is the whole point of having a dashboard rather than a log.
 */

export interface ProjectHealth {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  postsBuffer: number;
  /** Prepared posts still ahead of their slot. Below the target = trouble coming. */
  bufferDepth: number;
  freshTopics: number;
  topicsBufferMin: number;
  nextSlotAt: string | null;
  lastPublishedAt: string | null;
  failedPosts: number;
  skippedPosts: number;
}

export interface DashboardData {
  projects: ProjectHealth[];
  queue: Record<string, number>;
  deadJobs: { id: string; type: string; lastError: string | null; updatedAt: string }[];
  blocked: { keyLabel: string; model: string; blockedUntil: string }[];
  spendToday: { keyLabel: string; requests: number; inputTokens: number; outputTokens: number; budget: number | null }[];
  slo: {
    /** За останні 7 днів. */
    published: number;
    failed: number;
    /** Share of posts whose illustration came from the fallback rather than a model. */
    fallbackImages: number;
    totalImages: number;
  };
}

export async function getDashboard(): Promise<DashboardData> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  const today = now.toISOString().slice(0, 10);

  const projectRows = await db.select().from(projects).orderBy(projects.name);

  const bufferRows = await db
    .select({ projectId: posts.projectId, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(inArray(posts.status, ['planned', 'generating', 'ready', 'awaiting_approval']))
    .groupBy(posts.projectId);

  const lastPublishedRows = await db
    .select({ projectId: posts.projectId, last: sql<string | null>`max(${posts.publishedAt})` })
    .from(posts)
    .where(eq(posts.status, 'published'))
    .groupBy(posts.projectId);

  const troubleRows = await db
    .select({
      projectId: posts.projectId,
      status: posts.status,
      count: sql<number>`count(*)::int`,
    })
    .from(posts)
    .where(and(inArray(posts.status, ['failed', 'skipped']), gte(posts.updatedAt, weekAgo)))
    .groupBy(posts.projectId, posts.status);

  // Ideas are posts now; the old `topics` table is gone. Raw SQL against it
  // typechecked fine and would only have failed at runtime, which is exactly
  // why this one needed finding by hand.
  const topicRows = await db.execute(sql`
    select project_id, count(*)::int as fresh
    from posts where status = 'idea' group by project_id
  `);
  const freshByProject = new Map<string, number>();
  for (const row of rowsOf<{ project_id: string; fresh: number }>(topicRows)) {
    freshByProject.set(row.project_id, row.fresh);
  }

  const health: ProjectHealth[] = projectRows.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    status: project.status,
    timezone: project.timezone,
    postsBuffer: project.postsBuffer,
    bufferDepth: bufferRows.find((r) => r.projectId === project.id)?.count ?? 0,
    freshTopics: freshByProject.get(project.id) ?? 0,
    topicsBufferMin: project.topicsBufferMin,
    nextSlotAt: nextSlotOf(project),
    lastPublishedAt: toIso(lastPublishedRows.find((r) => r.projectId === project.id)?.last),
    failedPosts:
      troubleRows.find((r) => r.projectId === project.id && r.status === 'failed')?.count ?? 0,
    skippedPosts:
      troubleRows.find((r) => r.projectId === project.id && r.status === 'skipped')?.count ?? 0,
  }));

  const queueRows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);

  const deadRows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      lastError: jobs.lastError,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(eq(jobs.status, 'dead'))
    .orderBy(sql`${jobs.updatedAt} desc`)
    .limit(10);

  const blockedRows = await db
    .select({
      label: apiKeys.label,
      model: rateLimitState.model,
      blockedUntil: rateLimitState.blockedUntil,
    })
    .from(rateLimitState)
    .innerJoin(apiKeys, eq(apiKeys.id, rateLimitState.apiKeyId))
    .where(sql`${rateLimitState.blockedUntil} > now()`);

  const spendRows = await db
    .select({
      label: apiKeys.label,
      budget: apiKeys.dailyRequestBudget,
      requests: sql<number>`coalesce(sum(${apiKeyUsage.requests}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${apiKeyUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${apiKeyUsage.outputTokens}), 0)::int`,
    })
    .from(apiKeys)
    .leftJoin(
      apiKeyUsage,
      and(eq(apiKeyUsage.apiKeyId, apiKeys.id), eq(apiKeyUsage.day, today)),
    )
    .groupBy(apiKeys.id, apiKeys.label, apiKeys.dailyRequestBudget);

  return {
    projects: health,
    queue: Object.fromEntries(queueRows.map((r) => [r.status, r.count])),
    deadJobs: deadRows.map((r) => ({
      id: r.id,
      type: r.type,
      lastError: r.lastError,
      updatedAt: r.updatedAt.toISOString(),
    })),
    blocked: blockedRows
      .filter((r) => r.blockedUntil)
      .map((r) => ({
        keyLabel: r.label,
        model: r.model,
        blockedUntil: r.blockedUntil!.toISOString(),
      })),
    spendToday: spendRows.map((r) => ({
      keyLabel: r.label,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      budget: r.budget,
    })),
    slo: await computeSlo(weekAgo),
  };
}

/**
 * Числа, які справді відстежуються.
 *
 * «Вчасно / із запізненням» звідси зникло разом із прив'язкою поста до хвилини:
 * пост більше не має власного часу, повз який можна спізнитись (ADR 0009).
 * Лишилось те, що має сенс і в моделі черги: скільки вийшло, скільки чекає і
 * як часто ілюстрацію малював запасний генератор замість моделі.
 */
async function computeSlo(since: Date): Promise<DashboardData['slo']> {
  const result = await db.execute(sql`
    select
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where image_kind = 'svg_fallback')::int as fallback_images,
      count(*) filter (where image_kind is not null)::int as total_images
    from posts
    where updated_at >= ${since}
  `);

  const row = rowsOf<{
    published: number;
    failed: number;
    fallback_images: number;
    total_images: number;
  }>(result)[0];

  return {
    published: row?.published ?? 0,
    failed: row?.failed ?? 0,
    fallbackImages: row?.fallback_images ?? 0,
    totalImages: row?.total_images ?? 0,
  };
}

/**
 * Наступний слот проєкту — з розкладу, а не з рядка поста.
 *
 * Це і є вся зміна моделі в одному рядку: раніше «наступна публікація» була
 * властивістю конкретного поста, тепер — властивістю каналу.
 */
function nextSlotOf(project: { schedule: unknown; timezone: string; status: string }): string | null {
  if (project.status !== 'active') return null;
  try {
    const [slot] = computeSlots(scheduleSchema.parse(project.schedule), project.timezone, new Date(), 1);
    return slot?.toISOString() ?? null;
  } catch (err) {
    logger.warn({ err }, 'project schedule cannot be read for the dashboard');
    return null;
  }
}

/** Aggregates arrive as strings or Dates depending on the column; normalise both. */
function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
