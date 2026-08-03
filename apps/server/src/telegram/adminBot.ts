import { eq } from 'drizzle-orm';
import { config, env } from '../config.js';
import { db } from '../db/client.js';
import { posts, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueue } from '../queue/enqueue.js';
import { escapeHtml } from '../services/alerts.js';
import { resetForRegeneration } from '../services/posts.js';
import { adminApi, type InlineButton } from './adminApi.js';

/**
 * Optional control surface: alerts, approval cards, backups.
 *
 * With `ADMIN_BOT_TOKEN` unset the whole thing stays off and the system runs
 * normally — approval mode is the only feature that actually needs it, and a
 * project on `publish_mode: auto` never notices its absence.
 */

let running = false;
let offset = 0;

/** Callback payloads are capped at 64 bytes, so ids are carried raw. */
const ACTIONS = { publish: 'pub', regenerate: 'reg', skip: 'skp' } as const;

export function startAdminBot(): void {
  if (running || !config.adminBotEnabled) {
    if (!config.adminBotEnabled) {
      logger.info('admin bot disabled (ADMIN_BOT_TOKEN empty) — approval mode unavailable');
    }
    return;
  }
  if (config.adminUserIds.length === 0) {
    logger.warn('ADMIN_BOT_TOKEN set but ADMIN_USER_IDS empty — every callback would be rejected');
  }

  running = true;
  void pollLoop();
  logger.info({ admins: config.adminUserIds.length }, 'admin bot started');
}

export function stopAdminBot(): void {
  running = false;
}

async function pollLoop(): Promise<void> {
  while (running) {
    try {
      const updates = await adminApi.getUpdates(env.ADMIN_BOT_TOKEN, offset);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await handleUpdate(update).catch((err: unknown) => {
          logger.error({ err, update_id: update.update_id }, 'admin update handler failed');
        });
      }
    } catch (err) {
      logger.warn({ err }, 'admin bot poll failed, retrying');
      await sleep(5_000);
    }
  }
}

async function handleUpdate(update: Awaited<ReturnType<typeof adminApi.getUpdates>>[number]) {
  const query = update.callback_query;
  if (!query?.data) return;

  // The whitelist is the only authorisation here: anyone who finds the bot can
  // press a button otherwise.
  if (!config.adminUserIds.includes(String(query.from.id))) {
    await adminApi.answerCallbackQuery(env.ADMIN_BOT_TOKEN, query.id, 'Немає доступу');
    logger.warn({ userId: query.from.id }, 'rejected callback from non-admin');
    return;
  }

  const [action, postId] = query.data.split(':');
  if (!postId) {
    await adminApi.answerCallbackQuery(env.ADMIN_BOT_TOKEN, query.id, 'Невідома дія');
    return;
  }

  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) {
    await adminApi.answerCallbackQuery(env.ADMIN_BOT_TOKEN, query.id, 'Пост не знайдено');
    return;
  }

  let verdict: string;
  switch (action) {
    case ACTIONS.publish:
      await enqueue({
        type: 'publish_post',
        projectId: post.projectId,
        payload: { postId: post.id },
        priority: 50,
        dedupeKey: `post:${post.id}:publish`,
      });
      verdict = '✅ Публікується';
      break;

    case ACTIONS.regenerate:
      await resetForRegeneration(post.id, true);
      await enqueue({
        type: 'generate_post',
        projectId: post.projectId,
        payload: { postId: post.id },
        priority: 40,
        dedupeKey: `post:${post.id}:generate`,
      });
      verdict = '🔁 Перегенеровується';
      break;

    case ACTIONS.skip:
      await db
        .update(posts)
        .set({ status: 'skipped', error: 'Пропущено вручну через адмін-бота', updatedAt: new Date() })
        .where(eq(posts.id, post.id));
      verdict = '⏭ Слот пропущено';
      break;

    default:
      await adminApi.answerCallbackQuery(env.ADMIN_BOT_TOKEN, query.id, 'Невідома дія');
      return;
  }

  await adminApi.answerCallbackQuery(env.ADMIN_BOT_TOKEN, query.id, verdict);

  // Rewrite the card so the decision is visible in history and the buttons
  // cannot be pressed twice.
  if (query.message) {
    await adminApi
      .editMessageText(
        env.ADMIN_BOT_TOKEN,
        query.message.chat.id,
        query.message.message_id,
        `${verdict}\n\n<i>${escapeHtml(post.topicTitle ?? 'пост')}</i>`,
      )
      .catch(() => undefined);
  }

  logger.info({ post_id: post.id, action, by: query.from.id }, 'approval decision applied');
}

/**
 * Sends the approval card for a post waiting on a verdict.
 *
 * Text only: the staged image already exists on disk, but pushing it through
 * the admin bot would upload a second copy of every illustration for review.
 * The preview lives in the admin UI, which is one click away.
 */
export async function sendApprovalCard(postId: string): Promise<boolean> {
  if (!config.adminBotEnabled) return false;

  const [row] = await db
    .select({ post: posts, project: projects })
    .from(posts)
    .innerJoin(projects, eq(projects.id, posts.projectId))
    .where(eq(posts.id, postId))
    .limit(1);

  if (!row || row.post.status !== 'awaiting_approval') return false;

  const chatId = row.project.adminChatId ?? config.adminUserIds[0];
  if (!chatId) return false;

  const slot = row.post.scheduledAt.toLocaleString('uk-UA', { timeZone: row.project.timezone });
  const preview = (row.post.textHtml ?? '').slice(0, 700);

  const buttons: InlineButton[][] = [
    [
      { text: '✅ Опублікувати', callback_data: `${ACTIONS.publish}:${row.post.id}` },
      { text: '🔁 Перегенерувати', callback_data: `${ACTIONS.regenerate}:${row.post.id}` },
    ],
    [{ text: '⏭ Пропустити', callback_data: `${ACTIONS.skip}:${row.post.id}` }],
  ];

  await adminApi.sendMessage(
    env.ADMIN_BOT_TOKEN,
    chatId,
    [
      `📝 <b>${escapeHtml(row.project.name)}</b> — слот ${escapeHtml(slot)}`,
      `Тема: ${escapeHtml(row.post.topicTitle ?? '—')}`,
      '',
      preview,
    ].join('\n'),
    buttons,
  );

  logger.info({ post_id: row.post.id }, 'approval card sent');
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
