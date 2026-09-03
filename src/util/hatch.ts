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

/** Logical tile size in CSS pixels; drawn at 2x for retina crispness. */
const TILE = 12;
const SCALE = 2;

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

  ctx.clearRect(0, 0, px, px);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6 * SCALE;
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
      line(-3, 3, 3, -3);
      line(0, TILE + 3, TILE + 3, 0);
      line(TILE - 3, TILE + 3, TILE + 3, TILE - 3);
      break;
    case 'DEVELOPS':
      // Crosshatch: one rising and one falling diagonal per tile.
      line(-2, TILE + 2, TILE + 2, -2);
      line(-2, -2, TILE + 2, TILE + 2);
      break;
    case 'IMPROVES':
      // Sparse falling diagonal (one stroke per tile).
      line(-2, -2, TILE + 2, TILE + 2);
      break;
    case 'REMOVAL':
      // Horizontal dashes, offset every other row.
      line(1, 3.5, 5.5, 3.5);
      line(6.5, 9, 11, 9);
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
