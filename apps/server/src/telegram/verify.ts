import type { TelegramCheck } from '@tcf/shared';
import { telegram, TelegramApiError } from './api.js';

/**
 * Probes the channel with the project's own bot and reports what is wrong in
 * terms the operator can act on.
 *
 * Checking posting rights up front matters: a bot that is merely a member of
 * the channel accepts `getChat` happily and only fails at the first real
 * publish — which, with a 3-hour buffer, would surface hours after setup.
 */
export async function verifyTelegram(token: string, channelId: string): Promise<TelegramCheck> {
  const problems: string[] = [];

  let bot: TelegramCheck['bot'] = null;
  try {
    const me = await telegram.getMe(token);
    bot = { id: me.id, username: me.username ?? null, firstName: me.first_name };
  } catch (err) {
    if (err instanceof TelegramApiError && err.isAuthFailure) {
      problems.push('Токен бота невірний або бот видалений. Перевірте токен від @BotFather.');
    } else {
      problems.push(`Не вдалося звернутися до Bot API: ${describe(err)}`);
    }
    return { ok: false, bot: null, chat: null, canPost: false, problems };
  }

  let chat: TelegramCheck['chat'] = null;
  try {
    const found = await telegram.getChat(token, channelId);
    chat = {
      id: found.id,
      type: found.type,
      title: found.title ?? null,
      username: found.username ?? null,
    };
    if (found.type !== 'channel') {
      problems.push(
        `Вказаний чат має тип «${found.type}», а очікується канал. Пости публікуються в канал.`,
      );
    }
  } catch (err) {
    if (err instanceof TelegramApiError && err.isAccessFailure) {
      problems.push(
        `Бот${bot.username ? ` @${bot.username}` : ''} не бачить каналу ${channelId}. ` +
          'Додайте його до каналу як адміністратора.',
      );
    } else {
      problems.push(`Не вдалося отримати канал: ${describe(err)}`);
    }
    return { ok: false, bot, chat: null, canPost: false, problems };
  }

  let canPost = false;
  try {
    const member = await telegram.getChatMember(token, channelId, bot.id);
    const isAdmin = member.status === 'administrator' || member.status === 'creator';
    // Telegram omits can_post_messages for the creator, who can always post.
    canPost = isAdmin && (member.can_post_messages ?? member.status === 'creator');

    if (!isAdmin) {
      problems.push('Бот присутній у каналі, але не адміністратор — публікувати не зможе.');
    } else if (!canPost) {
      problems.push('Бот є адміністратором, але без права «Публікація повідомлень».');
    }
  } catch (err) {
    problems.push(`Не вдалося перевірити права бота: ${describe(err)}`);
  }

  return { ok: problems.length === 0, bot, chat, canPost, problems };
}

function describe(err: unknown): string {
  if (err instanceof TelegramApiError) return err.description;
  return err instanceof Error ? err.message : 'невідома помилка';
}
