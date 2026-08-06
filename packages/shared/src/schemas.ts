import { z } from 'zod';
import {
  AI_ACTIONS,
  AI_PROVIDERS,
  KEY_LEVELS,
  IMAGE_MODES,
  MISS_POLICIES,
  LOG_KINDS,
  LOG_SOURCES,
  POST_STATUSES,
  PROJECT_STATUSES,
  PROMPT_SCOPES,
  PUBLISH_MODES,
  SCHEDULE_MODES,
  TOPIC_SOURCES,
  TOPIC_STATUSES,
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

const defaultSchedule: Schedule = { mode: 'slots', slots: ['09:00', '18:00'], weekdays: [] };

/**
 * Field definitions **without** defaults.
 *
 * Kept separate because `.partial()` does not strip `.default()`: a PATCH body
 * carrying one field would otherwise parse into every field, silently resetting
 * the channel's persona, schedule and buffers to their defaults. Defaults belong
 * to creation only, so they are applied in `projectInputSchema` and nowhere else.
 */
const projectFields = {
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Лише малі літери, цифри та дефіси'),
  status: z.enum(PROJECT_STATUSES),
  timezone: timezoneSchema,
  language: z.string().min(2).max(16),
  /** Free-form author voice injected into every text prompt. */
  persona: z.string().max(4000),
  /** Reaches illustration prompts as {{style}}; empty falls back to the built-in. */
  imageStyle: z.string().max(600),
  hashtags: z.array(z.string().max(64)).max(20),

  telegramChannelId: telegramChannelSchema,
  adminChatId: z.string().nullable(),

  /** null = use the default key. */
  apiKeyId: z.string().uuid().nullable(),

  imageMode: z.enum(IMAGE_MODES),
  publishMode: z.enum(PUBLISH_MODES),

  /**
   * 0 is deliberate and supported: no pre-generation, the post is produced at
   * publish time (JIT). Any value ≥ 1 keeps that many slots generated ahead.
   */
  postsBuffer: z.number().int().min(0).max(50),
  /** 0 = no topic bank; a topic is requested from the model just in time. */
  topicsBufferMin: z.number().int().min(0).max(500),
  /** How long before a slot generation starts. Ignored when postsBuffer = 0. */
  leadTimeMinutes: z.number().int().min(0).max(7 * 24 * 60),
  missPolicy: z.enum(MISS_POLICIES),

  /** One switch for the journal; off by default (prompts and output are bulky). */
  logEnabled: z.boolean(),
  logRetentionDays: z.number().int().min(1).max(365),

  schedule: scheduleSchema,
} as const;

export const projectInputSchema = z.object({
  ...projectFields,
  status: projectFields.status.default('paused'),
  timezone: projectFields.timezone.default('Europe/Kyiv'),
  language: projectFields.language.default('uk'),
  persona: projectFields.persona.default(''),
  imageStyle: projectFields.imageStyle.default(''),
  hashtags: projectFields.hashtags.default([]),
  telegramBotToken: z.string().min(20).optional(),
  adminChatId: projectFields.adminChatId.optional(),
  apiKeyId: projectFields.apiKeyId.optional(),
  imageMode: projectFields.imageMode.default('svg'),
  publishMode: projectFields.publishMode.default('auto'),
  postsBuffer: projectFields.postsBuffer.default(3),
  topicsBufferMin: projectFields.topicsBufferMin.default(10),
  leadTimeMinutes: projectFields.leadTimeMinutes.default(180),
  missPolicy: projectFields.missPolicy.default('publish_late'),
  logEnabled: projectFields.logEnabled.default(false),
  logRetentionDays: projectFields.logRetentionDays.default(7),
  schedule: projectFields.schedule.default(defaultSchedule),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

/**
 * Slug is immutable after creation: it appears in logs, jobs and dedupe keys.
 * Every other field is optional and carries no default, so an absent key means
 * "leave it alone" rather than "reset it".
 */
export const projectUpdateSchema = z
  .object(projectFields)
  .omit({ slug: true })
  .partial()
  .extend({
    /**
     * An empty string means "keep the stored token". The edit form never
     * receives the real secret, so it submits `''` whenever the operator
     * changes other fields without retyping it.
     */
    telegramBotToken: z.union([z.literal(''), z.string().min(20)]).optional(),
  });
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

/**
 * What the API returns for a project. The bot token is present only as a mask —
 * the plaintext never leaves the server, not even for the admin UI.
 */
export const projectDtoSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(PROJECT_STATUSES),
  timezone: z.string(),
  language: z.string(),
  persona: z.string(),
  imageStyle: z.string(),
  hashtags: z.array(z.string()),

  telegramChannelId: z.string(),
  telegramChannelUsername: z.string().nullable(),
  botTokenMask: z.string().nullable(),
  adminChatId: z.string().nullable(),
  apiKeyId: z.string().uuid().nullable(),

  imageMode: z.enum(IMAGE_MODES),
  publishMode: z.enum(PUBLISH_MODES),
  postsBuffer: z.number().int(),
  topicsBufferMin: z.number().int(),
  leadTimeMinutes: z.number().int(),
  missPolicy: z.enum(MISS_POLICIES),
  logEnabled: z.boolean(),
  logRetentionDays: z.number().int(),
  schedule: scheduleSchema,

  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

/**
 * Result of probing the channel with the project's bot. `problems` is the
 * actionable part — each entry is a sentence the operator can act on.
 */
export const telegramCheckSchema = z.object({
  ok: z.boolean(),
  bot: z
    .object({ id: z.number(), username: z.string().nullable(), firstName: z.string() })
    .nullable(),
  chat: z
    .object({
      id: z.number(),
      type: z.string(),
      title: z.string().nullable(),
      username: z.string().nullable(),
    })
    .nullable(),
  /** The bot is an administrator of the channel with posting rights. */
  canPost: z.boolean(),
  problems: z.array(z.string()),
});
export type TelegramCheck = z.infer<typeof telegramCheckSchema>;

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
});
export type ModelChainStep = z.infer<typeof modelChainStepSchema>;

export const modelChainSchema = z.object({
  action: z.enum(AI_ACTIONS),
  enabled: z.boolean().default(true),
  /** Tried in order; a rate-limited or circuit-broken step is skipped instantly. */
  steps: z.array(modelChainStepSchema).min(1).max(10),
});
export type ModelChain = z.infer<typeof modelChainSchema>;

/* ── API keys ─────────────────────────────────────────────────────────────── */

export const apiKeyInputSchema = z.object({
  provider: z.enum(AI_PROVIDERS).default('gemini'),
  label: z.string().min(1).max(120),
  secret: z.string().min(10),
  /** Used whenever nothing more specific is chosen. */
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Batch tier: half price, up to 24 h. Paid keys only. */
  batchEnabled: z.boolean().default(false),
  /** Proactive per-minute ceiling. null = react to 429 only. */
  rpmLimit: z.number().int().min(1).max(10_000).nullable().default(null),
  dailyRequestBudget: z.number().int().min(1).max(1_000_000).nullable().default(null),
});
export type ApiKeyInput = z.infer<typeof apiKeyInputSchema>;

/** Same reasoning as projectUpdateSchema: no defaults on a partial update. */
export const apiKeyUpdateSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    label: z.string().min(1).max(120),
    isDefault: z.boolean(),
    enabled: z.boolean(),
    batchEnabled: z.boolean(),
    rpmLimit: z.number().int().min(1).max(10_000).nullable(),
    dailyRequestBudget: z.number().int().min(1).max(1_000_000).nullable(),
  })
  .partial()
  .extend({ secret: z.union([z.literal(''), z.string().min(10)]).optional() });
export type ApiKeyUpdate = z.infer<typeof apiKeyUpdateSchema>;

export const apiKeyDtoSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(AI_PROVIDERS),
  label: z.string(),
  /** Stable number shown everywhere a key is chosen: «Ключ 2». */
  slot: z.number().int(),
  secretMask: z.string(),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  batchEnabled: z.boolean(),
  rpmLimit: z.number().int().nullable(),
  dailyRequestBudget: z.number().int().nullable(),
  /** Today's counters, so budget pressure is visible before it bites. */
  usageToday: z.object({ requests: z.number(), inputTokens: z.number(), outputTokens: z.number() }),
  blockedModels: z.array(z.object({ model: z.string(), blockedUntil: z.string() })),
  createdAt: z.string(),
});
export type ApiKeyDto = z.infer<typeof apiKeyDtoSchema>;

export const modelInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  inputTokenLimit: z.number(),
  outputTokenLimit: z.number(),
  supportsText: z.boolean(),
  supportsImage: z.boolean(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

/* ── generation config (chains + prompts) ─────────────────────────────────── */

export const chainStepInputSchema = z.object({
  provider: z.enum(AI_PROVIDERS).default('gemini'),
  model: z.string().min(1),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
      thinkingBudget: z.number().int().min(0).optional(),
    })
    .default({}),
  promptId: z.string().uuid().nullable().default(null),
});
export type ChainStepInput = z.infer<typeof chainStepInputSchema>;

/**
 * One action's effective configuration, plus where each part came from — the UI
 * renders "Успадковано з глобальних" from these flags rather than guessing.
 */
export const actionConfigSchema = z.object({
  action: z.enum(AI_ACTIONS),
  steps: z.array(chainStepInputSchema),
  /** null = inherit the project key, which in turn may inherit the default. */
  apiKeyId: z.string().uuid().nullable(),
  /** Which level actually supplies the key, for showing it without guessing. */
  keyLevel: z.enum(KEY_LEVELS),
  keyLabel: z.string().nullable(),
  chainInherited: z.boolean(),
  prompt: z.object({
    body: z.string(),
    version: z.number().int(),
    scope: z.enum(PROMPT_SCOPES),
  }),
  promptInherited: z.boolean(),
});
export type ActionConfig = z.infer<typeof actionConfigSchema>;

export const saveActionConfigSchema = z.object({
  steps: z.array(chainStepInputSchema).min(1).max(10).optional(),
  promptBody: z.string().min(1).max(20_000).optional(),
  /** `null` clears the action override; omitted leaves it as is. */
  apiKeyId: z.string().uuid().nullable().optional(),
});

/* ── dry run ──────────────────────────────────────────────────────────────── */

/**
 * A dry run is the configured chain, run for real, and nothing else.
 *
 * It deliberately takes no model: picking one by hand tested a setup that
 * generation would never use, so a green result proved nothing about the thing
 * being configured. The chain is the unit that matters — first model, next one
 * if that is rate limited or down.
 */
export const dryRunInputSchema = z.object({
  action: z.enum(AI_ACTIONS),
  variables: z.record(z.string(), z.string()).default({}),
});
export type DryRunInput = z.infer<typeof dryRunInputSchema>;

export const chainAttemptSchema = z.object({
  position: z.number().int(),
  model: z.string(),
  keyLabel: z.string(),
  keyLevel: z.enum(KEY_LEVELS),
  outcome: z.enum(['success', 'rate_limited', 'auth_failed', 'invalid', 'error', 'skipped']),
  detail: z.string().optional(),
  retryAt: z.string().optional(),
  durationMs: z.number().optional(),
});
export type ChainAttemptDto = z.infer<typeof chainAttemptSchema>;

export const dryRunResultSchema = z.object({
  ok: z.boolean(),
  text: z.string().nullable(),
  model: z.string().nullable(),
  promptScope: z.enum(PROMPT_SCOPES).nullable(),
  promptVersion: z.number().int().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable(),
  attempts: z.array(chainAttemptSchema),
  error: z.string().nullable(),
  renderedPrompt: z.string().nullable(),
});
export type DryRunResult = z.infer<typeof dryRunResultSchema>;

/* ── activity log ─────────────────────────────────────────────────────────────── */

export const logEntrySchema = z.object({
  id: z.string().uuid(),
  postId: z.string().uuid().nullable(),
  kind: z.enum(LOG_KINDS),
  action: z.enum(AI_ACTIONS).nullable(),
  model: z.string().nullable(),
  keyLabel: z.string().nullable(),
  source: z.enum(LOG_SOURCES).nullable(),
  message: z.string(),
  detail: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  ok: z.boolean(),
  createdAt: z.string(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/* ── topics ───────────────────────────────────────────────────────────────── */

export const topicDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  normalizedHash: z.string(),
  category: z.string().nullable(),
  status: z.enum(TOPIC_STATUSES),
  source: z.enum(TOPIC_SOURCES),
  usedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TopicDto = z.infer<typeof topicDtoSchema>;

export const topicsPageSchema = z.object({
  topics: z.array(topicDtoSchema),
  counts: z.object({
    /** Unclaimed topics — the number the replenish threshold compares against. */
    fresh: z.number().int(),
    queued: z.number().int(),
    used: z.number().int(),
    rejected: z.number().int(),
    total: z.number().int(),
  }),
});
export type TopicsPage = z.infer<typeof topicsPageSchema>;

/** Free-text import: one title per line, optional `category | title` prefix. */
export const topicsImportSchema = z.object({
  text: z.string().min(1).max(50_000),
});

export const replenishInputSchema = z.object({
  count: z.number().int().min(1).max(50).default(20),
});

export const replenishReportSchema = z.object({
  requested: z.number().int(),
  generated: z.number().int(),
  inserted: z.number().int(),
  duplicates: z.number().int(),
  titles: z.array(z.string()),
  model: z.string(),
});
export type ReplenishReportDto = z.infer<typeof replenishReportSchema>;

/* ── posts ────────────────────────────────────────────────────────────────── */

export const postDtoSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  status: z.enum(POST_STATUSES),
  scheduledAt: z.string(),
  publishedAt: z.string().nullable(),
  topicTitle: z.string().nullable(),
  /** null once published — only the permalink survives (ADR 0002). */
  textHtml: z.string().nullable(),
  imageKind: z.string().nullable(),
  hasImage: z.boolean(),
  permalink: z.string().nullable(),
  error: z.string().nullable(),
  generation: z.object({
    model: z.string().nullable(),
    promptVersion: z.number().int().nullable(),
    visibleLength: z.number().int().nullable(),
    /** Markup the sanitiser stripped — makes silent rewriting visible. */
    removedTags: z.array(z.string()),
    generatedAt: z.string().nullable(),
  }),
  updatedAt: z.string(),
});
export type PostDto = z.infer<typeof postDtoSchema>;

export const postsPageSchema = z.object({
  posts: z.array(postDtoSchema),
  counts: z.record(z.string(), z.number()),
});
export type PostsPage = z.infer<typeof postsPageSchema>;

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
