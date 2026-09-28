/**
 * The fixed map chrome of the desktop shell (S30D D1 M9; register item
 * owner-1f, DDM-P10-T11; design record interface-chrome-popups-text.md
 * sections 2.1 to 2.3; owner rulings R1 a and R2 a).
 *
 * THE RULE. On the desktop shell (721 px and wider, outside an embed) the
 * top-right column is a grid of four fixed slots that never move: Reset,
 * SAT, Help (with the Map information drawer it opens), then a reserved
 * Share slot that Share fills whenever the Brief shell has not rehosted it
 * into the sidebar foot. A rehost empties slot 4's box; nothing else moves
 * (the 2026-09-13 stable-position rule). Above 1024 px each slot is a
 * square-edged, labelled cell (R1 a): a fixed 20 px icon column, then the
 * word. Across the 721 to 1024 px tablet band it is a 44 px icon square
 * with the word visually hidden (owner ruling DR-153; MAP_CHROME_TABLET_BAND).
 *
 * WHY A MIRROR. The stylesheet owns the geometry (src/styles/app.css, the
 * `.app-shell:not(.embed)` token block under `@media (min-width: 721px)`),
 * but a test cannot read a CSS custom property without a browser, and a
 * seat test needs the numbers to compute each slot's rectangle. This table
 * is those same numbers. tests/map-chrome-contract.test.mjs reads app.css
 * as text and fails when a token and its entry here disagree, so the two
 * can only move together.
 *
 * N MODES (DR-113). Nothing here names a mode: the column is mode-neutral,
 * and the seat specs enumerate modes from the rendered switcher.
 *
 * Phones (720 px and below) and `embed=true` keep today's seats and faces;
 * none of these numbers applies there (`--map-ctrl-w` stays for phones).
 *
 * Kept import-free on purpose, so `node --test` can load it with Node's
 * type stripping and no resolve hook.
 */

/** The chrome geometry tokens, in CSS px, keyed by their camel-case name. */
export const MAP_CHROME_TOKENS = {
  /** The one corner inset every chrome seat keeps from the map's edge. */
  chromeInset: 12,
  /**
   * A labelled cell's width (R1 a): the design record's 124 raised to the
   * measured need (D1.md :295). The director's probe, 2026-09-27, 1280x900
   * and 1440x900, Lexend: "Share view" is about 78.4 px, so the cell needs
   * 1 + 9 + 20 + 8 + 78.4 + 9 + 1 = 126.4; 128 is the next 4 px step.
   * The tablet band's icon square is MAP_CHROME_TABLET_BAND.cell.
   */
  mapCellW: 128,
  /** A cell's height on a fine pointer. */
  mapCellH: 40,
  /** The vertical gap between two slots. */
  mapCellGap: 4,
  /** The top-left chip's width (M10 consumes it). */
  chipW: 288,
  /** The left Key drawer's width (M11 consumes it). */
  keyDrawerW: 336,
  /** The right Map information drawer's width (help's panel). */
  infoDrawerW: 360,
  /**
   * One popup measure for both sinks (M23 consumes it): the sidebar foot's
   * content width at the 340 px sidebar, 340 minus its two 18 px paddings.
   * Provisional until M23 measures the foot in a browser.
   */
  popupMeasure: 304,
  /** The bottom dock's symmetric inset (M10 consumes it). */
  dockInset: 196
} as const;

export type MapChromeTokenName = keyof typeof MAP_CHROME_TOKENS;

/** The CSS custom property that carries each token in app.css. */
export const MAP_CHROME_TOKEN_PROPERTIES: Readonly<Record<MapChromeTokenName, string>> = {
  chromeInset: '--chrome-inset',
  mapCellW: '--map-cell-w',
  mapCellH: '--map-cell-h',
  mapCellGap: '--map-cell-gap',
  chipW: '--chip-w',
  keyDrawerW: '--key-drawer-w',
  infoDrawerW: '--info-drawer-w',
  popupMeasure: '--popup-measure',
  dockInset: '--dock-inset'
};

/**
 * A cell's height under `(pointer: coarse)`: the 44 px touch floor
 * (`--touch-target`, DR-036 a), which `--map-cell-h` takes there.
 */
export const MAP_CELL_H_COARSE = 44;

/**
 * THE TABLET BAND (owner ruling DR-153, 2026-09-28, RATIFICATION-6 Q2 and
 * Q2b: "For tablet/narrow view, we can use the same icon buttons as mobile
 * view", for the whole band). The app's own tablet query, 721 to 1024 px
 * viewport inclusive (DDM-P10-T01), with the sidebar open or collapsed: a
 * viewport rule, not a chip-collision rule. There the family is icon
 * squares at the band's 44 px touch floor on every pointer (DR-036 a,
 * "tablet is touch-first"), the word visually hidden and every accessible
 * name kept (DR-154). Slots, gap, faces, edges and focus are unchanged, so
 * the seat formula stays one table with the band's cell size in it.
 */
export const MAP_CHROME_TABLET_BAND = {
  /** The first desktop-shell viewport width, the band's floor. */
  minViewport: 721,
  /** The band's last viewport width; 1025 and wider is desktop. */
  maxViewport: 1024,
  /** The icon square's side: the touch floor, `--touch-target`. */
  cell: MAP_CELL_H_COARSE
} as const;

/** True for a viewport inside the app's 721 to 1024 px tablet band. */
export function isTabletBand(viewportWidth: number): boolean {
  return (
    viewportWidth >= MAP_CHROME_TABLET_BAND.minViewport &&
    viewportWidth <= MAP_CHROME_TABLET_BAND.maxViewport
  );
}

/**
 * The cell size at a viewport width: the band's 44 px square, or the
 * labelled cell of ruling R1 a (40 high, 44 on a coarse pointer).
 */
export function mapChromeCellSize(
  viewportWidth: number,
  coarse = false
): { readonly width: number; readonly height: number } {
  if (isTabletBand(viewportWidth)) {
    return { width: MAP_CHROME_TABLET_BAND.cell, height: MAP_CHROME_TABLET_BAND.cell };
  }
  return {
    width: MAP_CHROME_TOKENS.mapCellW,
    height: coarse ? MAP_CELL_H_COARSE : MAP_CHROME_TOKENS.mapCellH
  };
}

/**
 * The inside of a cell (R1 a). The edge is a 1 px border inside the
 * border box, so the padding is 9 px and the icon column starts 10 px from
 * the cell's outer left edge: every icon centre then shares one x, the
 * container's right edge minus 120 px at a 128 px cell (W - 140 + 10 + 10).
 */
export const MAP_CELL_ANATOMY = {
  edge: 1,
  paddingInline: 9,
  iconColumn: 20,
  iconGap: 8,
  labelFontPx: 14
} as const;

export type MapChromeSlot = 1 | 2 | 3 | 4;

export interface MapChromeSeat {
  readonly slot: MapChromeSlot;
  readonly key: 'reset' | 'satellite' | 'help' | 'share';
  /** The slot's own box, present whether or not its control is seated. */
  readonly slotSelector: string;
  /** The control that fills the slot on the desktop shell. */
  readonly controlSelector: string;
  /** The visible word (R1 a). */
  readonly word: string;
  /** The rectangle in `#map-container` px, W and H the container's size. */
  readonly formula: string;
  /**
   * False only for Share: the desktop Brief shell rehosts it into the
   * sidebar foot, which leaves slot 4's box empty and moves nothing.
   */
  readonly alwaysSeated: boolean;
}

const SLOT_FORMULA =
  'x = W - chrome-inset - map-cell-w; y = chrome-inset + (slot - 1) * (map-cell-h + map-cell-gap); map-cell-w x map-cell-h';

export const MAP_CHROME_SEATS: readonly MapChromeSeat[] = [
  {
    slot: 1,
    key: 'reset',
    slotSelector: '.map-overlay-controls > #reset-btn',
    controlSelector: '#reset-btn',
    word: 'Reset',
    formula: SLOT_FORMULA,
    alwaysSeated: true
  },
  {
    slot: 2,
    key: 'satellite',
    slotSelector: '.map-overlay-controls > #basemap-switcher-overlay-host',
    controlSelector: '#basemap-switcher-overlay-host .basemap-switcher-btn',
    word: 'SAT',
    formula: SLOT_FORMULA,
    alwaysSeated: true
  },
  {
    slot: 3,
    key: 'help',
    slotSelector: '.map-overlay-controls > #map-info-seat',
    controlSelector: '#map-info-seat > #map-info-btn',
    word: 'Help',
    formula: SLOT_FORMULA,
    alwaysSeated: true
  },
  {
    slot: 4,
    key: 'share',
    slotSelector: '.map-overlay-controls > .map-spine-reserve',
    controlSelector: '.map-overlay-controls > #share-btn',
    word: 'Share view',
    formula: SLOT_FORMULA,
    alwaysSeated: false
  }
];

export interface MapChromeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One slot's rectangle in `#map-container` px for a container
 * `containerWidth` wide in a viewport `viewportWidth` wide, on a fine or a
 * coarse pointer: x = W - chromeInset - cell width, y = chromeInset +
 * (slot - 1) * (cell height + mapCellGap). The column is right-anchored, so
 * a sidebar toggle changes x in container px and nothing in viewport px.
 */
export function mapChromeSeatRect(
  slot: MapChromeSlot,
  containerWidth: number,
  viewportWidth: number,
  coarse = false
): MapChromeRect {
  const { chromeInset, mapCellGap } = MAP_CHROME_TOKENS;
  const { width, height } = mapChromeCellSize(viewportWidth, coarse);
  return {
    x: containerWidth - chromeInset - width,
    y: chromeInset + (slot - 1) * (height + mapCellGap),
    width,
    height
  };
}

/**
 * The shared icon centre x, in `#map-container` px: W - 120 under R1 a;
 * in the tablet band the icon is centred in its 44 px square (W - 34).
 */
export function mapCellIconCentreX(
  containerWidth: number,
  viewportWidth: number,
  coarse = false
): number {
  const { chromeInset, mapCellW } = MAP_CHROME_TOKENS;
  const { width } = mapChromeCellSize(viewportWidth, coarse);
  if (isTabletBand(viewportWidth)) return containerWidth - chromeInset - width / 2;
  const { edge, paddingInline, iconColumn } = MAP_CELL_ANATOMY;
  return containerWidth - chromeInset - mapCellW + edge + paddingInline + iconColumn / 2;
}
