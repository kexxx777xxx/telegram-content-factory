/**
 * Domain enumerations shared by the server (Drizzle pgEnum) and the web UI.
 * The arrays are the single source of truth — Drizzle enums and zod schemas are
 * both built from them, so adding a value here propagates everywhere.
 */

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** How a project's post illustration is produced. */
export const IMAGE_MODES = ['svg', 'image_model', 'none'] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

/** `approval` routes every ready post through the admin bot before publishing. */
export const PUBLISH_MODES = ['auto', 'approval'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** What to do when a slot arrives and the post is not ready. */
export const MISS_POLICIES = ['publish_late', 'skip'] as const;
export type MissPolicy = (typeof MISS_POLICIES)[number];

export const SCHEDULE_MODES = ['slots', 'interval'] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/**
 * planned    — slot reserved, nothing generated yet
 * generating — a worker holds it
 * ready      — text + image staged, waiting for its slot
 * awaiting_approval — ready, but publish_mode=approval and no verdict yet
 * publishing — being sent to Telegram
 * published  — sent; text/svg/file wiped, only permalink remains
 */
export const POST_STATUSES = [
  'planned',
  'generating',
  'ready',
  'awaiting_approval',
  'publishing',
  'published',
  'failed',
  'skipped',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Statuses whose posts still own staged content (text, svg, image file). */
export const BUFFERED_POST_STATUSES = [
  'planned',
  'generating',
  'ready',
  'awaiting_approval',
  'publishing',
] as const;

export const TOPIC_STATUSES = ['new', 'queued', 'used', 'rejected'] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const TOPIC_SOURCES = ['ai', 'manual'] as const;
export type TopicSource = (typeof TOPIC_SOURCES)[number];

/** The five generation actions, each with its own model chain and prompt. */
export const AI_ACTIONS = [
  'topics',
  'post_text',
  'svg',
  'svg_repair',
  /** Writes the prompt for the image model. */
  'image_prompt',
  /** Draws it — a different model family, hence its own chain. */
  'image',
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/** Prompt resolution order: model → project → global. */
export const PROMPT_SCOPES = ['global', 'project', 'model'] as const;
export type PromptScope = (typeof PROMPT_SCOPES)[number];

/**
 * Which key pays for a call is decided by a plain hierarchy, most specific
 * first:
 *
 *   action key  →  project key  →  default key
 *
 * There is no automatic fallback between keys. "The paid key draws images"
 * has to mean exactly that; an implicit fall-through to a cheaper key would
 * make the setting a suggestion. When a key is exhausted the chain moves to
 * the next *model*, which is where an alternative belongs.
 */
/**
 * One vocabulary for everything worth recording about a channel's work.
 *
 * Deliberately not split into "events" and "prompts": an operator asking why a
 * post looks like this reads one timeline — тема з'явилась, буфер поповнився,
 * модель відповіла це, пост пішов у канал — and two half-logs would have to be
 * mentally interleaved every time.
 */
export const LOG_KINDS = [
  'topic_created',
  'topics_replenished',
  'model_request',
  'model_response',
  'generation_step',
  'publish',
  'note',
] as const;
export type LogKind = (typeof LOG_KINDS)[number];

/**
 * Where a batch job stands. `pending` covers every vendor state that is not
 * final, because the queue only ever asks one question: is it worth reading yet.
 */
export const BATCH_STATES = ['pending', 'succeeded', 'failed', 'cancelled', 'expired'] as const;
export type BatchState = (typeof BATCH_STATES)[number];

/** Who caused it: the scheduler or a person pressing a button. */
export const LOG_SOURCES = ['auto', 'manual'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const KEY_LEVELS = ['action', 'project', 'default'] as const;
export type KeyLevel = (typeof KEY_LEVELS)[number];

export const AI_PROVIDERS = ['gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'generate_post',
  'generate_and_publish',
  /**
   * Reserved. Batch results are collected by the job that is waiting for them
   * — it reschedules itself — so nothing enqueues this type today. It stays in
   * the enum because dropping a value from a Postgres enum is a table rewrite,
   * and `IMPLEMENTED_JOB_TYPES` already keeps unhandled types out of the queue.
   */
  'collect_batch',
  'publish_post',
  'replenish_topics',
  'prune',
  'backup',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** The 16:9 canvas every illustration is produced and rendered at. */
export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 675;
export const SVG_VIEWBOX = `0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}`;

/** Telegram hard limits we have to design around. */
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_PHOTO_BYTES_LIMIT = 10 * 1024 * 1024;
