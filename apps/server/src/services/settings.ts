import type { AppSettings, AppSettingsDto } from '@tcf/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { BUILTIN_STYLE } from '../prompts/defaults.js';

const DEFAULT_STYLE_KEY = 'default_style';

/**
 * Read on every illustration, written by hand a couple of times a year — so a
 * short cache, invalidated on write, keeps the hot path off the database
 * without ever showing the operator a stale value in the form.
 */
const CACHE_TTL_MS = 30_000;
let cache: { value: AppSettings; expires: number } | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cache && cache.expires > Date.now()) return cache.value;

  const rows = await db.select().from(appSettings);
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const value: AppSettings = { defaultStyle: map.get(DEFAULT_STYLE_KEY) ?? '' };

  cache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Adds what the UI needs to explain an empty field instead of hiding it. */
export async function getSettingsDto(): Promise<AppSettingsDto> {
  return { ...(await getSettings()), builtinStyle: BUILTIN_STYLE };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettingsDto> {
  if (patch.defaultStyle !== undefined) {
    await put(DEFAULT_STYLE_KEY, patch.defaultStyle.trim());
  }
  cache = null;
  return getSettingsDto();
}

async function put(key: string, value: string): Promise<void> {
  // An empty value means "fall back", and a row saying that is indistinguishable
  // from no row at all — so it is deleted rather than stored.
  if (value === '') {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return;
  }
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * What {{style}} becomes for one project: its own field, else the global
 * setting, else the shipped default. The single place this chain is decided.
 */
export async function resolveStyle(projectStyle: string): Promise<string> {
  if (projectStyle.trim()) return projectStyle;
  const { defaultStyle } = await getSettings();
  return defaultStyle || BUILTIN_STYLE;
}

/** Test seam: drops the memoised settings so the next read hits the database. */
export function forgetSettings(): void {
  cache = null;
}
