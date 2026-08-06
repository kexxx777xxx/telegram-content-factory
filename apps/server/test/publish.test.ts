import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishPost, type SentSoFar } from '../src/telegram/publisher.js';
import { TelegramApiError } from '../src/telegram/api.js';

/**
 * Publishing a post that goes out in more than one piece.
 *
 * The failure this guards against is not hypothetical arithmetic: a photo lands,
 * the follow-up message hits a `retry_after`, the queue reschedules, and the
 * whole publish runs again. Before the resume trail existed that reposted the
 * photo — the channel showed it twice and the permalink pointed at the copy.
 *
 * `fetch` is faked because the Bot API is the one dependency that cannot be
 * asked to fail on cue.
 */

interface Sent {
  method: string;
  caption: string | null;
  text: string | null;
}

let sent: Sent[] = [];
/** 1-based indexes of calls that should fail instead of succeeding. */
let failOn = new Set<number>();
let nextMessageId = 100;

function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const method = String(url).split('/').pop() ?? '';
  const form = init?.body as FormData;

  sent.push({
    method,
    caption: (form.get('caption') as string | null) ?? null,
    text: (form.get('text') as string | null) ?? null,
  });

  if (failOn.has(sent.length)) {
    return Promise.resolve({
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 5 },
        }),
      status: 429,
    } as Response);
  }

  return Promise.resolve({
    json: () => Promise.resolve({ ok: true, result: { message_id: nextMessageId++ } }),
    status: 200,
  } as Response);
}

/** A distinct bot key per test keeps the per-chat pacing from sleeping. */
let botCounter = 0;

function input(textHtml: string, extra: Partial<Parameters<typeof publishPost>[0]> = {}) {
  return {
    token: 'test-token',
    chatId: '@chan',
    textHtml,
    imagePath: '/dev/null',
    botKey: `bot-${++botCounter}`,
    ...extra,
  };
}

const SHORT = 'Короткий підпис.';
/** Comfortably past the 1024 caption limit, comfortably inside the 4096 message one. */
const LONG = 'а'.repeat(2000);

beforeEach(() => {
  sent = [];
  failOn = new Set();
  nextMessageId = 100;
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publishing a post in one piece', () => {
  it('puts a short text in the caption and sends nothing else', async () => {
    const result = await publishPost(input(SHORT));

    expect(sent.map((s) => s.method)).toEqual(['sendPhoto']);
    expect(sent[0]?.caption).toBe(SHORT);
    expect(result.extraMessageIds).toEqual([]);
  });

  it('does not resend a photo already recorded', async () => {
    const result = await publishPost(
      input(SHORT, { alreadySent: { messageId: 55, extraMessageIds: [] } }),
    );

    expect(sent).toHaveLength(0);
    expect(result.messageId).toBe(55);
  });
});

describe('publishing a post as photo plus message', () => {
  it('sends the photo without a caption, then the text', async () => {
    const result = await publishPost(input(LONG));

    expect(sent.map((s) => s.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(sent[0]?.caption).toBeNull();
    expect(sent[1]?.text).toBe(LONG);
    expect(result.extraMessageIds).toHaveLength(1);
  });

  it('reports each accepted send before attempting the next', async () => {
    const progress: SentSoFar[] = [];
    await publishPost(input(LONG, { onProgress: async (p) => void progress.push(p) }));

    // The photo has to be durable before the message is tried, or a failure
    // there leaves nothing to resume from.
    expect(progress[0]).toEqual({ messageId: 100, extraMessageIds: [] });
    expect(progress[1]).toEqual({ messageId: 100, extraMessageIds: [101] });
  });

  it('records the photo even when the follow-up message fails', async () => {
    const progress: SentSoFar[] = [];
    failOn = new Set([2]);

    await expect(
      publishPost(input(LONG, { onProgress: async (p) => void progress.push(p) })),
    ).rejects.toBeInstanceOf(TelegramApiError);

    expect(progress.at(-1)).toEqual({ messageId: 100, extraMessageIds: [] });
  });

  /** The whole point: the retry must not put a second photo in the channel. */
  it('resumes with the text only, leaving the photo alone', async () => {
    failOn = new Set([2]);
    const first = input(LONG);
    const progress: SentSoFar[] = [];

    await expect(
      publishPost({ ...first, onProgress: async (p) => void progress.push(p) }),
    ).rejects.toBeInstanceOf(TelegramApiError);

    sent = [];
    failOn = new Set();

    const result = await publishPost({ ...first, alreadySent: progress.at(-1) });

    expect(sent.map((s) => s.method)).toEqual(['sendMessage']);
    expect(result.messageId).toBe(100);
    expect(result.extraMessageIds).toEqual([101]);
  });

  it('resumes mid-way through a text that needs several messages', async () => {
    // Two messages' worth of paragraphs; the second one fails. Kept just over
    // the boundary because each send costs a real 1.1s of per-chat pacing.
    const huge = Array.from({ length: 4 }, (_, i) => `Абзац ${i}. ${'слово '.repeat(250)}`).join('\n\n');
    failOn = new Set([3]);
    const first = input(huge);
    const progress: SentSoFar[] = [];

    await expect(
      publishPost({ ...first, onProgress: async (p) => void progress.push(p) }),
    ).rejects.toBeInstanceOf(TelegramApiError);

    const partial = progress.at(-1)!;
    expect(partial.messageId).toBe(100);
    expect(partial.extraMessageIds).toHaveLength(1);

    sent = [];
    failOn = new Set();
    const result = await publishPost({ ...first, alreadySent: partial });

    // Only the messages that never arrived, and no photo.
    expect(sent.every((s) => s.method === 'sendMessage')).toBe(true);
    expect(result.extraMessageIds.length).toBeGreaterThan(partial.extraMessageIds.length);
    expect(result.extraMessageIds[0]).toBe(partial.extraMessageIds[0]);
  });
});

describe('publishing a post with no image', () => {
  it('sends one message and records it', async () => {
    const progress: SentSoFar[] = [];
    const result = await publishPost(
      input(SHORT, { imagePath: null, onProgress: async (p) => void progress.push(p) }),
    );

    expect(sent.map((s) => s.method)).toEqual(['sendMessage']);
    expect(progress).toEqual([{ messageId: 100, extraMessageIds: [] }]);
    expect(result.messageId).toBe(100);
  });

  it('does not resend a message already recorded', async () => {
    const result = await publishPost(
      input(SHORT, { imagePath: null, alreadySent: { messageId: 77, extraMessageIds: [] } }),
    );

    expect(sent).toHaveLength(0);
    expect(result.messageId).toBe(77);
  });
});
