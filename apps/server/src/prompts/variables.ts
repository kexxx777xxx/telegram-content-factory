import type { Project } from '../db/schema.js';
import { resolveStyle } from '../services/settings.js';

/**
 * The variables every prompt gets, whatever the action.
 *
 * They used to be passed action by action: `svg` received `{topic, style}` and
 * nothing else, so `{{persona}}` in an illustration prompt silently rendered as
 * an empty string. That made the variable reference a lie — it could only ever
 * list the handful each call site happened to pass, rather than what an
 * operator may actually use. The channel's voice, language and length belong to
 * the channel, not to one action, so they travel with every call and the
 * reference can honestly say «ці доступні скрізь».
 *
 * Action-specific values (`topic`, `existingTopics`, `postText`, …) are added
 * by the call site on top of these.
 */
export async function projectVariables(
  project: Pick<Project, 'persona' | 'language' | 'hashtags' | 'imageStyle' | 'postMaxChars'>,
): Promise<Record<string, string | number>> {
  const hashtags = project.hashtags.join(' ');
  return {
    persona: project.persona,
    language: project.language,
    hashtags,
    style: await resolveStyle(project.imageStyle),
    maxChars: textBudget(project.postMaxChars, hashtags),
  };
}

/**
 * Скільки символів лишається під сам текст.
 *
 * Ліміт стосується повідомлення, а хештеги — його частина: промпт просить
 * дописати їх у кінці, тож пост виходив рівно на їхню довжину більшим за
 * задане число. На типовому ліміті в 1024 це означало підпис, який не влазить
 * у фото, і ще одне повідомлення під ним — з вини налаштування, яке нібито
 * саме це й мало запобігти.
 *
 * Мінімум — 200 символів, нижня межа самого поля: рядок хештегів довший за
 * ліміт лишив би моделі бюджет нуль чи від'ємний.
 */
export function textBudget(postMaxChars: number, hashtags: string): number {
  const tail = hashtags ? hashtags.length + 1 : 0;
  return Math.max(200, postMaxChars - tail);
}
