import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT } from '@tcf/shared';
import { readFile } from 'node:fs/promises';
import { logger } from '../logger.js';
import { TelegramApiError } from './api.js';
import { pace } from './limits.js';
import { visibleLength } from './html.js';

const API_ROOT = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 60_000;

export interface PublishInput {
  token: string;
  chatId: string;
  textHtml: string;
  imagePath: string | null;
  /** Used only for pacing; a stable per-project key. */
  botKey: string;
}

export interface PublishResult {
  messageId: number;
  /** More than one when the caption limit forced a follow-up message. */
  extraMessageIds: number[];
}

interface TelegramMessage {
  message_id: number;
}

/**
 * Sends the post.
 *
 * The caption limit is the awkward part: Telegram allows 1024 characters on a
 * photo but 4096 in a message, and posts routinely land in between. Rather than
 * truncate the author's text, a long post goes out as photo-then-message, and
 * the permalink points at the photo so the link opens on the image.
 */
export async function publishPost(input: PublishInput): Promise<PublishResult> {
  const length = visibleLength(input.textHtml);
  const fitsCaption = length <= TELEGRAM_CAPTION_LIMIT;

  if (!input.imagePath) {
    const message = await sendMessage(input, input.textHtml);
    return { messageId: message.message_id, extraMessageIds: [] };
  }

  const photo = await sendPhoto(input, fitsCaption ? input.textHtml : undefined);

  if (fitsCaption) return { messageId: photo.message_id, extraMessageIds: [] };

  const extras: number[] = [];
  for (const chunk of splitForMessages(input.textHtml)) {
    const message = await sendMessage(input, chunk);
    extras.push(message.message_id);
  }

  logger.info(
    { chars: length, parts: extras.length + 1 },
    'post exceeded caption limit, sent as photo plus message',
  );
  return { messageId: photo.message_id, extraMessageIds: extras };
}

async function sendPhoto(input: PublishInput, caption?: string): Promise<TelegramMessage> {
  await pace(input.botKey);

  const form = new FormData();
  form.append('chat_id', input.chatId);
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }

  const bytes = await readFile(input.imagePath!);
  form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'post.png');

  return call<TelegramMessage>(input.token, 'sendPhoto', form);
}

async function sendMessage(input: PublishInput, text: string): Promise<TelegramMessage> {
  await pace(input.botKey);

  const form = new FormData();
  form.append('chat_id', input.chatId);
  form.append('text', text);
  form.append('parse_mode', 'HTML');
  form.append('link_preview_options', JSON.stringify({ is_disabled: true }));

  return call<TelegramMessage>(input.token, 'sendMessage', form);
}

/**
 * Splits on paragraph boundaries so a message never breaks mid-tag — Telegram
 * rejects unbalanced HTML, and a naive character split would produce exactly
 * that.
 */
function splitForMessages(html: string): string[] {
  if (visibleLength(html) <= TELEGRAM_MESSAGE_LIMIT) return [html];

  const parts: string[] = [];
  let current = '';

  for (const paragraph of html.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (visibleLength(candidate) > TELEGRAM_MESSAGE_LIMIT && current) {
      parts.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  if (current) parts.push(current);
  return parts;
}

async function call<T>(token: string, method: string, body: FormData): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TelegramApiError(method, 0, `таймаут ${SEND_TIMEOUT_MS} мс`);
    }
    throw new TelegramApiError(method, 0, err instanceof Error ? err.message : 'мережева помилка');
  } finally {
    clearTimeout(timer);
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  } | null;

  if (!payload?.ok || payload.result === undefined) {
    throw new TelegramApiError(
      method,
      payload?.error_code ?? response.status,
      payload?.description ?? 'невідома помилка Bot API',
      payload?.parameters?.retry_after,
    );
  }

  return payload.result;
}
