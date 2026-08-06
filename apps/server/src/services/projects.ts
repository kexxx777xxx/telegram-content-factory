import {
  scheduleSchema,
  type ProjectDto,
  type ProjectInput,
  type ProjectUpdate,
} from '@tcf/shared';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, type Project } from '../db/schema.js';
import { decryptSecret, encryptSecret, maskStoredSecret } from '../crypto/secrets.js';
import { forgetLogSetting } from './activityLog.js';

/** Thrown for conditions the API turns into 4xx rather than 500. */
export class ProjectConflictError extends Error {}
export class ProjectNotFoundError extends Error {}

/**
 * Maps a row to its wire form. The single place that decides what leaves the
 * server — note the token becomes a mask and never a value.
 */
export function toDto(row: Project): ProjectDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    language: row.language,
    persona: row.persona,
    imageStyle: row.imageStyle,
    hashtags: row.hashtags,

    telegramChannelId: row.telegramChannelId,
    telegramChannelUsername: row.telegramChannelUsername,
    botTokenMask: maskStoredSecret(row.telegramBotTokenEnc),
    adminChatId: row.adminChatId,

    apiKeyId: row.apiKeyId,
    imageMode: row.imageMode,
    publishMode: row.publishMode,
    postsBuffer: row.postsBuffer,
    topicsBufferMin: row.topicsBufferMin,
    leadTimeMinutes: row.leadTimeMinutes,
    missPolicy: row.missPolicy,
    postMaxChars: row.postMaxChars,
    batchMode: row.batchMode,
    logEnabled: row.logEnabled,
    logRetentionDays: row.logRetentionDays,
    schedule: scheduleSchema.parse(row.schedule),

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProjects(): Promise<ProjectDto[]> {
  const rows = await db.select().from(projects).orderBy(asc(projects.name));
  return rows.map(toDto);
}

export async function getProject(id: string): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!row) throw new ProjectNotFoundError('Проєкт не знайдено');
  return row;
}

export async function createProject(input: ProjectInput): Promise<ProjectDto> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, input.slug))
    .limit(1);
  if (existing) throw new ProjectConflictError(`Проєкт зі slug «${input.slug}» вже існує`);

  const [row] = await db
    .insert(projects)
    .values({
      slug: input.slug,
      name: input.name,
      status: input.status,
      timezone: input.timezone,
      language: input.language,
      persona: input.persona,
      imageStyle: input.imageStyle,
      hashtags: input.hashtags,
      telegramChannelId: input.telegramChannelId,
      telegramBotTokenEnc: input.telegramBotToken ? encryptSecret(input.telegramBotToken) : null,
      adminChatId: input.adminChatId ?? null,
      apiKeyId: input.apiKeyId ?? null,
      imageMode: input.imageMode,
      publishMode: input.publishMode,
      postsBuffer: input.postsBuffer,
      topicsBufferMin: input.topicsBufferMin,
      leadTimeMinutes: input.leadTimeMinutes,
      missPolicy: input.missPolicy,
      postMaxChars: input.postMaxChars,
      batchMode: input.batchMode,
      logEnabled: input.logEnabled,
      logRetentionDays: input.logRetentionDays,
      schedule: input.schedule,
    })
    .returning();

  if (!row) throw new Error('insert returned no row');
  return toDto(row);
}

export async function updateProject(id: string, patch: ProjectUpdate): Promise<ProjectDto> {
  await getProject(id);

  const values: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };

  if (patch.name !== undefined) values.name = patch.name;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.language !== undefined) values.language = patch.language;
  if (patch.persona !== undefined) values.persona = patch.persona;
  if (patch.imageStyle !== undefined) values.imageStyle = patch.imageStyle;
  if (patch.hashtags !== undefined) values.hashtags = patch.hashtags;
  if (patch.telegramChannelId !== undefined) {
    values.telegramChannelId = patch.telegramChannelId;
    // The cached username belongs to the old channel; re-verification refills it.
    values.telegramChannelUsername = null;
  }
  if (patch.adminChatId !== undefined) values.adminChatId = patch.adminChatId ?? null;
  if (patch.apiKeyId !== undefined) values.apiKeyId = patch.apiKeyId;
  if (patch.imageMode !== undefined) values.imageMode = patch.imageMode;
  if (patch.publishMode !== undefined) values.publishMode = patch.publishMode;
  if (patch.postsBuffer !== undefined) values.postsBuffer = patch.postsBuffer;
  if (patch.topicsBufferMin !== undefined) values.topicsBufferMin = patch.topicsBufferMin;
  if (patch.leadTimeMinutes !== undefined) values.leadTimeMinutes = patch.leadTimeMinutes;
  if (patch.missPolicy !== undefined) values.missPolicy = patch.missPolicy;
  if (patch.postMaxChars !== undefined) values.postMaxChars = patch.postMaxChars;
  if (patch.batchMode !== undefined) values.batchMode = patch.batchMode;
  if (patch.logEnabled !== undefined) values.logEnabled = patch.logEnabled;
  if (patch.logRetentionDays !== undefined) values.logRetentionDays = patch.logRetentionDays;
  if (patch.schedule !== undefined) values.schedule = patch.schedule;

  // An empty string means "leave the stored token alone"; the UI sends that
  // whenever the operator edits other fields without retyping the secret.
  if (patch.telegramBotToken) values.telegramBotTokenEnc = encryptSecret(patch.telegramBotToken);

  const [row] = await db.update(projects).set(values).where(eq(projects.id, id)).returning();
  if (!row) throw new ProjectNotFoundError('Проєкт не знайдено');
  // The chain runner caches the switches for half a minute; a save is the one
  // moment the operator expects them to apply immediately.
  forgetLogSetting(id);
  return toDto(row);
}

export async function deleteProject(id: string): Promise<void> {
  const [row] = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  if (!row) throw new ProjectNotFoundError('Проєкт не знайдено');
}

/** Decrypted token for outbound calls. Never expose the return value. */
export function projectBotToken(row: Project): string | null {
  return row.telegramBotTokenEnc ? decryptSecret(row.telegramBotTokenEnc) : null;
}

export async function cacheChannelUsername(id: string, username: string | null): Promise<void> {
  await db
    .update(projects)
    .set({ telegramChannelUsername: username, updatedAt: new Date() })
    .where(eq(projects.id, id));
}
