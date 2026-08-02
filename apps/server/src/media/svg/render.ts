import { Resvg } from '@resvg/resvg-js';
import { IMAGE_HEIGHT, IMAGE_WIDTH, TELEGRAM_PHOTO_BYTES_LIMIT } from '@tcf/shared';
import sharp from 'sharp';

/**
 * Rasterises SVG for Telegram, which does not accept vector images.
 *
 * `resvg` rather than a headless browser: rendering takes milliseconds, has no
 * network stack, and cannot be talked into fetching anything — which matters
 * for markup a language model wrote.
 */

/** Rendered at 2× and downscaled; thin pencil strokes alias badly at 1×. */
const SUPERSAMPLE = 2;

export interface RenderedImage {
  data: Buffer;
  width: number;
  height: number;
  extension: 'png';
}

export class SvgRenderError extends Error {}

export async function renderSvgToPng(svg: string): Promise<RenderedImage> {
  let raw: Buffer;
  try {
    const resvg = new Resvg(svg, {
      background: '#f8fafc',
      fitTo: { mode: 'width', value: IMAGE_WIDTH * SUPERSAMPLE },
      // No remote fetching, ever. The sanitizer already strips external
      // references; this is the second lock on the same door.
      font: { loadSystemFonts: false },
    });
    raw = Buffer.from(resvg.render().asPng());
  } catch (err) {
    throw new SvgRenderError(`Не вдалося растеризувати SVG: ${err instanceof Error ? err.message : err}`);
  }

  const data = await sharp(raw)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'center' })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  return assertPublishable(data);
}

/** Normalises whatever an image model returned into the same 16:9 PNG contract. */
export async function normaliseModelImage(input: Buffer): Promise<RenderedImage> {
  const data = await sharp(input)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'center' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return assertPublishable(data);
}

function assertPublishable(data: Buffer): RenderedImage {
  if (data.byteLength > TELEGRAM_PHOTO_BYTES_LIMIT) {
    throw new SvgRenderError(
      `Зображення ${data.byteLength} байт перевищує ліміт sendPhoto (${TELEGRAM_PHOTO_BYTES_LIMIT})`,
    );
  }
  return { data, width: IMAGE_WIDTH, height: IMAGE_HEIGHT, extension: 'png' };
}
