import { logger } from '../logger.js';

/**
 * Per-bot pacing for outbound Telegram calls.
 *
 * Telegram allows roughly 30 messages a second overall and about 20 a minute to
 * a single chat. With dozens of projects publishing near the same slot, hitting
 * the ceiling costs a 429 with `retry_after` and a delayed post — cheaper to
 * simply not send that fast.
 *
 * In memory on purpose: this paces one process against one bot, and a restart
 * losing the window is harmless. The durable throttling that matters — model
 * quotas — lives in Postgres.
 */

const PER_CHAT_PER_MINUTE = 18;
const MIN_GAP_MS = 1_100;

interface BotWindow {
  timestamps: number[];
  lastSentAt: number;
}

const windows = new Map<string, BotWindow>();

export async function pace(botKey: string): Promise<void> {
  const now = Date.now();
  const window = windows.get(botKey) ?? { timestamps: [], lastSentAt: 0 };

  window.timestamps = window.timestamps.filter((t) => now - t < 60_000);

  const sinceLast = now - window.lastSentAt;
  let wait = sinceLast < MIN_GAP_MS ? MIN_GAP_MS - sinceLast : 0;

  if (window.timestamps.length >= PER_CHAT_PER_MINUTE) {
    const oldest = window.timestamps[0] ?? now;
    wait = Math.max(wait, 60_000 - (now - oldest));
  }

  if (wait > 0) {
    logger.debug({ botKey, waitMs: wait }, 'pacing telegram send');
    await sleep(wait);
  }

  const sentAt = Date.now();
  window.timestamps.push(sentAt);
  window.lastSentAt = sentAt;
  windows.set(botKey, window);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
