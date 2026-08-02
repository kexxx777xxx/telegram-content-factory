/**
 * Minimal typed client for the Telegram Bot API.
 *
 * Deliberately hand-rolled rather than pulling a bot framework: the app only
 * ever calls a handful of methods, and frameworks bring an update loop we do
 * not want for per-project publisher bots (they are write-only).
 */

const API_ROOT = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  can_post_messages?: boolean;
}

/**
 * A structured Bot API failure. `retryAfter` comes from the 429 `parameters`
 * block and is what the queue reschedules on instead of blind backoff.
 */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} → ${code}: ${description}`);
    this.name = 'TelegramApiError';
  }

  /** Token is wrong or the bot was deleted — retrying will never help. */
  get isAuthFailure(): boolean {
    return this.code === 401;
  }

  /** Bot is not in the chat, or the chat id is wrong. */
  get isAccessFailure(): boolean {
    return this.code === 400 || this.code === 403;
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

async function call<T>(
  token: string,
  method: string,
  payload: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TelegramApiError(method, 0, `таймаут ${timeoutMs} мс`);
    }
    throw new TelegramApiError(method, 0, err instanceof Error ? err.message : 'мережева помилка');
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => null)) as TelegramResponse<T> | null;

  if (!body || !body.ok || body.result === undefined) {
    throw new TelegramApiError(
      method,
      body?.error_code ?? response.status,
      body?.description ?? 'невідома помилка Bot API',
      body?.parameters?.retry_after,
    );
  }

  return body.result;
}

export const telegram = {
  getMe: (token: string) => call<TelegramUser>(token, 'getMe'),

  getChat: (token: string, chatId: string) => call<TelegramChat>(token, 'getChat', { chat_id: chatId }),

  getChatMember: (token: string, chatId: string, userId: number) =>
    call<TelegramChatMember>(token, 'getChatMember', { chat_id: chatId, user_id: userId }),
};
