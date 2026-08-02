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

export const KEY_SCOPES = ['global', 'project'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Which API keys a chain step may spend, and in what order. */
export const KEY_PREFERENCES = [
  'project_then_global',
  'project_only',
  'global_only',
] as const;
export type KeyPreference = (typeof KEY_PREFERENCES)[number];

export const AI_PROVIDERS = ['gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'generate_post',
  'generate_and_publish',
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
