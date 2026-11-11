/**
 * The phone sheet's stops (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * THE RULE. On a phone the panel is one glass sheet that rests at a stop:
 * closed (off screen), peek (its header and first lines), half, or full
 * (up to the key chip). In a short landscape window the same panel is a
 * drawer from the left edge with two stops, open and closed. The stylesheet
 * owns the heights (src/styles/mobile-panels.css); the motion module
 * (src/ui/sheet-motion.ts) measures them and uses the arithmetic here to
 * decide where a release, a key press or a tap on the grabber lands.
 *
 * WHY HERE. Everything in this file is a pure function of numbers and
 * names, so tests/sheet-detents.test.mjs proves the landing rules without a
 * browser: a flick can skip a stop, a flick from half or full never throws
 * the sheet off screen, and the keys step one stop at a time.
 *
 * Kept import-free on purpose, so `node --test` can load it with Node's type
 * stripping and no resolve hook.
 */

/** A resting position. Mirrors `SheetDetent` in src/ui/mobile-sheet.ts. */
export type SheetStop = 'closed' | 'peek' | 'half' | 'full';

/** The sheet in portrait, the drawer in a short landscape window. */
export type SheetForm = 'sheet' | 'drawer';

/** The open stops, lowest first. */
export const SHEET_OPEN_STOPS: readonly SheetStop[] = ['peek', 'half', 'full'];

/**
 * The window in which the panel is a left drawer: inside the phone shell,
 * wider than tall, and too short for a sheet with three heights. The width
 * floor keeps a phone held upright out of it: where the on-screen keyboard
 * shrinks the layout viewport, an upright phone is briefly "wider than
 * tall" (360 by 304, say), and the sheet a person is typing into must not
 * turn into a 72 px drawer. The stylesheet declares the same query, and the
 * node test keeps them equal.
 */
export const SHEET_DRAWER_QUERY =
  '(min-width: 481px) and (max-width: 720px) and (max-height: 480px) and (orientation: landscape)';

/** Geometry tokens in CSS px. The stylesheet declares the same numbers. */
export const SHEET_TOKENS = {
  /** The header strip: the grabber, the title and the close control. */
  head: 52,
  /** Peek height above the bottom safe area. */
  peek: 136,
  /** The least room between peek and half. */
  halfStep: 64,
  /** Travel past full before the rubber band stops giving. */
  rubber: 72,
  /** A drag this far below peek may close on release. */
  dismissSlack: 12,
  /** Room kept between the sheet's top edge and the map furniture riding it. */
  riderGap: 6
} as const;

export interface SheetHeights {
  readonly peek: number;
  readonly half: number;
  readonly full: number;
}

/**
 * How far the surface is displaced toward its closed position at each
 * stop, in px: 0 is fully open. A sheet moves down, a drawer moves left.
 */
export type SheetOffsets = Readonly<Record<SheetStop, number>>;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Offsets of a bottom sheet from its measured heights. Heights out of order are brought into order. */
export function sheetOffsets(heights: SheetHeights): SheetOffsets {
  const full = Math.max(0, heights.full);
  const half = clamp(heights.half, 0, full);
  const peek = clamp(heights.peek, 0, half);
  return { full: 0, half: full - half, peek: full - peek, closed: full };
}

/** Offsets of a left drawer `width` px wide: every open stop is the same seat. */
export function drawerOffsets(width: number): SheetOffsets {
  const closed = Math.max(0, width);
  return { full: 0, half: 0, peek: 0, closed };
}

/** The grabber's three moves: Enter, Space or a tap cycles; the arrows step. */
export type SheetStep = 'next' | 'up' | 'down';

/**
 * The stop a grabber move lands on. `next` climbs and wraps from full back
 * to peek; `up` and `down` stop at the ends. The grabber never closes the
 * sheet (the close control and Escape do), and a closed sheet has no
 * grabber, so closed answers closed.
 */
export function stepStop(current: SheetStop, step: SheetStep): SheetStop {
  const index = SHEET_OPEN_STOPS.indexOf(current);
  if (index < 0) return current;
  const last = SHEET_OPEN_STOPS.length - 1;
  const next =
    step === 'next'
      ? (index + 1) % SHEET_OPEN_STOPS.length
      : step === 'up'
        ? Math.min(last, index + 1)
        : Math.max(0, index - 1);
  return SHEET_OPEN_STOPS[next] ?? current;
}

/**
 * The stops a release may land on, for a drag that began at `start` and
 * was let go at `offset`.
 *
 * A sheet may land on any open stop. Closing is offered only to a drag that
 * began at peek or has already been pulled below it, so a hard flick from
 * half or full lowers the sheet and never throws it away. A drawer has one
 * open seat: the stop it was opened at, or closed.
 */
export function releaseStops(
  form: SheetForm,
  start: SheetStop,
  offset: number,
  offsets: SheetOffsets
): SheetStop[] {
  if (form === 'drawer') {
    const open: SheetStop = start === 'closed' ? 'half' : start;
    return [open, 'closed'];
  }
  const stops: SheetStop[] = ['full', 'half', 'peek'];
  if (
    start === 'peek' ||
    start === 'closed' ||
    offset > offsets.peek + SHEET_TOKENS.dismissSlack
  ) {
    stops.push('closed');
  }
  return stops;
}

/**
 * Where the map furniture that rides the sheet's top edge (the credit, the
 * notices, the scale rulers) sits, as a lift in px above its closed seat,
 * while `visible` px of the sheet show. It follows the edge up to the half
 * stop and waits there: above half the sheet covers it, as it covers the
 * map. `floor` is the lift at rest with the sheet closed (the bottom safe
 * area).
 */
export function riderLift(visible: number, halfHeight: number, floor: number): number {
  if (visible <= 0) return floor;
  const edge = Math.min(visible, halfHeight);
  return Math.max(floor, edge + Math.min(SHEET_TOKENS.riderGap, visible));
}
