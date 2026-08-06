import type { AiAction, PostLogEntry, PostLogPhase } from '@tcf/shared';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { postLogs, projects } from '../db/schema.js';
import { logger } from '../logger.js';

/** Guards a single row; a runaway prompt should not turn the log into the payload. */
const MAX_CONTENT = 200_000;

export interface LogSwitches {
  requests: boolean;
  responses: boolean;
}

const cache = new Map<string, { value: LogSwitches; at: number }>();
const CACHE_MS = 30_000;

/**
 * Reads a project's switches, cached briefly.
 *
 * Generation asks this on every model call, and re-reading the project row each
 * time would add a query per attempt to buy nothing: flipping a checkbox takes
 * effect on the next post either way.
 */
export async function logSwitches(projectId: string): Promise<LogSwitches> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const [row] = await db
    .select({ requests: projects.logRequests, responses: projects.logResponses })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const value = { requests: row?.requests ?? false, responses: row?.responses ?? false };
  cache.set(projectId, { value, at: Date.now() });
  return value;
}

/** Called after a project is saved so a freshly flipped switch applies at once. */
export function forgetSwitches(projectId: string): void {
  cache.delete(projectId);
}

export interface WriteLogInput {
  postId: string | null;
  projectId: string;
  action: AiAction;
  model: string;
  keyLabel: string | null;
  phase: PostLogPhase;
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  ok?: boolean;
}

/**
 * Writes one log row, and never throws.
 *
 * The log is a diagnostic aid; failing a post because its diary could not be
 * written would trade the actual job for the notes about it.
 */
export async function writeLog(input: WriteLogInput): Promise<void> {
  if (!input.postId) return;

  try {
    await db.insert(postLogs).values({
      postId: input.postId,
      projectId: input.projectId,
      action: input.action,
      model: input.model,
      keyLabel: input.keyLabel,
      phase: input.phase,
      content: input.content.slice(0, MAX_CONTENT),
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      durationMs: input.durationMs ?? null,
      ok: input.ok ?? true,
    });
  } catch (err) {
    logger.warn({ err, post_id: input.postId }, 'post log write failed, ignoring');
  }
}

export async function listPostLogs(postId: string, limit = 200): Promise<PostLogEntry[]> {
  const rows = await db
    .select()
    .from(postLogs)
    .where(eq(postLogs.postId, postId))
    .orderBy(desc(postLogs.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    model: row.model,
    keyLabel: row.keyLabel,
    phase: row.phase,
    content: row.content,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    durationMs: row.durationMs,
    ok: row.ok,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Drops rows past their project's retention.
 *
 * Per project rather than one global cutoff, because the retention is a project
 * setting: a channel being debugged keeps a month while the rest keep a day.
 */
export async function pruneLogs(): Promise<number> {
  const rows = await db.execute(sql`
    delete from ${postLogs} l
     using ${projects} p
     where l.project_id = p.id
       and l.created_at < now() - make_interval(days => p.log_retention_days)
    returning l.id
  `);
  const deleted = Array.isArray(rows) ? rows.length : ((rows as { rowCount?: number }).rowCount ?? 0);
  return deleted;
}

/** Only used by tests and the runbook: how much text the log currently holds. */
export async function logSize(projectId: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(length(${postLogs.content})), 0)::int` })
    .from(postLogs)
    .where(and(eq(postLogs.projectId, projectId), lt(postLogs.createdAt, new Date(Date.now() + 1))));
  return row?.bytes ?? 0;
}
