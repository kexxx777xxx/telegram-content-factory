import { IMAGE_HEIGHT, IMAGE_WIDTH, SVG_VIEWBOX } from '@tcf/shared';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Makes model-produced SVG safe and consistent.
 *
 * Two separate jobs, both deliberately done in code rather than asked for in
 * the prompt:
 *
 *   1. Security. The result is rendered server-side *and* shown inline in the
 *      admin UI, so a `<script>` or an external `href` would execute in a page
 *      that holds bot tokens.
 *   2. House style. The "no text inside the graphic" rule and the fixed 16:9
 *      viewBox are product requirements; a model follows them most of the time,
 *      and "most of the time" is not a rule.
 */

const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'animate',
  'set',
  'handler',
  'use', // can reference external documents
  'image', // raster payloads have no place in a vector schematic

  /*
   * Filters are removed because of what they do to the *renderer*, not to the
   * browser. A model emitted a `<feDisplacementMap>` whose source and map had
   * different sizes; resvg asserts on that in Rust, and a Rust panic inside a
   * native addon aborts the whole Node process — one malformed schematic took
   * the server down, queue and all. Filters add nothing to a flat schematic,
   * so the cheap fix is also the right one.
   */
  'filter',
  'fedisplacementmap',
  'fegaussianblur',
  'feturbulence',
  'feimage',
  'femorphology',
  'feconvolvematrix',
  'fedropshadow',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'feflood',
  'feoffset',
  'fetile',
  'fediffuselighting',
  'fespecularlighting',
  'fecomponenttransfer',
  'femerge',
]);

/** Attributes that point at a filter; dropped with the filters themselves. */
const FORBIDDEN_ATTRS = new Set(['filter']);

/** The no-text rule from the PRD, enforced structurally. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textpath', 'tref', 'altglyph']);

const ATTR_PREFIX = '@_';

export interface SvgSanitizeResult {
  svg: string;
  removed: string[];
  warnings: string[];
}

export class SvgInvalidError extends Error {}

/** Guards against a model emitting a megabyte of paths. */
const MAX_BYTES = 512 * 1024;
const MAX_NODES = 4000;

export function sanitizeSvg(input: string): SvgSanitizeResult {
  if (input.length > MAX_BYTES) {
    throw new SvgInvalidError(`SVG завеликий: ${input.length} байт при ліміті ${MAX_BYTES}`);
  }

  /*
   * Checked on the raw input, before the wrapper is stripped.
   *
   * Slicing from `<svg` would cut a DOCTYPE off and hide it, so an earlier
   * version of this check silently passed every XXE payload. Entity
   * declarations are the vector; reject the document rather than clean it.
   */
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) {
    throw new SvgInvalidError('SVG містить DOCTYPE або ENTITY');
  }

  const stripped = stripWrapper(input);

  /*
   * fast-xml-parser is lenient by design and happily accepts unclosed tags, so
   * `parse()` succeeding proves nothing. The validator is what actually rejects
   * malformed markup — and malformed markup is exactly what the repair step
   * exists to fix.
   */
  const validation = XMLValidator.validate(stripped, { allowBooleanAttributes: true });
  if (validation !== true) {
    throw new SvgInvalidError(`SVG не є коректним XML: ${validation.err.msg} (рядок ${validation.err.line})`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    preserveOrder: true,
    allowBooleanAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });

  let tree: unknown;
  try {
    tree = parser.parse(stripped);
  } catch (err) {
    throw new SvgInvalidError(`SVG не парситься як XML: ${err instanceof Error ? err.message : err}`);
  }

  if (!Array.isArray(tree)) throw new SvgInvalidError('Несподівана структура SVG');

  const root = tree.find((node) => isElement(node, 'svg'));
  if (!root) throw new SvgInvalidError('Кореневий елемент не <svg>');

  const removed = new Set<string>();
  const warnings: string[] = [];
  let nodes = 0;

  const clean = (children: unknown[]): unknown[] =>
    children.filter((node) => {
      if (!node || typeof node !== 'object') return true;
      const record = node as Record<string, unknown>;
      const name = elementName(record);
      if (!name) return true;

      if (++nodes > MAX_NODES) {
        throw new SvgInvalidError(`Забагато вузлів у SVG (>${MAX_NODES})`);
      }

      const lower = name.toLowerCase();
      if (FORBIDDEN_ELEMENTS.has(lower) || TEXT_ELEMENTS.has(lower)) {
        removed.add(lower);
        return false;
      }

      sanitizeAttributes(record, removed);

      const kids = record[name];
      if (Array.isArray(kids)) record[name] = clean(kids);
      return true;
    });

  const rootRecord = root as Record<string, unknown>;
  const rootChildren = rootRecord.svg;
  if (Array.isArray(rootChildren)) rootRecord.svg = clean(rootChildren);

  forceRootAttributes(rootRecord, warnings);

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    preserveOrder: true,
    suppressEmptyNode: true,
  });

  const svg = String(builder.build([root])).trim();
  if (!svg.startsWith('<svg')) throw new SvgInvalidError('Після санітизації корінь не <svg>');

  return { svg, removed: [...removed], warnings };
}

/** Models wrap output in markdown fences and prose despite being told not to. */
function stripWrapper(input: string): string {
  let text = input.trim();
  text = text.replace(/^```(?:xml|svg|html)?\s*/i, '').replace(/```\s*$/, '');

  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start === -1 || end === -1) {
    throw new SvgInvalidError('У відповіді немає елемента <svg>');
  }
  return text.slice(start, end + '</svg>'.length).trim();
}

function isElement(node: unknown, name: string): boolean {
  return Boolean(node && typeof node === 'object' && name in (node as Record<string, unknown>));
}

function elementName(record: Record<string, unknown>): string | null {
  const key = Object.keys(record).find((k) => k !== ':@' && !k.startsWith('#'));
  return key ?? null;
}

/**
 * Drops event handlers and any reference that could reach outside the document.
 * Only `#fragment` references survive, which is what gradients and clip paths use.
 */
function sanitizeAttributes(record: Record<string, unknown>, removed: Set<string>): void {
  const attrs = record[':@'];
  if (!attrs || typeof attrs !== 'object') return;

  for (const key of Object.keys(attrs as Record<string, unknown>)) {
    const name = key.slice(ATTR_PREFIX.length).toLowerCase();
    const value = String((attrs as Record<string, unknown>)[key] ?? '');

    if (FORBIDDEN_ATTRS.has(name)) {
      delete (attrs as Record<string, unknown>)[key];
      removed.add(`@${name}`);
      continue;
    }

    if (name.startsWith('on')) {
      delete (attrs as Record<string, unknown>)[key];
      removed.add(`@${name}`);
      continue;
    }

    if (name === 'href' || name === 'xlink:href') {
      if (!value.startsWith('#')) {
        delete (attrs as Record<string, unknown>)[key];
        removed.add(`@${name}`);
      }
      continue;
    }

    if (/url\s*\(\s*["']?\s*(?!#)/i.test(value) || /javascript:/i.test(value)) {
      delete (attrs as Record<string, unknown>)[key];
      removed.add(`@${name}`);
    }
  }
}

/**
 * Rewrites the canvas attributes instead of validating them.
 *
 * A model that returns 4:3 is not wrong enough to discard — the drawing is
 * usually fine and only the frame is off, so correcting it beats a retry.
 */
function forceRootAttributes(root: Record<string, unknown>, warnings: string[]): void {
  const attrs = (root[':@'] ??= {}) as Record<string, unknown>;

  const viewBox = attrs[`${ATTR_PREFIX}viewBox`];
  if (viewBox !== SVG_VIEWBOX) {
    if (viewBox) warnings.push(`viewBox було "${String(viewBox)}", перезаписано на 16:9`);
    attrs[`${ATTR_PREFIX}viewBox`] = SVG_VIEWBOX;
  }

  // Explicit dimensions make the raster step predictable.
  attrs[`${ATTR_PREFIX}width`] = String(IMAGE_WIDTH);
  attrs[`${ATTR_PREFIX}height`] = String(IMAGE_HEIGHT);
  attrs[`${ATTR_PREFIX}xmlns`] = 'http://www.w3.org/2000/svg';
}
