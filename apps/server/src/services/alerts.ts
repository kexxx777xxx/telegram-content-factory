import { eq } from 'drizzle-orm';
import { config, env } from '../config.js';
import { db } from '../db/client.js';
import { events, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { adminApi } from '../telegram/adminApi.js';

/**
 * Operator notifications.
 *
 * Every alert is written to `events` regardless of whether the bot is
 * configured — the audit trail is the durable record, and Telegram is only the
 * delivery channel. A system without an admin bot is fully functional; it just
 * expects the operator to look at the dashboard.
 */

export type AlertKind =
  | 'job_dead'
  | 'slot_skipped'
  | 'publish_failed'
  | 'chain_exhausted'
  | 'backup';

/**
 * Identical alerts collapse for this long.
 *
 * Without it, a quota outage across fifty projects would deliver fifty
 * identical messages a minute and train the operator to mute the bot — which
 * costs far more than the alerts are worth.
 */
const DEDUP_WINDOW_MS = 10 * 60_000;
const recentAlerts = new Map<string, number>();

export interface AlertInput {
  kind: AlertKind;
  projectId?: string | null;
  postId?: string | null;
  title: string;
  detail?: string;
  /** Collapses repeats; defaults to kind + project. */
  dedupeKey?: string;
}

export async function alert(input: AlertInput): Promise<void> {
  await db.insert(events).values({
    projectId: input.projectId ?? null,
    postId: input.postId ?? null,
    kind: `alert:${input.kind}`,
    payload: { title: input.title, detail: input.detail ?? null },
  });

  if (!config.adminBotEnabled) return;

  const key = input.dedupeKey ?? `${input.kind}:${input.projectId ?? 'global'}`;
  const last = recentAlerts.get(key);
  const now = Date.now();
  if (last && now - last < DEDUP_WINDOW_MS) return;
  recentAlerts.set(key, now);

  const chatId = await resolveAlertChat(input.projectId ?? null);
  if (!chatId) return;

  const projectName = input.projectId ? await projectLabel(input.projectId) : null;
  const text = [
    `⚠️ <b>${escapeHtml(input.title)}</b>`,
    projectName ? `Проєкт: ${escapeHtml(projectName)}` : null,
    input.detail ? `\n<code>${escapeHtml(input.detail.slice(0, 600))}</code>` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await adminApi.sendMessage(env.ADMIN_BOT_TOKEN, chatId, text);
  } catch (err) {
    // An alert that cannot be delivered must not take down the thing that
    // raised it; the event row already recorded what happened.
    logger.warn({ err, kind: input.kind }, 'could not deliver alert');
  }
}

/** Project chat when set, otherwise the first whitelisted admin's DM. */
async function resolveAlertChat(projectId: string | null): Promise<string | null> {
  if (projectId) {
    const [row] = await db
      .select({ adminChatId: projects.adminChatId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (row?.adminChatId) return row.adminChatId;
  }
  return config.adminUserIds[0] ?? null;
}

async function projectLabel(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.name ?? null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
