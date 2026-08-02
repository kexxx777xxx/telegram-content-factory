import { IMAGE_HEIGHT, IMAGE_WIDTH } from '@tcf/shared';

/**
 * A schematic drawn in code, used when every model in the chain failed to
 * produce valid SVG.
 *
 * Its purpose is narrow but important: a slot must never arrive with no image.
 * Publishing text alone would change the channel's format, and skipping the
 * slot loses a publication over a rendering problem. Deterministic output also
 * means this path can never itself fail.
 *
 * The composition varies by topic so consecutive fallbacks do not look
 * identical, but it carries no text — the same rule the model must follow.
 */
export function fallbackSvg(seedText: string): string {
  const seed = hash(seedText);
  const rand = mulberry32(seed);

  const boxes = 3 + (seed % 3);
  const shapes: string[] = [];

  const columnWidth = IMAGE_WIDTH / (boxes + 1);
  for (let i = 0; i < boxes; i++) {
    const w = 150 + Math.floor(rand() * 90);
    const h = 90 + Math.floor(rand() * 70);
    const x = columnWidth * (i + 0.5) + (rand() * 40 - 20);
    const y = IMAGE_HEIGHT / 2 - h / 2 + (rand() * 120 - 60);
    const highlight = HIGHLIGHTS[Math.floor(rand() * HIGHLIGHTS.length)] ?? HIGHLIGHTS[0]!;

    shapes.push(
      `<rect x="${round(x)}" y="${round(y + 8)}" width="${w}" height="${h}" rx="10" fill="${highlight}" opacity="0.55"/>`,
      `<rect x="${round(x)}" y="${round(y)}" width="${w}" height="${h}" rx="10" fill="none" stroke="#1e293b" stroke-width="2.5" stroke-linejoin="round"/>`,
    );

    if (i > 0) {
      const prevX = columnWidth * (i - 0.5) + 170;
      const midY = IMAGE_HEIGHT / 2;
      shapes.push(
        `<path d="M ${round(prevX)} ${round(midY)} C ${round(prevX + 40)} ${round(midY - 18)}, ${round(x - 40)} ${round(midY + 18)}, ${round(x)} ${round(midY)}" fill="none" stroke="#334155" stroke-width="2.5" stroke-linecap="round"/>`,
        `<path d="M ${round(x - 14)} ${round(midY - 7)} L ${round(x)} ${round(midY)} L ${round(x - 14)} ${round(midY + 7)}" fill="none" stroke="#334155" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}">
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#e2e8f0" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="#f8fafc"/>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#grid)"/>
  ${shapes.join('\n  ')}
</svg>`;
}

const HIGHLIGHTS = ['#fde68a', '#bfdbfe', '#a7f3d0'];

function round(value: number): number {
  return Math.round(value);
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG — same topic always yields the same drawing. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
