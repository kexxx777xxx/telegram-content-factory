import { closeDatabase, db } from '../src/db/client.js';
import { projects } from '../src/db/schema.js';
import { logger } from '../src/logger.js';
import { createProject } from '../src/services/projects.js';

/**
 * Two demo projects that differ in the axes that actually change behaviour:
 * buffered vs just-in-time, SVG vs image model, and different timezones — so a
 * single planner tick has to handle both paths.
 *
 * No bot tokens: publishing stays impossible until a real token is entered,
 * which is the point. Safe to run against a dev database only.
 */
async function main() {
  const existing = await db.select({ id: projects.id }).from(projects).limit(1);
  if (existing.length > 0) {
    logger.warn('база не порожня — сід пропущено, щоб не змішати демо з реальними проєктами');
    await closeDatabase();
    return;
  }

  const buffered = await createProject({
    name: 'Системна архітектура',
    slug: 'demo-architecture',
    status: 'paused',
    timezone: 'Europe/Kyiv',
    language: 'uk',
    persona:
      'Досвідчений системний архітектор. Пише колегіально, без води й маркетингу, ' +
      'спирається на реальні компроміси, а не на «best practices» загалом.',
    hashtags: ['#архітектура', '#системнийдизайн'],
    telegramChannelId: '@demo_architecture',
    adminChatId: null,
    imageMode: 'svg',
    publishMode: 'auto',
    postsBuffer: 3,
    topicsBufferMin: 10,
    leadTimeMinutes: 180,
    missPolicy: 'publish_late',
    logEnabled: false,
    logRetentionDays: 7,
    schedule: { mode: 'slots', slots: ['09:00', '13:00', '18:00'], weekdays: [] },
  });

  const jit = await createProject({
    name: 'Продуктові нотатки',
    slug: 'demo-product',
    status: 'paused',
    timezone: 'Europe/Warsaw',
    language: 'uk',
    persona: 'Продуктовий менеджер. Коротко, з прикладами й без жаргону.',
    hashtags: ['#продукт'],
    telegramChannelId: '@demo_product',
    adminChatId: null,
    imageMode: 'image_model',
    publishMode: 'approval',
    // 0 — генерація в момент публікації; протилежний до buffered шлях планувальника.
    postsBuffer: 0,
    topicsBufferMin: 0,
    leadTimeMinutes: 0,
    missPolicy: 'skip',
    logEnabled: false,
    logRetentionDays: 7,
    schedule: { mode: 'interval', intervalMinutes: 360, anchor: '10:00' },
  });

  logger.info({ projects: [buffered.slug, jit.slug] }, 'demo projects created');
  logger.info('токени ботів не задані — вкажіть їх в адмінці перед публікацією');
  await closeDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'seed failed');
  await closeDatabase().catch(() => {});
  process.exit(1);
});
