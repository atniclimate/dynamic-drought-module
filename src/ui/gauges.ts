/**
 * The briefing's gauge family (owner direction 2026-11-09 (sprint),
 * DR-pending): three small inline SVG figures that draw an issuer's read on
 * the issuer's own scale. Pure string builders, no dependency, no DOM, no
 * animation (so reduced motion needs no special case).
 *
 *   classGaugeSvg   ordered issuer classes (USDM D0 to D4, HeatRisk 0 to 4):
 *                   the whole scale in the issuer's colours, the read class
 *                   marked by POSITION (a caret and a taller block) and an
 *                   ink keyline, never by colour alone.
 *   indexGaugeSvg   a signed index against the issuer's thresholds (the ENSO
 *                   index and its onset thresholds).
 *   dayStripSvg     a short run of daily classes on one issuer clock (the SPC
 *                   outlook days).
 *
 * HONESTY RULES, the same for all three.
 *   - Colour belongs to the data: a fill is an issuer class colour from
 *     src/config/palette.ts or it is neutral ink. Nothing here invents a hue.
 *   - A figure with no read never draws a value, and each of the three
 *     no-read states is its own drawing on every figure. `loading` is the
 *     empty outlined scale. `unavailable` is a hatched plate. `no-data` is
 *     the empty scale with a short bar in every slot or frame (on the index
 *     gauge, whose scale is a line, the line itself is broken into short
 *     bars). None of them places a marker on one class or one value, so
 *     there is no zero needle to misread. The state word and its reason are
 *     the caller's text, beside the figure.
 *   - Every figure carries a text alternative (`title`) the caller writes
 *     with the same facts: the class, the source and the time.
 *
 * Ink is applied by class (src/styles/briefing-lead.css), not by attribute,
 * so print and forced-colors can re-ink it; only issuer colours are literal.
 */

import {
  ENSO_INDEX_GUIDE_COLORS,
  HEATRISK_CATEGORIES,
  SPC_FIREWX_CATEGORIES,
  USDM_CATEGORIES,
  USDM_NONE_SWATCH
} from '../config/palette';
import type { HorizonStatus } from '../impact/types';
import { escapeHtml } from '../util/escape';

/** What a figure holds: a read, or one of the states that draw no value. */
export type GaugeState = 'read' | 'loading' | 'unavailable' | 'no-data';

/**
 * The state word that stands beside a figure or a briefing cell. One table
 * for the matrix pills (src/ui/impact-panel-runtime.ts), the priority view
 * and the evidence chain, in the canonical six-state vocabulary: a briefing
 * cell has four of the six states, and each keeps its canonical word.
 */
export const READ_STATE_WORD: Readonly<Record<HorizonStatus, string>> = {
  loading: 'loading...',
  ready: 'live',
  partial: 'live (partial)',
  unavailable: 'unavailable'
};

/** One class of an ordered issuer scale. */
export interface GaugeClass {
  /** The short mark under the block: the issuer's own code ("D2", "3"). */
  readonly tick: string;
  /** The class in the issuer's words, for the hover title. */
  readonly label: string;
  /** The issuer's class colour. */
  readonly color: string;
}

export interface ClassGaugeOptions {
  /** The scale, lowest class first. */
  readonly classes: readonly GaugeClass[];
  /**
   * The read position: an index into `classes`, `'none'` for the leading
   * slot (the issuer drew no class here), or null when nothing is marked.
   * Ignored unless `state` is `read`.
   */
  readonly read: number | 'none' | null;
  /** The leading "no class drawn" slot, for scales that have that position. */
  readonly none?: { readonly tick: string; readonly label: string };
  readonly state: GaugeState;
  /** The text alternative: class, source and time, in words. */
  readonly title: string;
}

/** The U.S. Drought Monitor scale, D0 to D4 (palette.ts `USDM_CATEGORIES`). */
export const USDM_SCALE: readonly GaugeClass[] = USDM_CATEGORIES.map((category) => ({
  tick: category.code,
  label: `${category.code} ${category.label}`,
  color: category.color
}));

/** The scale position USDM has no polygon for (palette.ts `USDM_NONE_SWATCH`). */
export const USDM_NONE_SLOT = { tick: 'none', label: USDM_NONE_SWATCH.label } as const;

/** The NWS HeatRisk scale, 0 to 4 (palette.ts `HEATRISK_CATEGORIES`). */
export const HEATRISK_SCALE: readonly GaugeClass[] = HEATRISK_CATEGORIES.map((category) => ({
  tick: String(category.value),
  label: `${category.value} ${category.label}`,
  color: category.color
}));

const W = 240;
const n1 = (value: number): string => String(Math.round(value * 10) / 10);

function frame(height: number, title: string, kind: string, state: GaugeState, inner: string): string {
  return (
    `<svg class="ddm-gauge ddm-gauge-${kind}" data-gauge-state="${state}" viewBox="0 0 ${W} ${height}" width="100%" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(title)}" xmlns="http://www.w3.org/2000/svg">` +
    `<title>${escapeHtml(title)}</title>${inner}</svg>`
  );
}

/**
 * A 45 degree hatch inside one rectangle, as a single path. Drawn by
 * geometry, not by an SVG pattern: a pattern needs an id, and several figures
 * share one document.
 */
function hatch(x: number, y: number, w: number, h: number, step = 5): string {
  const parts: string[] = [];
  for (let k = -h + step / 2; k < w; k += step) {
    let sx = x + k;
    let sy = y + h;
    let ex = x + k + h;
    let ey = y;
    if (sx < x) {
      sy -= x - sx;
      sx = x;
    }
    if (ex > x + w) {
      ey += ex - (x + w);
      ex = x + w;
    }
    parts.push(`M${n1(sx)} ${n1(sy)}L${n1(ex)} ${n1(ey)}`);
  }
  return `<path class="g-hatch" d="${parts.join('')}"/>`;
}

/** The read marker: a caret pointing down at a block's centre. */
function caret(cx: number, tipY: number): string {
  return `<path class="g-caret" d="M${n1(cx - 4)} ${n1(tipY - 5)}H${n1(cx + 4)}L${n1(cx)} ${n1(tipY)}Z"/>`;
}

/**
 * The class gauge: every class of the issuer's scale as a block in the
 * issuer's colour, lowest at the left, and the read class taller, keylined in
 * ink and pointed at by a caret. Unread blocks keep a hairline so a class
 * darker than the panel (D4, HeatRisk 4) still shows its place.
 */
export function classGaugeSvg(options: ClassGaugeOptions): string {
  const { classes, state } = options;
  // An unread scale has no tick row, so it is drawn on a shorter canvas.
  const H = state === 'read' ? 40 : 28;
  const mid = 18;
  const thin = 8;
  const tall = 16;
  const gap = 2;
  const noneW = options.none ? 34 : 0;
  const x0 = options.none ? noneW + 6 : 0;
  const segW = (W - x0 - gap * (classes.length - 1)) / classes.length;
  const read = state === 'read' ? options.read : null;
  const drawn = state === 'read';
  let inner = '';

  if (options.none) {
    const marked = read === 'none';
    const h = marked ? tall : thin;
    inner +=
      `<rect class="g-slot${marked ? ' g-read' : ''}" x="0.75" y="${n1(mid - h / 2)}" width="${n1(noneW - 1.5)}" height="${h}" rx="2">` +
      `<title>${escapeHtml(options.none.label)}</title></rect>` +
      (marked ? caret(noneW / 2, mid - h / 2 - 1.5) : '') +
      (drawn
        ? `<text class="g-tick${marked ? ' g-tick-read' : ''}" x="${n1(noneW / 2)}" y="${H - 3}" text-anchor="middle">${escapeHtml(options.none.tick)}</text>`
        : '');
  }

  classes.forEach((cls, index) => {
    const x = x0 + index * (segW + gap);
    const marked = read === index;
    const h = marked ? tall : thin;
    const y = mid - h / 2;
    // An unread state draws the scale's outline only: no issuer colour is
    // shown for a class that was not read.
    const face = drawn
      ? `class="g-seg${marked ? ' g-read' : ''}" fill="${escapeHtml(cls.color)}"`
      : 'class="g-seg g-seg-empty"';
    inner +=
      `<rect ${face} x="${n1(x)}" y="${n1(y)}" width="${n1(segW)}" height="${h}" rx="2">` +
      `<title>${escapeHtml(cls.label)}</title></rect>` +
      (marked ? caret(x + segW / 2, y - 1.5) : '') +
      (drawn
        ? `<text class="g-tick${marked ? ' g-tick-read' : ''}" x="${n1(x + segW / 2)}" y="${H - 3}" text-anchor="middle">${escapeHtml(cls.tick)}</text>`
        : '');
  });

  if (state === 'unavailable') inner += hatch(0, mid - thin / 2, W, thin);
  if (state === 'no-data') {
    // The service answered with no value: a short bar in EVERY slot. One bar
    // centred on the scale would sit inside a single class's block and read
    // as that class.
    const centres = [
      ...(options.none ? [noneW / 2] : []),
      ...classes.map((_, index) => x0 + index * (segW + gap) + segW / 2)
    ];
    inner += centres.map((cx) => `<path class="g-nodata" d="M${n1(cx - 4)} ${mid}H${n1(cx + 4)}"/>`).join('');
  }
  return frame(H, options.title, 'class', state, inner);
}

export interface IndexGaugeOptions {
  /** The index value, when read. */
  readonly value: number | null;
  /** The issuer's symmetric threshold (0.5 puts ticks at minus and plus 0.5). */
  readonly threshold: number;
  /** The words at the negative and positive thresholds, for example "La Nina" and "El Nino". */
  readonly below: string;
  readonly above: string;
  /** The value as the issuer prints it, for example "+1.69". */
  readonly valueLabel?: string;
  readonly state: GaugeState;
  readonly title: string;
}

/**
 * The index gauge: a signed axis with the issuer's two thresholds marked and
 * named, the band between them shaded as the neutral range, and the value as
 * an ink dot with its printed number. The threshold ticks wear the CPC
 * reference-guide colours the index chart already uses
 * (`ENSO_INDEX_GUIDE_COLORS.RONI`); the value itself is ink, since an index
 * value is not a class and has no issuer colour.
 */
export function indexGaugeSvg(options: IndexGaugeOptions): string {
  const H = 46;
  const padX = 10;
  const axisY = 22;
  const t = options.threshold;
  const value = options.state === 'read' ? options.value : null;
  // A symmetric range that always holds the value and both thresholds.
  const reach = Math.max(2.5, t * 2, value === null ? 0 : Math.ceil(Math.abs(value)) + 0.5);
  const x = (v: number): number => padX + ((v + reach) / (2 * reach)) * (W - padX * 2);
  const guide = ENSO_INDEX_GUIDE_COLORS.RONI;
  const signed = (v: number): string => `${v > 0 ? '+' : ''}${v}`;
  // The service answered with no value: the axis is broken into short bars,
  // the same mark the class gauge puts in every slot. No dot is drawn.
  const axisClass = options.state === 'no-data' ? 'g-axis g-nodata' : 'g-axis';
  const dash = options.state === 'no-data' ? ' stroke-dasharray="8 6"' : '';
  let inner = `<path class="${axisClass}"${dash} d="M${padX} ${axisY}H${W - padX}"/>`;

  if (options.state === 'unavailable') {
    inner += hatch(padX, axisY - 5, W - padX * 2, 10);
  } else {
    inner +=
      `<rect class="g-band" x="${n1(x(-t))}" y="${axisY - 5}" width="${n1(x(t) - x(-t))}" height="10"/>` +
      `<path class="g-zero" d="M${n1(x(0))} ${axisY - 5}V${axisY + 5}"/>`;
    for (const [at, color, word, anchor] of [
      [-t, guide.cold, options.below, 'end'],
      [t, guide.warm, options.above, 'start']
    ] as const) {
      const tx = n1(x(at));
      inner +=
        `<path class="g-threshold-casing" d="M${tx} ${axisY - 8}V${axisY + 8}"/>` +
        `<path class="g-threshold" stroke="${color}" d="M${tx} ${axisY - 8}V${axisY + 8}"/>` +
        `<text class="g-tick" x="${n1(x(at) + (anchor === 'end' ? -3 : 3))}" y="${H - 4}" text-anchor="${anchor}">${escapeHtml(word)} ${signed(at)}</text>`;
    }
    inner += `<text class="g-tick" x="${n1(x(0))}" y="${H - 4}" text-anchor="middle">0</text>`;
  }

  if (value !== null) {
    const cx = x(Math.max(-reach, Math.min(reach, value)));
    const label = options.valueLabel ?? signed(value);
    const anchor = cx > W - 34 ? 'end' : cx < 34 ? 'start' : 'middle';
    inner +=
      `<circle class="g-dot" cx="${n1(cx)}" cy="${axisY}" r="5"/>` +
      `<text class="g-value" x="${n1(cx)}" y="10" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
  }
  return frame(H, options.title, 'index', options.state, inner);
}

/** One day of a day strip. */
export type DayStripCell =
  /** An issuer class with a palette colour, at an ordered step of its scale (1 is the lowest of `steps`). */
  | { readonly kind: 'class'; readonly label: string; readonly color: string; readonly step: number; readonly steps: number }
  /** A probability the issuer mapped, 0 to 100. */
  | { readonly kind: 'probability'; readonly percent: number }
  /** A service value with a word and no magnitude; two words are set on two lines. */
  | { readonly kind: 'word'; readonly word: string; readonly label: string }
  /** The issuer drew nothing over the point for this day. */
  | { readonly kind: 'none' }
  /** The day was not read (a failed, expired or unreadable answer). */
  | { readonly kind: 'unread' };

export interface DayStripDay {
  /** The day's own mark under its frame, for example "1". */
  readonly tick: string;
  readonly cell: DayStripCell;
  /** True for the day the entry is placed by. */
  readonly lead?: boolean;
}

export interface DayStripGroup {
  /** What the group's frames measure, for example "category". */
  readonly caption: string;
  readonly days: readonly DayStripDay[];
}

export interface DayStripOptions {
  /** One or more runs of days; each run is one issuer scale and says which. */
  readonly groups: readonly DayStripGroup[];
  readonly state: GaugeState;
  readonly title: string;
}

/**
 * The day strip: one frame per day, in day order, grouped by the scale the
 * days are read on. A frame fills from the bottom: to an ordered step in the
 * issuer's colour for a class, to its true share of the frame in neutral ink
 * for a probability. An empty frame is "no area drawn"; a hatched frame was
 * not read. Height carries the class beside the colour, so the strip never
 * rests on hue alone. With no read at all the whole strip takes one state:
 * dashed frames while loading, hatched frames when unavailable, a short bar in
 * every frame when the service answered with no data. A loading frame is
 * dashed because an empty solid frame is a READ ("no area drawn"): a strip
 * that is still loading must not look like eight days with nothing drawn.
 */
export function dayStripSvg(options: DayStripOptions): string {
  const H = 58;
  const top = 21;
  const frameH = 22;
  const groupGap = 10;
  const gap = 3;
  const days = options.groups.reduce((sum, group) => sum + group.days.length, 0);
  const groupGaps = Math.max(0, options.groups.length - 1) * groupGap;
  const cellW = (W - groupGaps - gap * (days - options.groups.length)) / Math.max(1, days);
  const drawn = options.state === 'read';
  let inner = '';
  let x = 0;

  for (const group of options.groups) {
    inner += `<text class="g-caption" x="${n1(x)}" y="8">${escapeHtml(group.caption)}</text>`;
    for (const day of group.days) {
      const cell = drawn ? day.cell : ({ kind: 'unread' } as const);
      const cx = x + cellW / 2;
      const lead = drawn && day.lead === true;
      let fill = '';
      let above = '';
      let hover = 'Not read';
      if (cell.kind === 'class') {
        const h = (frameH * cell.step) / cell.steps;
        fill = `<rect class="g-fill" fill="${escapeHtml(cell.color)}" x="${n1(x + 1.5)}" y="${n1(top + frameH - h + 1.5)}" width="${n1(cellW - 3)}" height="${n1(h - 3)}" rx="1"/>`;
        hover = cell.label;
      } else if (cell.kind === 'probability') {
        const h = Math.max(4, (frameH * Math.max(0, Math.min(100, cell.percent))) / 100);
        fill = `<rect class="g-fill g-fill-ink" x="${n1(x + 1.5)}" y="${n1(top + frameH - h + 1.5)}" width="${n1(cellW - 3)}" height="${n1(h - 3)}" rx="1"/>`;
        above = `${cell.percent}%`;
        hover = `${cell.percent}% probability`;
      } else if (cell.kind === 'word') {
        // At most two short lines, so an issuer's words are not cut to one.
        const lines = cell.word.split(' ').slice(0, 2);
        const firstY = top + frameH / 2 + 2.5 - (lines.length - 1) * 4;
        fill = lines
          .map((line, index) => `<text class="g-word" x="${n1(cx)}" y="${n1(firstY + index * 8)}" text-anchor="middle">${escapeHtml(line)}</text>`)
          .join('');
        hover = cell.label;
      } else if (cell.kind === 'none') {
        hover = 'No area drawn';
      } else if (options.state === 'no-data') {
        hover = 'No data';
        fill = `<path class="g-nodata" d="M${n1(cx - 4)} ${n1(top + frameH / 2)}H${n1(cx + 4)}"/>`;
      } else if (options.state === 'loading') {
        hover = 'Loading';
      } else {
        fill = hatch(x + 1, top + 1, cellW - 2, frameH - 2, 4);
      }
      // The first tick already says "Day 1"; the rest are the bare number.
      const dayName = /^day\b/i.test(day.tick) ? day.tick : `Day ${day.tick}`;
      inner +=
        `<rect class="g-frame${lead ? ' g-read' : ''}${options.state === 'loading' ? ' g-frame-pending' : ''}" x="${n1(x + 0.5)}" y="${top + 0.5}" width="${n1(cellW - 1)}" height="${frameH - 1}" rx="2">` +
        `<title>${escapeHtml(dayName)}: ${escapeHtml(hover)}</title></rect>` +
        fill +
        (above ? `<text class="g-above" x="${n1(cx)}" y="${top - 3}" text-anchor="middle">${escapeHtml(above)}</text>` : '') +
        (lead ? caret(cx, top - (above ? 11 : 2)) : '') +
        `<text class="g-tick${lead ? ' g-tick-read' : ''}" x="${n1(cx)}" y="${H - 3}" text-anchor="middle">${escapeHtml(day.tick)}</text>`;
      x += cellW + gap;
    }
    x += groupGap - gap;
  }
  return frame(H, options.title, 'days', options.state, inner);
}

/** The SPC Day 1 and Day 2 categories as day-strip steps, lowest first. */
export function spcCategoryCell(dn: number): DayStripCell {
  const ordered = [...SPC_FIREWX_CATEGORIES].sort((a, b) => a.dn - b.dn);
  const index = ordered.findIndex((category) => category.dn === dn);
  if (index < 0) return { kind: 'unread' };
  const category = ordered[index]!;
  return { kind: 'class', label: category.label, color: category.color, step: index + 1, steps: ordered.length };
}
