/**
 * The admin bot's own slice of the Bot API.
 *
 * Separate from `api.ts` because this is the only bot that *reads*: publisher
 * bots are write-only, and giving them an update loop would multiply polling by
 * the number of projects for no benefit.
 */

const API_ROOT = 'https://api.telegram.org';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
}

async function call<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 70_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok || body.result === undefined) {
      throw new Error(`${method}: ${body.description ?? 'невідома помилка'}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export const adminApi = {
  /**
   * Long poll. `allowed_updates` is narrowed to callbacks: the bot is a control
   * surface, not a chat partner, and ignoring everything else keeps the loop
   * cheap and the surface small.
   */
  getUpdates: (token: string, offset: number, timeoutSeconds = 50) =>
    call<TelegramUpdate[]>(
      token,
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['callback_query'] },
      (timeoutSeconds + 15) * 1000,
    ),

  sendMessage: (
    token: string,
    chatId: string | number,
    text: string,
    buttons?: InlineButton[][],
  ) =>
    call<{ message_id: number }>(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    }),

  editMessageText: (token: string, chatId: number, messageId: number, text: string) =>
    call<unknown>(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    }),

  /** Clears the button spinner; Telegram shows it until this is answered. */
  answerCallbackQuery: (token: string, callbackQueryId: string, text?: string) =>
    call<boolean>(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }),

  sendDocument: async (
    token: string,
    chatId: string | number,
    filename: string,
    data: Buffer,
    caption?: string,
  ): Promise<{ message_id: number }> => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([new Uint8Array(data)]), filename);

    const response = await fetch(`${API_ROOT}/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    const body = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    if (!body.ok || !body.result) {
      throw new Error(`sendDocument: ${body.description ?? 'невідома помилка'}`);
    }
    return body.result;
  },
};
