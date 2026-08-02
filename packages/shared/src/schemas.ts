import { z } from 'zod';
import {
  AI_ACTIONS,
  AI_PROVIDERS,
  IMAGE_MODES,
  KEY_PREFERENCES,
  MISS_POLICIES,
  PROJECT_STATUSES,
  PUBLISH_MODES,
  SCHEDULE_MODES,
} from './enums.js';

/** `HH:MM` in the project's own timezone. */
export const timeSlotSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Очікується час у форматі HH:MM');

/** IANA timezone name, validated against the runtime's own tz database. */
export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Невідомий часовий пояс (очікується IANA, напр. Europe/Kyiv)');

/**
 * Telegram channel id: either `@publicname` or a numeric `-100…` id.
 * The public form is what lets us build a `t.me/name/123` permalink; numeric
 * ids fall back to the `t.me/c/…` form.
 */
export const telegramChannelSchema = z
  .string()
  .regex(/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{6,})$/, 'Очікується @username каналу або числовий -100… id');

export const scheduleSchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('slots'),
      /** Fixed times of day, e.g. ["09:00", "13:00", "18:00"]. */
      slots: z.array(timeSlotSchema).min(1).max(24),
      /** ISO weekdays (1 = Monday … 7 = Sunday). Empty = every day. */
      weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    }),
    z.object({
      mode: z.literal('interval'),
      intervalMinutes: z.number().int().min(15).max(7 * 24 * 60),
      /** Anchor time of day the interval counts from. */
      anchor: timeSlotSchema.default('09:00'),
    }),
  ])
  .describe('Розклад публікацій у часовому поясі проєкту');
export type Schedule = z.infer<typeof scheduleSchema>;

export const projectInputSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Лише малі літери, цифри та дефіси'),
  status: z.enum(PROJECT_STATUSES).default('paused'),
  timezone: timezoneSchema.default('Europe/Kyiv'),
  language: z.string().min(2).max(16).default('uk'),
  /** Free-form author voice injected into every text prompt. */
  persona: z.string().max(4000).default(''),
  hashtags: z.array(z.string().max(64)).max(20).default([]),

  telegramChannelId: telegramChannelSchema,
  telegramBotToken: z.string().min(20).optional(),
  adminChatId: z.string().optional().nullable(),

  imageMode: z.enum(IMAGE_MODES).default('svg'),
  publishMode: z.enum(PUBLISH_MODES).default('auto'),

  /**
   * 0 is deliberate and supported: no pre-generation, the post is produced at
   * publish time (JIT). Any value ≥ 1 keeps that many slots generated ahead.
   */
  postsBuffer: z.number().int().min(0).max(50).default(3),
  /** 0 = no topic bank; a topic is requested from the model just in time. */
  topicsBufferMin: z.number().int().min(0).max(500).default(10),
  /** How long before a slot generation starts. Ignored when postsBuffer = 0. */
  leadTimeMinutes: z.number().int().min(0).max(7 * 24 * 60).default(180),
  missPolicy: z.enum(MISS_POLICIES).default('publish_late'),

  schedule: scheduleSchema,
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const projectUpdateSchema = projectInputSchema.partial();

export const modelChainStepSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  model: z.string().min(1),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
      thinkingBudget: z.number().int().min(0).optional(),
    })
    .default({}),
  /** Overrides the resolved prompt for this step only. */
  promptId: z.string().uuid().optional().nullable(),
  keyPreference: z.enum(KEY_PREFERENCES).default('project_then_global'),
});
export type ModelChainStep = z.infer<typeof modelChainStepSchema>;

export const modelChainSchema = z.object({
  action: z.enum(AI_ACTIONS),
  enabled: z.boolean().default(true),
  /** Tried in order; a rate-limited or circuit-broken step is skipped instantly. */
  steps: z.array(modelChainStepSchema).min(1).max(10),
});
export type ModelChain = z.infer<typeof modelChainSchema>;

export const loginSchema = z.object({
  password: z.string().min(1),
});

/** Reported by `GET /api/health` and used by the UI to render warning banners. */
export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  database: z.enum(['up', 'down']),
  authEnabled: z.boolean(),
  time: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

export const scheduleModeValues = SCHEDULE_MODES;
