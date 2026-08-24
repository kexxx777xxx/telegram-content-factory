import type { Schedule } from '@tcf/shared';
import { DateTime } from 'luxon';

/**
 * Slot arithmetic, done in the project's own timezone.
 *
 * Слот — це момент, у який канал говорить, а не власність конкретного поста
 * (ADR 0009). Хто саме поїде в цей слот, вирішує черга в `publisher.ts`.
 *
 * Everything here is wall-clock: "09:00" means nine in the morning where the
 * channel's audience lives, not nine UTC. That is also why DST has to be dealt
 * with rather than ignored — twice a year a slot either does not exist or
 * happens twice, and both produce wrong publication times if handled naively.
 */

/** Guards against a schedule whose filters exclude every day. */
const MAX_DAYS_SCANNED = 400;

export function computeSlots(
  schedule: Schedule,
  timezone: string,
  after: Date,
  count: number,
): Date[] {
  if (count <= 0) return [];
  const from = DateTime.fromJSDate(after, { zone: timezone });
  if (!from.isValid) throw new Error(`Невідомий часовий пояс: ${timezone}`);

  return schedule.mode === 'slots'
    ? fixedSlots(schedule, from, count)
    : intervalSlots(schedule, from, count);
}

function fixedSlots(
  schedule: Extract<Schedule, { mode: 'slots' }>,
  from: DateTime,
  count: number,
): Date[] {
  const times = [...new Set(schedule.slots)].sort();
  const weekdays = new Set(schedule.weekdays);
  const found: Date[] = [];

  let day = from.startOf('day');
  for (let scanned = 0; scanned < MAX_DAYS_SCANNED && found.length < count; scanned++) {
    // luxon's weekday is 1..7 Mon..Sun, matching the schema.
    if (weekdays.size === 0 || weekdays.has(day.weekday)) {
      for (const time of times) {
        const at = atWallClock(day, time);
        if (at && at > from) {
          found.push(at.toJSDate());
          if (found.length >= count) break;
        }
      }
    }
    day = day.plus({ days: 1 });
  }

  // Times are collected day by day, so a multi-slot day is already ordered, but
  // a DST shift can reorder within a day.
  return found.sort((a, b) => a.getTime() - b.getTime()).slice(0, count);
}

function intervalSlots(
  schedule: Extract<Schedule, { mode: 'interval' }>,
  from: DateTime,
  count: number,
): Date[] {
  const step = { minutes: schedule.intervalMinutes };
  let cursor = atWallClock(from.startOf('day'), schedule.anchor) ?? from.startOf('day');

  // Walk back first: the anchor for "today" may already be behind us while the
  // previous day's sequence still reaches into the future.
  while (cursor > from) cursor = cursor.minus(step);
  while (cursor <= from) cursor = cursor.plus(step);

  const found: Date[] = [];
  for (let i = 0; i < count; i++) {
    found.push(cursor.toJSDate());
    cursor = cursor.plus(step);
  }
  return found;
}

/**
 * Places `HH:MM` on a given day.
 *
 * On the spring-forward day the wall clock skips an hour, so a slot inside the
 * gap does not exist; luxon moves it forward, which is the sane choice — the
 * post goes out at the next real moment rather than being silently dropped.
 * On the autumn day the hour repeats and luxon takes the first occurrence, so a
 * slot fires once rather than twice.
 */
function atWallClock(day: DateTime, time: string): DateTime | null {
  const [hourPart, minutePart] = time.split(':');
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const at = day.set({ hour, minute, second: 0, millisecond: 0 });
  return at.isValid ? at : null;
}

/**
 * Слот, у який проєкт має заговорити просто зараз, — або `null`.
 *
 * Розклад тепер не роздає хвилини постам, а лише відповідає на одне питання:
 * чи настав момент, коли черга рухається. Момент — це перший слот після
 * попередньої публікації; якщо він уже позаду, час говорити.
 *
 * Пропущені слоти зникають самі, без політики: скільки б їх не накопичилось за
 * ніч простою, повертається рівно один, і наступний з'явиться лише після того,
 * як цей буде використаний. Тому черга ніколи не вивалюється в канал одразу.
 */
export function dueSlot(
  schedule: Schedule,
  timezone: string,
  since: Date,
  now = new Date(),
): Date | null {
  const [next] = computeSlots(schedule, timezone, since, 1);
  return next && next <= now ? next : null;
}

/**
 * A stable per-project offset in seconds.
 *
 * Used to spread *generation* start times: with dozens of projects sharing a
 * 09:00 slot, every one of them would otherwise queue its model calls in the
 * same second. Derived from the id rather than random so a replanning tick
 * produces the same `run_after` and the dedupe key stays meaningful.
 */
export function projectJitterSeconds(projectId: string, spreadSeconds = 900): number {
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return hash % spreadSeconds;
}
