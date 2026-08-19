/**
 * Turns model output into markup Telegram will actually accept.
 *
 * The prompt asks for a restricted tag set, but a prompt is a request, not a
 * guarantee — and Telegram rejects the *whole message* on a single unknown tag
 * or unbalanced pair. A post that fails here fails at publish time, hours after
 * generation, so the rules are enforced in code instead.
 */

import { withHashtags } from '@tcf/shared';

/** Telegram's supported tags. Everything else becomes plain text. */
const ALLOWED = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'span',
  'tg-spoiler',
  'a',
  'code',
  'pre',
  'blockquote',
]);

/** Tags models emit for layout; Telegram has no equivalent, so they become newlines. */
const BREAK_TAGS = new Set(['br', 'p', 'div', 'li', 'tr']);

const VOID_TAGS = new Set(['br', 'img', 'hr']);

/** Their content is code, not prose — discard it along with the tag. */
const RAW_CONTENT_TAGS = new Set(['script', 'style']);

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
}

export interface SanitizeResult {
  html: string;
  /** What was removed — surfaced in the editor so silent rewriting is visible. */
  removedTags: string[];
}

export function sanitizeTelegramHtml(input: string): SanitizeResult {
  const out: string[] = [];
  const stack: string[] = [];
  const removed = new Set<string>();

  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out.push(escapeText(input.slice(i)));
      break;
    }

    out.push(escapeText(input.slice(i, lt)));

    const gt = input.indexOf('>', lt);
    if (gt === -1) {
      // A stray '<' with no closing bracket is content, not markup.
      out.push(escapeText(input.slice(lt)));
      break;
    }

    const raw = input.slice(lt, gt + 1);
    const tag = parseTag(raw);
    i = gt + 1;

    if (!tag) {
      out.push(escapeText(raw));
      continue;
    }

    if (BREAK_TAGS.has(tag.name)) {
      removed.add(tag.name);
      if (!tag.closing || tag.name !== 'br') out.push('\n');
      continue;
    }

    // Drop the contents too, not just the wrapper: escaped script source is
    // still noise in a published post.
    if (RAW_CONTENT_TAGS.has(tag.name) && !tag.closing) {
      removed.add(tag.name);
      const end = input.toLowerCase().indexOf(`</${tag.name}`, i);
      i = end === -1 ? input.length : (input.indexOf('>', end) + 1 || input.length);
      continue;
    }

    if (!ALLOWED.has(tag.name)) {
      removed.add(tag.name);
      continue;
    }

    if (tag.closing) {
      // Drop a closing tag with nothing open — Telegram would reject the message.
      const openIndex = stack.lastIndexOf(tag.name);
      if (openIndex === -1) {
        removed.add(`/${tag.name}`);
        continue;
      }
      // Close anything opened inside it, innermost first.
      for (let s = stack.length - 1; s > openIndex; s--) {
        out.push(`</${stack[s]}>`);
      }
      out.push(`</${tag.name}>`);
      stack.splice(openIndex);
      continue;
    }

    if (VOID_TAGS.has(tag.name) || tag.selfClosing) {
      removed.add(tag.name);
      continue;
    }

    const attrs = tag.name === 'a' ? safeHref(tag.attrs) : '';
    // A link with no usable href would render as bare text anyway.
    if (tag.name === 'a' && !attrs) {
      removed.add('a');
      continue;
    }

    out.push(`<${tag.name}${attrs}>`);
    stack.push(tag.name);
  }

  // Anything still open would make Telegram reject the whole message.
  for (let s = stack.length - 1; s >= 0; s--) {
    out.push(`</${stack[s]}>`);
  }

  return {
    html: collapseBlankLines(out.join('')),
    removedTags: [...removed],
  };
}

/**
 * No whitespace is allowed between `<` and the tag name — that is what HTML
 * itself requires, and it is what keeps prose like `if (a < b && c > d)` from
 * being read as a `<b>` element. Getting this wrong silently mangles any post
 * that contains a comparison operator.
 */
function parseTag(raw: string): Tag | null {
  const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>$/.exec(raw);
  if (!match) return null;
  return {
    closing: match[1] === '/',
    name: (match[2] ?? '').toLowerCase(),
    attrs: match[3] ?? '',
    selfClosing: match[4] === '/',
  };
}

/**
 * Only http(s) and tg: links survive. `javascript:` and friends are the reason
 * this is a whitelist rather than a blacklist.
 */
function safeHref(attrs: string): string {
  const match = /href\s*=\s*["']([^"']*)["']/i.exec(attrs);
  const href = match?.[1]?.trim();
  if (!href) return '';
  if (!/^(https?:\/\/|tg:\/\/)/i.test(href)) return '';
  return ` href="${escapeAttr(href)}"`;
}

/**
 * Escapes text for Telegram, leaving entities that are already correct alone.
 *
 * A blanket `&` → `&amp;` would double-escape model output: `Tom &amp; Jerry`
 * becomes `Tom &amp;amp; Jerry`, and the channel shows the raw `&amp;`. Models
 * emit entities constantly, so the `&` of a bare `R&D` and the `&` that opens
 * an existing entity have to be told apart. Only the four entities Telegram
 * understands survive — anything else is literal text and gets escaped.
 */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:lt|gt|quot|amp);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Converted block tags leave runs of blank lines behind. */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Length as Telegram counts it: entities do not count, the rendered text does.
 * Used to decide between a photo caption (1024) and a separate message (4096).
 *
 * Counted in UTF-16 code units — `.length`, not `[...text].length`. Telegram's
 * limits and its `MessageEntity` offsets are both in UTF-16, so an emoji costs
 * two. Counting code points instead undercounts by one per emoji, which is how
 * a caption measured at 1010 arrives as 1040 and the send is rejected at the
 * slot — hours after generation, with nothing left to fall back on.
 */
export function visibleLength(html: string): number {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).length;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Зрізає хвіст із хештегів, який дописала модель.
 *
 * Теги додає код при публікації — рівно ті, що в налаштуваннях проєкту, і
 * завжди в одному місці. Модель усе одно раз у раз пише свої (старі промпти
 * прямо цього й просили), і без цього пост їхав би у канал із двома різними
 * рядками тегів.
 *
 * Межа `(^|\s)` перед решіткою — не косметика: без неї «мова C#» лишалась би
 * без решітки, бо остання лексема тексту виглядає як тег.
 */
export function stripTrailingHashtags(html: string): string {
  return html.replace(/(?:(?:^|[ \t\n])#[^\s#<>]+)+[ \t\n]*$/u, '').trimEnd();
}

/**
 * На скільки символів пост не влазить у ліміт проєкту. `<= 0` — влазить.
 *
 * Рахується разом із хештегами, бо в канал піде саме такий текст. Ліміт — це
 * правило, а не побажання: текст понад нього не зберігається і пост із ним не
 * стає готовим.
 */
export function postOverflow(
  textHtml: string,
  hashtags: string[],
  postMaxChars: number,
): number {
  return visibleLength(withHashtags(textHtml, hashtags)) - postMaxChars;
}
