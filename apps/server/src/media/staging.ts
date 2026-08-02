import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config, env } from '../config.js';
import { db } from '../db/client.js';
import { posts } from '../db/schema.js';
import { logger } from '../logger.js';
import { sql } from 'drizzle-orm';

/**
 * Disk for buffered posts only.
 *
 * A file lives here from generation until the post is published, then it is
 * deleted (ADR 0002). The directory is therefore bounded by
 * `projects × posts_buffer × ~300 KB` and is explicitly not backed up: every
 * byte in it is reproducible by regenerating.
 */

const ROOT = resolve(process.cwd(), env.MEDIA_STAGING_DIR);

export async function ensureStagingDir(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
}

export function stagingPath(postId: string, extension: string): string {
  return join(ROOT, `${postId}.${extension}`);
}

export async function writeStagedImage(
  postId: string,
  data: Buffer,
  extension: string,
): Promise<string> {
  await ensureStagingDir();
  const path = stagingPath(postId, extension);
  await writeFile(path, data);
  return path;
}

export async function removeStagedImage(path: string | null): Promise<void> {
  if (!path) return;
  await rm(path, { force: true }).catch((err: unknown) => {
    logger.warn({ err, path }, 'could not remove staged image');
  });
}

export function stagedImageExists(path: string | null): boolean {
  return Boolean(path && existsSync(path));
}

export interface StagingReport {
  files: number;
  bytes: number;
  orphansRemoved: number;
}

/**
 * Deletes files no live post refers to.
 *
 * Orphans appear when a post is deleted mid-generation or a worker dies between
 * writing the file and recording the path. Without this the directory grows
 * without bound while looking bounded on paper.
 */
export async function sweepStaging(): Promise<StagingReport> {
  await ensureStagingDir();

  const entries = await readdir(ROOT).catch(() => [] as string[]);
  const referenced = new Set(
    (
      await db
        .select({ path: posts.imagePath })
        .from(posts)
        .where(sql`${posts.imagePath} is not null`)
    )
      .map((row) => row.path)
      .filter((path): path is string => path !== null),
  );

  const cutoff = Date.now() - config.retention.stagingOrphanHours * 3_600_000;
  let files = 0;
  let bytes = 0;
  let orphansRemoved = 0;

  for (const entry of entries) {
    const path = join(ROOT, entry);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;

    if (referenced.has(path)) {
      files++;
      bytes += info.size;
      continue;
    }

    // Grace period: a file written seconds ago may belong to a post whose row
    // has not been updated yet.
    if (info.mtimeMs > cutoff) {
      files++;
      bytes += info.size;
      continue;
    }

    await rm(path, { force: true });
    orphansRemoved++;
  }

  if (orphansRemoved > 0) logger.info({ orphansRemoved }, 'staging swept');
  return { files, bytes, orphansRemoved };
}
