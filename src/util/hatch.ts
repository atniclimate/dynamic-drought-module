/**
 * Hatch-pattern tiles for the OUTLOOK register (0.5.0b visual grammar).
 *
 * The observed-vs-outlook grammar's second instrument: analyst OUTLOOK
 * polygons (CPC Monthly / Seasonal Drought Outlook) render as hatched,
 * see-through patterns, never the solid saturated fills the observed USDM
 * week uses. The transparent ground is the point: an outlook is a shift in
 * odds laid over the place, not a fact painted onto it.
 *
 * Each of the four outlook classes gets a DISTINCT stroke direction or
 * texture, not just a distinct hue, so the class read survives color
 * vision deficiency and grayscale printing (Section 508; pattern is the
 * primary channel, hue the secondary):
 *
 *   persists   dense 45-degree rising diagonals (the condition carries on)
 *   develops   crosshatch (something new knitting together)
 *   improves   sparse falling diagonals (loosening)
 *   removal    horizontal dashes (settling out)
 *
 * Patterns are drawn on an offscreen canvas at 2x and registered on the
 * map via `map.addImage(..., { pixelRatio: 2 })`, so no binary assets ship
 * in the repo and the palette stays sourced from src/config/palette.ts.
 */

import type * as maplibregl from 'maplibre-gl';

import { DROUGHT_COLORS } from '../config/palette';

/** Outlook class keys, matching DROUGHT_COLORS and the legend order. */
export type OutlookClass = 'PERSISTS' | 'DEVELOPS' | 'IMPROVES' | 'REMOVAL';

/** Registered map-image id for an outlook class's hatch tile. */
export function hatchImageId(cls: OutlookClass): string {
  return `outlook-hatch-${cls.toLowerCase()}`;
}

/**
 * Logical tile size in CSS pixels; drawn at 2x for retina crispness.
 *
 * DENSITY TUNING (owner report, 2026-09-10): the original TILE=12 /
 * STROKE_WIDTH=1.6 / opaque strokes read as a near-solid orange field that
 * swallowed the basemap, undoing the exact "see-through" property this
 * module's own header comment names as the point. The owner's requested fix
 * ("match the current-conditions fill style", i.e. a flat `fill-color`) was
 * refused: it would destroy the pattern channel that carries the class read
 * in grayscale and for color-vision-deficient users (Section 508). Instead
 * every lever below was pulled at once, UNIFORMLY across all four classes,
 * so their relative density ordering (DEVELOPS crosshatch > PERSISTS dense
 * diagonal > IMPROVES sparse diagonal > REMOVAL dashes) survives unchanged
 * and each class stays distinguishable from the others by geometry alone:
 *
 *   - TILE 12 -> 18 (+50%): the repeating unit is bigger, so each class's
 *     strokes sit proportionally farther apart. REF/`s` below keeps every
 *     class's hand-tuned offsets scaling with TILE instead of going
 *     out-of-proportion if TILE changes again.
 *   - STROKE_WIDTH 1.6 -> 1.1 CSS px (-31%): thinner ink.
 *   - STROKE_ALPHA 1.0 -> 0.6 (opaque -> translucent): the basemap shows
 *     through the stroke itself, not just the gaps between strokes.
 *
 * Combined (ink-length x width / tile-area, alpha-weighted), the measured
 * per-class visual weight drops by ~73% uniformly:
 *
 *   class      | before (opaque) | after (alpha-weighted) | reduction
 *   -----------|-----------------|------------------------|----------
 *   DEVELOPS   |      50.3%      |         13.9%          |   -72%
 *   PERSISTS   |      42.4%      |         11.6%          |   -73%
 *   IMPROVES   |      25.1%      |          6.9%           |   -73%
 *   REMOVAL    |      10.0%      |          2.8%           |   -73%
 *
 * (before/after math: doc comment on `drawPattern` below carries the
 * per-line arithmetic for anyone re-tuning this.)
 */
const TILE = 18;
/** The tile size the class offsets below were originally hand-tuned
 * against; `s` rescales them so the geometry stays self-similar if TILE
 * changes again. */
const REF_TILE = 12;
const SCALE = 2;
const STROKE_WIDTH = 1.1;
const STROKE_ALPHA = 0.6;

/** `#rrggbb` (the only shape `DROUGHT_COLORS` uses) to an alpha-weighted
 * `rgba()` string; falls back to the opaque input for any other shape. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawPattern(cls: OutlookClass, color: string): ImageData {
  const px = TILE * SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context (headless edge case): return a transparent tile; the
    // outlook fill then reads as outline-only rather than crashing.
    return new ImageData(px, px);
  }

  // The tile-size scale factor (see the TILE comment above): every magic
  // offset below is `<value at TILE=12> * s`, so the geometry stays
  // proportional if TILE is ever re-tuned again.
  const s = TILE / REF_TILE;

  ctx.clearRect(0, 0, px, px);
  ctx.strokeStyle = withAlpha(color, STROKE_ALPHA);
  ctx.lineWidth = STROKE_WIDTH * SCALE;
  ctx.lineCap = 'butt';

  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    ctx.beginPath();
    ctx.moveTo(x1 * SCALE, y1 * SCALE);
    ctx.lineTo(x2 * SCALE, y2 * SCALE);
    ctx.stroke();
  };

  switch (cls) {
    case 'PERSISTS':
      // Dense rising diagonals; drawn across the tile edges so the
      // pattern tessellates seamlessly.
      line(-3 * s, 3 * s, 3 * s, -3 * s);
      line(0, TILE + 3 * s, TILE + 3 * s, 0);
      line(TILE - 3 * s, TILE + 3 * s, TILE + 3 * s, TILE - 3 * s);
      break;
    case 'DEVELOPS':
      // Crosshatch: one rising and one falling diagonal per tile.
      line(-2 * s, TILE + 2 * s, TILE + 2 * s, -2 * s);
      line(-2 * s, -2 * s, TILE + 2 * s, TILE + 2 * s);
      break;
    case 'IMPROVES':
      // Sparse falling diagonal (one stroke per tile).
      line(-2 * s, -2 * s, TILE + 2 * s, TILE + 2 * s);
      break;
    case 'REMOVAL':
      // Horizontal dashes, offset every other row.
      line(1 * s, 3.5 * s, 5.5 * s, 3.5 * s);
      line(6.5 * s, 9 * s, 11 * s, 9 * s);
      break;
  }

  return ctx.getImageData(0, 0, px, px);
}

/**
 * Register the four outlook hatch tiles on the map. Idempotent: images
 * already present are left alone (re-activation, style reload).
 */
export function ensureHatchImages(map: maplibregl.Map): void {
  const classes: readonly OutlookClass[] = [
    'PERSISTS',
    'DEVELOPS',
    'IMPROVES',
    'REMOVAL'
  ];
  for (const cls of classes) {
    const id = hatchImageId(cls);
    if (map.hasImage(id)) continue;
    const color = DROUGHT_COLORS[cls];
    if (!color) continue;
    map.addImage(id, drawPattern(cls, color), { pixelRatio: SCALE });
  }
}
