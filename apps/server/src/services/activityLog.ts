import type { AiAction, LogEntry, LogKind, LogSource } from '@tcf/shared';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logs, projects } from '../db/schema.js';
import { logger } from '../logger.js';

/** Guards a single row; a runaway prompt should not become the payload. */
const MAX_DETAIL = 200_000;

const cache = new Map<string, { value: boolean; at: number }>();
const CACHE_MS = 30_000;

/**
 * Whether this project keeps a journal, cached briefly.
 *
 * Generation asks on every model call, and re-reading the project row each time
 * would add a query per attempt to buy nothing: a flipped checkbox takes effect
 * on the next post either way.
 */
export async function logEnabled(projectId: string): Promise<boolean> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const [row] = await db
    .select({ enabled: projects.logEnabled })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const value = row?.enabled ?? false;
  cache.set(projectId, { value, at: Date.now() });
  return value;
}

/** Called after a project is saved so a freshly flipped switch applies at once. */
export function forgetLogSetting(projectId: string): void {
  cache.delete(projectId);
}

export interface LogInput {
  projectId: string;
  postId?: string | null;
  kind: LogKind;
  message: string;
  detail?: string | null;
  action?: AiAction | null;
  /** `true` — запис про роботу на batch-тарифі. Фільтр журналу читає саме це. */
  batch?: boolean;
  model?: string | null;
  keyLabel?: string | null;
  source?: LogSource | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  ok?: boolean;
}

/**
 * Writes one entry, and never throws.
 *
 * The journal is a diagnostic aid; failing a post because its diary could not
 * be written would trade the actual work for the notes about it.
 */
export async function record(input: LogInput): Promise<void> {
  try {
    if (!(await logEnabled(input.projectId))) return;

    await db.insert(logs).values({
      projectId: input.projectId,
      postId: input.postId ?? null,
      kind: input.kind,
      action: input.action ?? null,
      batch: input.batch ?? false,
      model: input.model ?? null,
      keyLabel: input.keyLabel ?? null,
      source: input.source ?? null,
      message: input.message,
      detail: input.detail ? input.detail.slice(0, MAX_DETAIL) : null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      durationMs: input.durationMs ?? null,
      ok: input.ok ?? true,
    });
  } catch (err) {
    logger.warn({ err, project_id: input.projectId }, 'log write failed, ignoring');
  }
}

function toEntry(row: typeof logs.$inferSelect): LogEntry {
  return {
    id: row.id,
    postId: row.postId,
    kind: row.kind,
    action: row.action,
    model: row.model,
    keyLabel: row.keyLabel,
    source: row.source,
    message: row.message,
    detail: row.detail,
    batch: row.batch,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    durationMs: row.durationMs,
    ok: row.ok,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function postLog(postId: string, limit = 200): Promise<LogEntry[]> {
  const rows = await db
    .select()
    .from(logs)
    .where(eq(logs.postId, postId))
    .orderBy(desc(logs.createdAt))
    .limit(limit);
  return rows.map(toEntry);
}

/**
 * The project timeline.
 *
 * `onlyProjectWide` hides per-post chatter, which is what makes the view usable
 * as a channel's history: topic bank and publications are the events an
 * operator scans for, while prompts belong to the post they came from.
 */
export async function projectLog(
  projectId: string,
  options: { limit?: number; onlyProjectWide?: boolean } = {},
): Promise<LogEntry[]> {
  const rows = await db
    .select()
    .from(logs)
    .where(
      options.onlyProjectWide
        ? and(
            eq(logs.projectId, projectId),
            or(isNull(logs.postId), eq(logs.kind, 'publish'), eq(logs.kind, 'topic_created')),
          )
        : eq(logs.projectId, projectId),
    )
    .orderBy(desc(logs.createdAt))
    .limit(options.limit ?? 100);
  return rows.map(toEntry);
}

/**
 * Drops rows past their project's retention.
 *
 * Per project rather than one global cutoff, because retention is a project
 * setting: a channel being debugged keeps a month while the rest keep a day.
 */
export async function pruneLogs(): Promise<number> {
  const result = await db.execute(sql`
    delete from ${logs} l
     using ${projects} p
     where l.project_id = p.id
       and l.created_at < now() - make_interval(days => p.log_retention_days)
    returning l.id
  `);
  return Array.isArray(result)
    ? result.length
    : ((result as { rowCount?: number }).rowCount ?? 0);
}
