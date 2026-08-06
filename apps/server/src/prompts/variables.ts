import { textBudget } from '@tcf/shared';
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
