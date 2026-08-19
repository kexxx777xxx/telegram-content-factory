import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  postOverflow,
  sanitizeTelegramHtml,
  stripTrailingHashtags,
  visibleLength,
} from '../src/telegram/html.js';
import { sanitizeSvg, SvgInvalidError } from '../src/media/svg/sanitize.js';
import { fallbackSvg } from '../src/media/svg/fallback.js';
import { normalizeTopic } from '../src/services/ideas.js';
import { computeSlots, projectJitterSeconds } from '../src/scheduler/slots.js';
import { buildPermalink } from '../src/telegram/permalink.js';
import { splitForMessages } from '../src/telegram/publisher.js';
import { TELEGRAM_MESSAGE_LIMIT } from '@tcf/shared';
import { backoffSeconds } from '../src/queue/claim.js';
import { BATCH_DEADLINE_MARGIN_MS, BATCH_MIN_SLACK_MS, BATCH_TURNAROUND_MS } from '../src/ai/batch.js';
import { MIN_REFILL_BATCH, refillCount } from '../src/services/ideas.js';
import { textBudget, withHashtags } from '@tcf/shared';

/** Everything here is pure — no database, no network. */

describe('Telegram HTML sanitizer', () => {
  const clean = (input: string) => sanitizeTelegramHtml(input).html;

  it('keeps the allowed tag set', () => {
    expect(clean('<b>Ж</b> та <i>к</i> і <code>c</code>')).toBe('<b>Ж</b> та <i>к</i> і <code>c</code>');
  });

  it('does not read prose comparisons as markup', () => {
    // The regression that matters: `< b ` used to parse as a <b> element and
    // silently mangled any post containing a comparison operator.
    expect(clean('if (a < b && c > d) { }')).toBe('if (a &lt; b &amp;&amp; c &gt; d) { }');
  });

  it('drops script and style contents, not just the tags', () => {
    expect(clean('До<script>alert(1)</script>Після')).toBe('ДоПісля');
    expect(clean('A<style>.x{color:red}</style>B')).toBe('AB');
  });

  it('balances tags Telegram would reject', () => {
    expect(clean('<b>Забув')).toBe('<b>Забув</b>');
    expect(clean('Текст</b> далі')).toBe('Текст далі');
    expect(clean('<b>ж <i>об</b> к</i>')).toBe('<b>ж <i>об</i></b> к');
  });

  it('allows only http(s) and tg links', () => {
    expect(clean('<a href="javascript:x">клік</a>')).toBe('клік');
    expect(clean('<a href="https://e.com">клік</a>')).toBe('<a href="https://e.com">клік</a>');
  });

  it('reports what it removed so the editor can show it', () => {
    expect(sanitizeTelegramHtml('<div>x</div>').removedTags).toContain('div');
  });

  it('counts length the way Telegram does — entities excluded', () => {
    expect(visibleLength('<b>Привіт</b>, світ!')).toBe('Привіт, світ!'.length);
  });

  /*
   * Telegram's limits are in UTF-16 code units, so an emoji costs two. Counting
   * code points made a caption look shorter than Telegram measures it, and the
   * send was rejected at the slot.
   */
  it('counts an emoji as the two units Telegram charges for it', () => {
    expect(visibleLength('👍')).toBe(2);
    expect(visibleLength('<b>Привіт</b> 👍🎉')).toBe('Привіт 👍🎉'.length);
  });

  it('does not double-escape entities the model already wrote', () => {
    expect(clean('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
    expect(clean('a &lt;b&gt; c')).toBe('a &lt;b&gt; c');
  });

  it('still escapes a bare ampersand', () => {
    expect(clean('R&D')).toBe('R&amp;D');
    expect(clean('a & b &copy; c')).toBe('a &amp; b &amp;copy; c');
  });
});

describe('splitting a long post into messages', () => {
  const within = (parts: string[]) =>
    parts.every((part) => visibleLength(part) <= TELEGRAM_MESSAGE_LIMIT);

  it('keeps a short post whole', () => {
    expect(splitForMessages('коротко')).toEqual(['коротко']);
  });

  it('breaks on paragraph boundaries', () => {
    const paragraph = `${'а'.repeat(3000)}`;
    const parts = splitForMessages(`${paragraph}\n\n${paragraph}`);
    expect(parts).toHaveLength(2);
    expect(within(parts)).toBe(true);
  });

  /*
   * The case that used to escape: one paragraph longer than the limit has no
   * boundary to break on, so it went out whole and Telegram rejected it.
   */
  it('breaks up a single paragraph that exceeds the limit on its own', () => {
    const sentence = `${'слово '.repeat(200)}кінець. `;
    const parts = splitForMessages(sentence.repeat(6));
    expect(parts.length).toBeGreaterThan(1);
    expect(within(parts)).toBe(true);
  });

  it('falls back to word boundaries when sentences are still too long', () => {
    const parts = splitForMessages(`${'слово '.repeat(2000)}`);
    expect(parts.length).toBeGreaterThan(1);
    expect(within(parts)).toBe(true);
  });

  it('refuses rather than truncate when there is no seam at all', () => {
    expect(() => splitForMessages('я'.repeat(TELEGRAM_MESSAGE_LIMIT + 1))).toThrow(/розбити/);
  });

  it('loses no text', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Абзац ${i}. ${'текст '.repeat(150)}`).join('\n\n');
    const parts = splitForMessages(text);
    expect(within(parts)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });
});

describe('SVG sanitizer', () => {
  const wrap = (inner: string, attrs = 'viewBox="0 0 1200 675"') =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

  it('removes filters, which crash the renderer rather than the browser', () => {
    // Not hypothetical: a model produced an feDisplacementMap whose source and
    // map differed in size, resvg asserted in Rust, and the panic aborted the
    // whole server process — queue included.
    const result = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675">
        <defs>
          <filter id="f">
            <feTurbulence baseFrequency="0.05" result="noise"/>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="20"/>
          </filter>
        </defs>
        <rect width="600" height="400" filter="url(#f)"/>
      </svg>
    `);

    expect(result.svg).not.toContain('feDisplacementMap');
    expect(result.svg).not.toContain('<filter');
    expect(result.svg).not.toContain('filter=');
    expect(result.svg).toContain('<rect');
  });

  it('strips executable and external content', () => {
    const result = sanitizeSvg(wrap('<rect/><script>x</script><image href="http://e/x.png"/>'));
    expect(result.svg).not.toContain('script');
    expect(result.svg).not.toContain('<image');
  });

  /*
   * The attribute pass only sees attribute values; a stylesheet reaches outside
   * the document from inside a text node, where it never looked.
   */
  it('removes stylesheets, which the attribute pass cannot inspect', () => {
    const result = sanitizeSvg(
      wrap('<style>@import url(http://evil/x.css); rect { fill: url(http://evil/y) }</style><rect/>'),
    );
    expect(result.removed).toContain('style');
    expect(result.svg).not.toContain('evil');
    expect(result.svg).toContain('<rect');
  });

  it('enforces the no-text rule structurally', () => {
    const result = sanitizeSvg(wrap('<text x="1" y="1">Ні</text><path d="M0 0"/>'));
    expect(result.svg).not.toContain('<text');
    expect(result.removed).toContain('text');
  });

  it('keeps internal fragment references so gradients survive', () => {
    const result = sanitizeSvg(wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>'));
    expect(result.svg).toContain('url(#g)');
  });

  it('rewrites a wrong viewBox instead of rejecting the drawing', () => {
    const result = sanitizeSvg(wrap('<rect/>', 'viewBox="0 0 800 600"'));
    expect(result.svg).toContain('viewBox="0 0 1200 675"');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects DOCTYPE even though the wrapper stripper would hide it', () => {
    // The check has to run on the raw input: slicing from `<svg` cuts the
    // DOCTYPE off, which is how every XXE payload used to pass.
    expect(() =>
      sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + wrap('<rect/>')),
    ).toThrow(SvgInvalidError);
  });

  it('rejects malformed XML that the parser alone would accept', () => {
    expect(() => sanitizeSvg('<svg viewBox="0 0 1200 675"><rect></svg>')).toThrow(SvgInvalidError);
  });

  it('unwraps markdown fences and surrounding prose', () => {
    expect(sanitizeSvg('Ось схема:\n```svg\n' + wrap('<rect/>') + '\n```\nГотово').svg).toMatch(
      /^<svg/,
    );
  });
});

describe('fallback schematic', () => {
  it('is deterministic per topic and differs across topics', () => {
    expect(fallbackSvg('тема А')).toBe(fallbackSvg('тема А'));
    expect(fallbackSvg('тема А')).not.toBe(fallbackSvg('тема Б'));
  });

  it('obeys the same no-text rule and survives the sanitizer', () => {
    const svg = fallbackSvg('Circuit Breaker');
    expect(svg).not.toMatch(/<text|<tspan/);
    expect(sanitizeSvg(svg).removed).toHaveLength(0);
  });
});

describe('topic normalisation', () => {
  it('ignores word order and Ukrainian declension', () => {
    const keys = new Set(
      [
        'Circuit Breaker у мікросервісах',
        'Мікросервіси та Circuit Breaker',
        'Патерн Circuit Breaker мікросервіси',
      ].map(normalizeTopic),
    );
    expect(keys.size).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(normalizeTopic('Saga-патерн: чому він не рятує')).toBe(
      normalizeTopic('SAGA ПАТЕРН, чому він не рятує!'),
    );
  });

  it('keeps genuinely different topics apart', () => {
    expect(normalizeTopic('Ідемпотентність у чергах')).not.toBe(
      normalizeTopic('Ідемпотентність у базах даних'),
    );
  });
});

describe('slot arithmetic', () => {
  const tz = 'Europe/Kyiv';
  const at = (d: Date) => DateTime.fromJSDate(d, { zone: tz }).toFormat('yyyy-LL-dd HH:mm');

  it('produces increasing, unique slots strictly after the cursor', () => {
    const from = new Date('2026-08-02T10:00:00Z');
    const slots = computeSlots(
      { mode: 'slots', slots: ['09:00', '13:00', '18:00'], weekdays: [] },
      tz,
      from,
      10,
    );
    expect(slots).toHaveLength(10);
    expect(slots.every((s) => s > from)).toBe(true);
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(10);
    expect(slots.every((s, i) => i === 0 || s > slots[i - 1]!)).toBe(true);
  });

  it('honours the weekday filter', () => {
    const slots = computeSlots(
      { mode: 'slots', slots: ['09:00'], weekdays: [1, 2, 3, 4, 5] },
      tz,
      new Date('2026-08-07T12:00:00Z'),
      3,
    );
    // 2026-08-08 is a Saturday, so the next weekday slot is Monday the 10th.
    expect(at(slots[0]!)).toBe('2026-08-10 09:00');
  });

  it('moves a slot inside the spring-forward gap to the next real moment', () => {
    // 2026-03-29: Kyiv jumps 03:00 → 04:00, so 03:30 does not exist that day.
    const slots = computeSlots(
      { mode: 'slots', slots: ['03:30'], weekdays: [] },
      tz,
      new Date('2026-03-28T12:00:00Z'),
      2,
    );
    expect(at(slots[0]!)).toBe('2026-03-29 04:30');
    expect(at(slots[1]!)).toBe('2026-03-30 03:30');
  });

  it('fires the repeated autumn hour once, not twice', () => {
    // 2026-10-25: the 03:00 hour happens twice in Kyiv.
    const slots = computeSlots(
      { mode: 'slots', slots: ['03:30'], weekdays: [] },
      tz,
      new Date('2026-10-24T12:00:00Z'),
      3,
    );
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(3);
    expect(at(slots[0]!)).toBe('2026-10-25 03:30');
  });

  it('walks interval schedules forward from the anchor', () => {
    const slots = computeSlots(
      { mode: 'interval', intervalMinutes: 360, anchor: '10:00' },
      tz,
      new Date('2026-08-02T11:30:00Z'),
      2,
    );
    expect(at(slots[0]!)).toBe('2026-08-02 16:00');
    expect(at(slots[1]!)).toBe('2026-08-02 22:00');
  });

  it('derives a stable per-project offset', () => {
    const id = 'f2548fc8-e10d-4d51-b92a-8810c606da29';
    // Randomness here would break planner idempotency: every tick would compute
    // a different run_after for the same slot.
    expect(projectJitterSeconds(id)).toBe(projectJitterSeconds(id));
    expect(projectJitterSeconds(id)).not.toBe(projectJitterSeconds('other-id'));
  });
});

describe('permalinks', () => {
  it('prefers the public form', () => {
    expect(buildPermalink('@sysarch_ua', null, 42)).toBe('https://t.me/sysarch_ua/42');
    expect(buildPermalink('-1001234567890', 'my_channel', 7)).toBe('https://t.me/my_channel/7');
  });

  it('falls back to the private form', () => {
    expect(buildPermalink('-1001234567890', null, 15)).toBe('https://t.me/c/1234567890/15');
  });

  it('returns null rather than inventing a link', () => {
    expect(buildPermalink('12345', null, 1)).toBeNull();
  });
});

describe('retry backoff', () => {
  it('grows exponentially and stops at half an hour', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(20)).toBe(1800);
  });
});

describe('batch tier', () => {
  it('лишає час і на очікування, і на відкат до звичайного виклику', () => {
    // Поріг у 26 годин (стеля вендора + запас) не спрацьовував ніколи: буфер
    // планує `postsBuffer` слотів уперед, і найдальший з них ближче за добу.
    // Тепер поріг менший за стелю — свідомо, бо від повільного batch береже
    // дедлайн, а не очікування. Але вікно на саме очікування має лишатись.
    expect(BATCH_MIN_SLACK_MS).toBeLessThan(BATCH_TURNAROUND_MS);
    expect(BATCH_MIN_SLACK_MS - BATCH_DEADLINE_MARGIN_MS).toBeGreaterThanOrEqual(2 * 3600_000);
  });
});

describe('topic refill', () => {
  it('tops the bank up to its minimum, not by a token amount', () => {
    // The complaint this answers: "менше 50 — поповниться на 1 чи до 50?".
    expect(refillCount(20, 50)).toBe(30);
  });

  it('never spends a whole model call on a single topic', () => {
    // 49 of 50 needs one topic; asking for one would burn a request and hit the
    // same threshold again tomorrow.
    expect(refillCount(49, 50)).toBe(MIN_REFILL_BATCH);
  });
});

describe('бюджет символів під текст', () => {
  it('віднімає рівно той хвіст, який допишеться при публікації', () => {
    // 1024 — ліміт підпису під фото: пост із хвостом хештегів рівно на їхню
    // довжину не влазив у нього і їхав другим повідомленням. Віднімається саме
    // `withHashtags`, інакше бюджет був би щедрішим за правило, яке потім
    // відхиляє текст рівно на цю різницю.
    expect(textBudget(1024, ['#їжа', '#рецепт'])).toBe(1024 - '\n\n#їжа #рецепт'.length);
  });

  it('без хештегів віддає весь ліміт', () => {
    expect(textBudget(1024, [])).toBe(1024);
  });

  it('не опускається нижче нижньої межі поля', () => {
    // Рядок хештегів довший за ліміт лишив би моделі нуль або від'ємне число.
    expect(textBudget(220, ['#' + 'а'.repeat(300)])).toBe(200);
  });
});

describe('хештеги дописує код', () => {
  it('ставить їх окремим абзацом у кінці', () => {
    expect(withHashtags('Текст', ['#а', '#б'])).toBe('Текст\n\n#а #б');
  });

  it('без хештегів не чіпає текст', () => {
    expect(withHashtags('Текст', [])).toBe('Текст');
  });

  it('зрізає теги, які модель дописала сама', () => {
    // Промпт просить їх не писати, але старі промпти просили навпаки — без
    // цього пост поїхав би у канал із двома рядками тегів.
    expect(stripTrailingHashtags('Текст\n\n#моделін #теги')).toBe('Текст');
    expect(stripTrailingHashtags('Текст без тегів')).toBe('Текст без тегів');
  });

  it('не приймає решітку всередині слова за тег', () => {
    // «мова C#» лишалась би без решітки, якби межа перед тегом не перевірялась.
    expect(stripTrailingHashtags('улюблена мова — C#')).toBe('улюблена мова — C#');
  });
});

describe('ліміт довжини поста', () => {
  it('рахує текст разом із хештегами', () => {
    // Ліміт стосується повідомлення в каналі, а туди йде текст із хвостом.
    expect(postOverflow('а'.repeat(300), ['#тег'], 310)).toBe(300 + '\n\n#тег'.length - 310);
    expect(postOverflow('а'.repeat(300), [], 310)).toBeLessThanOrEqual(0);
  });

  it('не рахує розмітку, яку читач не бачить', () => {
    // Ті самі правила, що й у `visibleLength`: інакше пост із <b> відхилявся б
    // за символи, яких у каналі немає.
    expect(postOverflow('<b>' + 'а'.repeat(100) + '</b>', [], 100)).toBe(0);
  });
});
