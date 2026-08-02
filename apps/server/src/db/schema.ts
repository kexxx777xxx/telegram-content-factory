import {
  AI_ACTIONS,
  AI_PROVIDERS,
  IMAGE_MODES,
  JOB_STATUSES,
  JOB_TYPES,
  KEY_PREFERENCES,
  KEY_SCOPES,
  MISS_POLICIES,
  POST_STATUSES,
  PROJECT_STATUSES,
  PROMPT_SCOPES,
  PUBLISH_MODES,
  TOPIC_SOURCES,
  TOPIC_STATUSES,
} from '@tcf/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ── enums ────────────────────────────────────────────────────────────────── */

export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES);
export const imageModeEnum = pgEnum('image_mode', IMAGE_MODES);
export const publishModeEnum = pgEnum('publish_mode', PUBLISH_MODES);
export const missPolicyEnum = pgEnum('miss_policy', MISS_POLICIES);
export const postStatusEnum = pgEnum('post_status', POST_STATUSES);
export const topicStatusEnum = pgEnum('topic_status', TOPIC_STATUSES);
export const topicSourceEnum = pgEnum('topic_source', TOPIC_SOURCES);
export const aiActionEnum = pgEnum('ai_action', AI_ACTIONS);
export const aiProviderEnum = pgEnum('ai_provider', AI_PROVIDERS);
export const promptScopeEnum = pgEnum('prompt_scope', PROMPT_SCOPES);
export const keyScopeEnum = pgEnum('key_scope', KEY_SCOPES);
export const keyPreferenceEnum = pgEnum('key_preference', KEY_PREFERENCES);
export const jobStatusEnum = pgEnum('job_status', JOB_STATUSES);
export const jobTypeEnum = pgEnum('job_type', JOB_TYPES);

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ── projects ─────────────────────────────────────────────────────────────── */

/**
 * One row per Telegram channel. Everything that makes two channels differ —
 * voice, schedule, timezone, model chains, prompts — hangs off this row.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: projectStatusEnum('status').notNull().default('paused'),

    /** IANA zone; all slot maths for this project happens in it, not in a global one. */
    timezone: text('timezone').notNull().default('Europe/Kyiv'),
    language: text('language').notNull().default('uk'),
    persona: text('persona').notNull().default(''),
    hashtags: text('hashtags').array().notNull().default(sql`'{}'::text[]`),

    telegramChannelId: text('telegram_channel_id').notNull(),
    /** Cached from getChat; present only for public channels, drives permalinks. */
    telegramChannelUsername: text('telegram_channel_username'),
    /** AES-256-GCM, never leaves the server unmasked. */
    telegramBotTokenEnc: text('telegram_bot_token_enc'),
    adminChatId: text('admin_chat_id'),

    imageMode: imageModeEnum('image_mode').notNull().default('svg'),
    publishMode: publishModeEnum('publish_mode').notNull().default('auto'),

    /** 0 = just-in-time: nothing is generated before the slot arrives. */
    postsBuffer: integer('posts_buffer').notNull().default(3),
    /** 0 = no topic bank; a topic is requested from the model per post. */
    topicsBufferMin: integer('topics_buffer_min').notNull().default(10),
    leadTimeMinutes: integer('lead_time_minutes').notNull().default(180),
    missPolicy: missPolicyEnum('miss_policy').notNull().default('publish_late'),

    /** Discriminated union validated by `scheduleSchema` in @tcf/shared. */
    schedule: jsonb('schedule').notNull(),

    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('projects_slug_uniq').on(t.slug),
    index('projects_status_idx').on(t.status),
  ],
);

/* ── api keys ─────────────────────────────────────────────────────────────── */

/**
 * Rate limiting and circuit breaking are keyed on the row id here — deliberately
 * per key, with no attempt to guess whether two keys share a billing account.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: aiProviderEnum('provider').notNull().default('gemini'),
    label: text('label').notNull(),
    secretEnc: text('secret_enc').notNull(),
    scope: keyScopeEnum('scope').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    /** Soft cap enforced by the limiter; the shared global key gets the tightest one. */
    dailyRequestBudget: integer('daily_request_budget'),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('api_keys_scope_idx').on(t.scope, t.enabled),
    uniqueIndex('api_keys_project_uniq')
      .on(t.projectId, t.provider)
      .where(sql`${t.scope} = 'project'`),
  ],
);

/* ── prompts ──────────────────────────────────────────────────────────────── */

/**
 * Resolution order is model → project → global. Editing never mutates a row:
 * a new `version` is inserted and the old one stays, because published posts
 * reference the exact version that produced them.
 */
export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: aiActionEnum('action').notNull(),
    scope: promptScopeEnum('scope').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Set only for scope = 'model': applies when that model runs this action. */
    model: text('model'),
    version: integer('version').notNull().default(1),
    body: text('body').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt,
  },
  (t) => [
    index('prompts_lookup_idx').on(t.action, t.scope, t.projectId, t.isActive),
    uniqueIndex('prompts_active_global_uniq')
      .on(t.action, t.version)
      .where(sql`${t.scope} = 'global'`),
  ],
);

/* ── model chains ─────────────────────────────────────────────────────────── */

/** `projectId = null` is the global default chain for that action. */
export const modelChains = pgTable(
  'model_chains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    action: aiActionEnum('action').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('model_chains_scope_uniq').on(t.projectId, t.action)],
);

export const modelChainSteps = pgTable(
  'model_chain_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: uuid('chain_id')
      .notNull()
      .references(() => modelChains.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    provider: aiProviderEnum('provider').notNull().default('gemini'),
    model: text('model').notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    promptId: uuid('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
    keyPreference: keyPreferenceEnum('key_preference').notNull().default('project_then_global'),
  },
  (t) => [uniqueIndex('model_chain_steps_position_uniq').on(t.chainId, t.position)],
);

/* ── topics ───────────────────────────────────────────────────────────────── */

export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Lowercased, transliterated, punctuation-stripped — the real dedup key. */
    normalizedHash: text('normalized_hash').notNull(),
    category: text('category'),
    status: topicStatusEnum('status').notNull().default('new'),
    source: topicSourceEnum('source').notNull().default('ai'),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex('topics_project_hash_uniq').on(t.projectId, t.normalizedHash),
    index('topics_available_idx').on(t.projectId, t.status),
  ],
);

/* ── posts ────────────────────────────────────────────────────────────────── */

/**
 * `textHtml`, `svgSource` and `imagePath` hold content only while the post is
 * still in the buffer. On successful publish they are wiped and the row keeps
 * just metadata plus the permalink — Telegram becomes the archive.
 */
export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    status: postStatusEnum('status').notNull().default('planned'),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    /** Denormalised so history stays readable after the topic row is gone. */
    topicTitle: text('topic_title'),

    textHtml: text('text_html'),
    svgSource: text('svg_source'),
    imagePath: text('image_path'),
    imageKind: text('image_kind'),

    tgMessageId: integer('tg_message_id'),
    permalink: text('permalink'),

    /** Compact: model, prompt_id@version, tokens, attempts. Never raw content. */
    generation: jsonb('generation').notNull().default(sql`'{}'::jsonb`),
    error: text('error'),

    createdAt,
    updatedAt,
  },
  (t) => [
    index('posts_due_idx').on(t.status, t.scheduledAt),
    index('posts_project_idx').on(t.projectId, t.status, t.scheduledAt),
    uniqueIndex('posts_slot_uniq').on(t.projectId, t.scheduledAt),
  ],
);

/* ── jobs ─────────────────────────────────────────────────────────────────── */

/**
 * The queue. Claimed with `FOR UPDATE SKIP LOCKED`; `dedupeKey` makes
 * enqueueing idempotent so a planner tick that runs twice cannot double-book.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: jobTypeEnum('type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    /** Higher runs first; JIT publish jobs jump ahead of buffer refills. */
    priority: integer('priority').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),

    status: jobStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),

    dedupeKey: text('dedupe_key'),

    createdAt,
    updatedAt,
  },
  (t) => [
    index('jobs_claim_idx')
      .on(t.runAfter, t.priority)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex('jobs_dedupe_uniq')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('pending', 'running') and ${t.dedupeKey} is not null`),
    index('jobs_status_idx').on(t.status, t.updatedAt),
  ],
);

/* ── rate limiting ────────────────────────────────────────────────────────── */

/**
 * Token bucket + circuit breaker state, keyed per (key, model). A 429 on one key
 * blocks exactly that pair; other keys keep working even if they turn out to
 * share the same upstream quota — one wasted request beats false blocking.
 */
export const rateLimitState = pgTable(
  'rate_limit_state',
  {
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
    requestsUsed: integer('requests_used').notNull().default(0),
    /** Set from the 429 `retryDelay`; every worker skips the pair until it passes. */
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.apiKeyId, t.model] }),
    index('rate_limit_blocked_idx').on(t.blockedUntil),
  ],
);

/* ── audit ────────────────────────────────────────────────────────────────── */

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (t) => [index('events_recent_idx').on(t.createdAt), index('events_project_idx').on(t.projectId, t.kind)],
);

/* ── inferred types ───────────────────────────────────────────────────────── */

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type ModelChain = typeof modelChains.$inferSelect;
export type ModelChainStep = typeof modelChainSteps.$inferSelect;
export type Topic = typeof topics.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type RateLimitRow = typeof rateLimitState.$inferSelect;
