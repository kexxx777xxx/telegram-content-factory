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
  /**
   * What a previous, interrupted run of this same post already delivered.
   * Anything listed here is skipped instead of sent again.
   */
  alreadySent?: SentSoFar;
  /**
   * Called after every accepted send, before the next one is attempted. The
   * caller persists it, which is what makes a resumed publish skip the right
   * parts — see the note on `publishPost`.
   */
  onProgress?: (progress: SentSoFar) => Promise<void>;
}

/** Message ids Telegram has already accepted for one post. */
export interface SentSoFar {
  /** The photo, and the permalink anchor. */
  messageId: number | null;
  /** Follow-up text messages, in order. */
  extraMessageIds: number[];
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
 *
 * That split is also why this function is resumable. A post going out in more
 * than one piece has no single call to retry: if the photo lands and the
 * follow-up message hits a `retry_after`, the queue reschedules and runs the
 * whole publish again. Without a record of what already arrived, the retry
 * would repost the photo — the channel would show it twice, and the permalink
 * would point at the second copy while the first hung there orphaned. So every
 * accepted send is reported through `onProgress` *before* the next one is
 * attempted, and `alreadySent` makes the next run skip it.
 */
export async function publishPost(input: PublishInput): Promise<PublishResult> {
  const length = visibleLength(input.textHtml);
  const fitsCaption = length <= TELEGRAM_CAPTION_LIMIT;
  const sent: SentSoFar = {
    messageId: input.alreadySent?.messageId ?? null,
    extraMessageIds: [...(input.alreadySent?.extraMessageIds ?? [])],
  };

  const advance = async (): Promise<void> => {
    if (input.onProgress) await input.onProgress({ ...sent, extraMessageIds: [...sent.extraMessageIds] });
  };

  if (!input.imagePath) {
    // Text-only posts are a single call, so there is nothing to resume: either
    // the one message is already recorded, or it still has to be sent.
    if (sent.messageId !== null) return { messageId: sent.messageId, extraMessageIds: [] };
    const message = await sendMessage(input, input.textHtml);
    sent.messageId = message.message_id;
    await advance();
    return { messageId: message.message_id, extraMessageIds: [] };
  }

  if (sent.messageId === null) {
    const photo = await sendPhoto(input, fitsCaption ? input.textHtml : undefined);
    sent.messageId = photo.message_id;
    await advance();
  } else {
    logger.info({ messageId: sent.messageId }, 'photo already delivered by an earlier attempt, skipping');
  }

  if (fitsCaption) return { messageId: sent.messageId, extraMessageIds: sent.extraMessageIds };

  // Chunking is deterministic on the same text, so the count of delivered
  // messages is enough to know where to resume.
  const chunks = splitForMessages(input.textHtml);
  for (const chunk of chunks.slice(sent.extraMessageIds.length)) {
    const message = await sendMessage(input, chunk);
    sent.extraMessageIds.push(message.message_id);
    await advance();
  }

  logger.info(
    { chars: length, parts: sent.extraMessageIds.length + 1 },
    'post exceeded caption limit, sent as photo plus message',
  );
  return { messageId: sent.messageId, extraMessageIds: sent.extraMessageIds };
}

/**
 * Puts an already-published post into one more chat.
 *
 * `copyMessage`, not a second `publishPost`: the photo is uploaded once and the
 * mirrors reuse the file Telegram already has, the text is split exactly as it
 * was in the main channel, and a copy carries none of the "forwarded from"
 * header `forwardMessage` would add.
 */
export async function copyToChat(
  token: string,
  fromChatId: string,
  toChatId: string,
  messageIds: number[],
): Promise<void> {
  for (const messageId of messageIds) {
    // Own pacing window: the per-chat ceiling is per chat, not per bot.
    await pace(`${fromChatId}->${toChatId}`);

    const form = new FormData();
    form.append('chat_id', toChatId);
    form.append('from_chat_id', fromChatId);
    form.append('message_id', String(messageId));
    await call<TelegramMessage>(token, 'copyMessage', form);
  }
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
 *
 * Paragraphs are the preferred seam, not the only one: a single paragraph can
 * itself exceed the limit, and emitting it whole would hand Telegram a message
 * it rejects — the very failure this function exists to prevent. Such a
 * paragraph is broken down further, on the widest seam that still fits.
 */
export function splitForMessages(html: string): string[] {
  if (visibleLength(html) <= TELEGRAM_MESSAGE_LIMIT) return [html];

  const parts: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) parts.push(current);
    current = '';
  };

  for (const paragraph of html.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (visibleLength(candidate) <= TELEGRAM_MESSAGE_LIMIT) {
      current = candidate;
      continue;
    }

    flush();

    if (visibleLength(paragraph) <= TELEGRAM_MESSAGE_LIMIT) {
      current = paragraph;
      continue;
    }

    // Oversized on its own: spend it here rather than pass the limit on.
    const pieces = splitOversized(paragraph);
    parts.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }

  flush();
  return parts;
}

/**
 * Last-resort break-up of one paragraph, trying progressively narrower seams.
 *
 * Sentence ends first, then any whitespace. Both keep the break outside a tag,
 * which is the property that matters: a cut between `<b>` and `</b>` would make
 * Telegram reject the whole message.
 */
function splitOversized(paragraph: string): string[] {
  const bySentence = accumulate(paragraph.split(/(?<=[.!?…])\s+/), ' ');
  if (bySentence.every((part) => visibleLength(part) <= TELEGRAM_MESSAGE_LIMIT)) return bySentence;

  const byWord = accumulate(paragraph.split(/\s+/), ' ');
  if (byWord.every((part) => visibleLength(part) <= TELEGRAM_MESSAGE_LIMIT)) return byWord;

  /*
   * A single unbroken run longer than the limit — no whitespace to cut on.
   * Nothing can be done that keeps both the tags balanced and the length legal,
   * and a rejected send is more honest than silently truncated text.
   */
  throw new Error(
    `Абзац без пробілів довший за ліміт Telegram (${TELEGRAM_MESSAGE_LIMIT}) — розбити безпечно неможливо`,
  );
}

/** Greedily packs pieces into parts that stay under the message limit. */
function accumulate(pieces: string[], glue: string): string[] {
  const parts: string[] = [];
  let current = '';

  for (const piece of pieces) {
    const candidate = current ? `${current}${glue}${piece}` : piece;
    if (visibleLength(candidate) > TELEGRAM_MESSAGE_LIMIT && current) {
      parts.push(current);
      current = piece;
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
