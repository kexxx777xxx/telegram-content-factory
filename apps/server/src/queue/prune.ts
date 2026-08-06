import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { events, jobs, posts } from '../db/schema.js';
import { sweepStaging } from '../media/staging.js';
import { pruneLogs } from '../services/postLog.js';

export interface PruneReport {
  events: number;
  jobs: number;
  postTexts: number;
  postLogs: number;
  stagingOrphans: number;
}

/**
 * Daily retention pass. Rows in `posts` are never deleted — they are the
 * history and the dedup evidence, and they weigh hundreds of bytes once the
 * content is gone. Only field contents are cleared.
 */
export async function runPrune(): Promise<PruneReport> {
  const { eventDays, jobDays, postTextDays } = config.retention;

  const prunedEvents = await db
    .delete(events)
    .where(sql`${events.createdAt} < now() - make_interval(days => ${eventDays})`)
    .returning({ id: events.id });

  const prunedJobs = await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.status, ['done']),
        sql`${jobs.updatedAt} < now() - make_interval(days => ${jobDays})`,
      ),
    )
    .returning({ id: jobs.id });

  // 0 means the text is wiped at publish time, so there is nothing left to age
  // out here; any positive value keeps it for that many days first.
  let prunedTexts = 0;
  if (postTextDays > 0) {
    const cleared = await db
      .update(posts)
      .set({ textHtml: null, svgSource: null })
      .where(
        and(
          eq(posts.status, 'published'),
          isNotNull(posts.textHtml),
          sql`${posts.publishedAt} < now() - make_interval(days => ${postTextDays})`,
        ),
      )
      .returning({ id: posts.id });
    prunedTexts = cleared.length;
  }

  // Retention here is per project, so the cutoff lives with the log itself.
  const prunedLogs = await pruneLogs();

  // Files whose post row vanished mid-generation; the directory is bounded on
  // paper only if something actually removes them.
  const staging = await sweepStaging();

  return {
    events: prunedEvents.length,
    jobs: prunedJobs.length,
    postTexts: prunedTexts,
    postLogs: prunedLogs,
    stagingOrphans: staging.orphansRemoved,
  };
}
