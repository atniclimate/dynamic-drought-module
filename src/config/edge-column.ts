/**
 * The phone shell's right-edge control column (owner direction 2026-11-09
 * (sprint), DR-pending).
 *
 * THE RULE. While the phone shell is active (720 px and narrower, outside an
 * embed) every right-edge control sits in ONE column that one manager owns
 * (src/ui/edge-column.ts). The controls are grouped, top to bottom: map
 * tools (Share, Reset, Map information), the four panel doors, the four
 * hazard views, then the view tools (Satellite and any later seat such as
 * Locate or 3D). Because the groups share one flow, two controls can never
 * occupy the same pixels; what changes with the available height is only
 * how the flow is arranged, and this file decides that arrangement.
 *
 * WHY A PLANNER. Before this the doors were anchored from a clamped top and
 * the hazard views from the bottom, so the two stacks met on a short screen
 * (measured: a 44 by 32 px overlap at 360 by 740). `planEdgeColumn` is the
 * single place that answers "what fits": it prefers the largest cell with
 * every control displayed, then steps down, in this order:
 *
 *   1. one track, nothing folded, at 52, then 48, then 44 px cells;
 *   2. one track at 44 px with the map tools folded behind one control;
 *   3. portrait only: one track with the hazard views folded as well;
 *   4. two tracks (the second track opens toward the map);
 *   5. two tracks with groups folded, map tools first.
 *
 * A folded group is one cell that opens its own controls as a row beside
 * it. Nothing is ever dropped: every control stays reachable in at most two
 * presses, and a 44 px touch target is the floor at every step.
 *
 * WHY A MIRROR. The stylesheet owns the faces (src/styles/edge-column.css),
 * and the manager writes the plan onto the column as custom properties.
 * tests/edge-column-plan.test.mjs reads that stylesheet as text and fails
 * when a token here and its declaration there disagree.
 *
 * WHY A RESERVE. A mode that adds a cell (EDGE_CONDITIONAL_SEATS) must not
 * move the cells that are always there. Each group is planned at the most
 * cells any mode gives it, and the manager holds that room open under the
 * capsule, so the added cell fills a slot already held. Cost: where the union
 * does not fit, the map tools fold in every mode, not only in the fuller one.
 *
 * Kept import-free on purpose, so `node --test` can load it with Node's type
 * stripping and no resolve hook.
 */

/** The column's groups, in visual order from the top of the screen. */
export type EdgeGroupId = 'utility' | 'panels' | 'hazards' | 'view';

export const EDGE_GROUP_ORDER: readonly EdgeGroupId[] = [
  'utility',
  'panels',
  'hazards',
  'view'
];

/** The accessible name of each group, and of the one cell that stands for it when folded. */
export const EDGE_GROUP_NAMES: Readonly<Record<EdgeGroupId, { group: string; fold: string; word: string }>> = {
  utility: { group: 'Map tools', fold: 'More map tools', word: 'More' },
  panels: { group: 'Panels', fold: 'Panels', word: 'Panels' },
  hazards: { group: 'Hazard views', fold: 'Hazard views', word: 'Hazard' },
  view: { group: 'View tools', fold: 'View tools', word: 'View' }
};

/** Geometry tokens in CSS px. The stylesheet declares the same numbers. */
export const EDGE_COLUMN_TOKENS = {
  /** Inset from the screen edge, added to the safe-area inset on each side. */
  inset: 8,
  /** Cell sides the planner may choose, largest first. */
  sizes: [52, 48, 44],
  /** Gap between two groups, and between two tracks, at 48 px cells and larger. */
  gap: 8,
  /** The same gap at 44 px cells. */
  gapCompact: 6,
  /** Below this viewport width a cell never exceeds 48 px, to keep the map wide. */
  narrowViewport: 380,
  /** Height the pre-release badge takes in the flow, with its gap. */
  badgeBlock: 26,
  /** The touch-target floor (WCAG 2.5.5; the field-instrument doctrine). */
  minTarget: 44
} as const;

/** The custom properties the manager writes on `#app` and the stylesheet reads. */
export const EDGE_COLUMN_PROPERTIES = {
  size: '--edge-size',
  gap: '--edge-gap',
  /** The whole column's width, tracks and gaps included: what other chrome reserves. */
  width: '--edge-column-w',
  /** Written on each group (not on `#app`): the cells of room it holds, its fullest mode's count. */
  reserve: '--edge-reserve'
} as const;

/** Which track a group rides when the column splits. Track 0 is at the screen edge. */
export const EDGE_TWO_TRACK_SEATS: Readonly<Record<EdgeGroupId, 0 | 1>> = {
  panels: 0,
  view: 0,
  utility: 1,
  hazards: 1
};

/** Groups the planner may fold, in the order it folds them. */
const FOLD_ORDER: readonly EdgeGroupId[] = ['utility', 'hazards', 'panels', 'view'];

/**
 * Cells only one mode seats. The column is planned for the union of every
 * mode's seats, so a mode that adds one fills a slot already held for it and
 * no always-present cell moves (the 2026-09-13 stable-position rule). `order`
 * is the seat's order in its group: how the manager tells it from a cell
 * every mode shows. One row per seat, so a later mode adds a row, not code.
 */
export interface EdgeConditionalSeat {
  readonly group: EdgeGroupId;
  readonly order: number;
  /** Cluster keys (src/config/clusters.ts) in which the seat is present. */
  readonly modes: readonly string[];
}

export const EDGE_CONDITIONAL_SEATS: readonly EdgeConditionalSeat[] = [
  // The ENSO Guide door, under the four panel doors (src/ui/enso-chain.ts).
  { group: 'panels', order: 20, modes: ['enso'] },
  // The 3D entry, under Locate (src/ui/fire3d-phone.ts).
  { group: 'view', order: 30, modes: ['wildfire'] }
];

/** The most conditional cells any one mode seats in a group. */
export function conditionalReserve(group: EdgeGroupId): number {
  const perMode = new Map<string, number>();
  for (const seat of EDGE_CONDITIONAL_SEATS) {
    if (seat.group !== group) continue;
    for (const mode of seat.modes) perMode.set(mode, (perMode.get(mode) ?? 0) + 1);
  }
  return Math.max(0, ...perMode.values());
}

export interface EdgeGroupDemand {
  readonly id: EdgeGroupId;
  /** Controls currently displayed in the group. A group of zero takes no room. */
  readonly count: number;
  /**
   * Cells to hold for the group in its fullest mode; the plan uses the larger
   * of this and `count`. Absent means the group is planned as it stands.
   */
  readonly reserve?: number;
}

/** Cells the plan holds for a group: what it shows, or what its fullest mode would. */
function plannedCount(group: EdgeGroupDemand): number {
  return group.count <= 0 ? 0 : Math.max(group.count, group.reserve ?? 0);
}

export interface EdgePlanInput {
  /** Height the column may use, safe areas and insets already removed. */
  readonly availableHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly groups: readonly EdgeGroupDemand[];
  /** Whether the pre-release badge is in the flow. */
  readonly badge: boolean;
}

export interface EdgePlan {
  /** Cell side in px. */
  readonly size: number;
  /** Gap between groups and between tracks in px. */
  readonly gap: number;
  /** Group ids per track, each in visual order. Track 0 is at the screen edge. */
  readonly tracks: readonly (readonly EdgeGroupId[])[];
  /** Groups presented as one cell that opens the rest. */
  readonly folded: readonly EdgeGroupId[];
  /** The track that carries the pre-release badge, or null when there is none. */
  readonly badgeTrack: number | null;
  /** The tallest track's height in px. */
  readonly height: number;
  /** The whole column's width in px. */
  readonly width: number;
  /** False only when even the last arrangement is taller than the room; the column then scrolls. */
  readonly fits: boolean;
}

function cellsOf(group: EdgeGroupDemand, folded: ReadonlySet<EdgeGroupId>): number {
  const count = plannedCount(group);
  // Folding a single control would trade one cell for one cell.
  return folded.has(group.id) && count > 1 ? 1 : count;
}

function trackHeight(
  ids: readonly EdgeGroupId[],
  demand: ReadonlyMap<EdgeGroupId, EdgeGroupDemand>,
  folded: ReadonlySet<EdgeGroupId>,
  size: number,
  gap: number
): number {
  let cells = 0;
  let shown = 0;
  for (const id of ids) {
    const group = demand.get(id);
    if (!group) continue;
    const n = cellsOf(group, folded);
    if (n === 0) continue;
    cells += n;
    shown += 1;
  }
  return cells * size + Math.max(0, shown - 1) * gap;
}

function arrange(
  input: EdgePlanInput,
  size: number,
  twoTracks: boolean,
  foldedIds: readonly EdgeGroupId[]
): EdgePlan {
  const gap = size <= 44 ? EDGE_COLUMN_TOKENS.gapCompact : EDGE_COLUMN_TOKENS.gap;
  const demand = new Map(input.groups.map((group) => [group.id, group]));
  const planned = (id: EdgeGroupId): number => {
    const group = demand.get(id);
    return group ? plannedCount(group) : 0;
  };
  const present = EDGE_GROUP_ORDER.filter((id) => planned(id) > 0);
  const folded = new Set(foldedIds.filter((id) => planned(id) > 1));
  const tracks: EdgeGroupId[][] = twoTracks
    ? [
        present.filter((id) => EDGE_TWO_TRACK_SEATS[id] === 0),
        present.filter((id) => EDGE_TWO_TRACK_SEATS[id] === 1)
      ].filter((ids) => ids.length > 0)
    : [present];
  const heights = tracks.map((ids) => trackHeight(ids, demand, folded, size, gap));
  let badgeTrack: number | null = null;
  if (input.badge && tracks.length > 0) {
    // The badge rides the track with the most spare room; the edge track wins a tie.
    badgeTrack = 0;
    for (let i = 1; i < heights.length; i += 1) {
      if ((heights[i] ?? 0) < (heights[badgeTrack] ?? 0)) badgeTrack = i;
    }
    heights[badgeTrack] = (heights[badgeTrack] ?? 0) + EDGE_COLUMN_TOKENS.badgeBlock;
  }
  const height = heights.length > 0 ? Math.max(...heights) : 0;
  const width = tracks.length * size + Math.max(0, tracks.length - 1) * gap;
  return {
    size,
    gap,
    tracks,
    folded: FOLD_ORDER.filter((id) => folded.has(id)),
    badgeTrack,
    height,
    width,
    fits: height <= input.availableHeight
  };
}

/**
 * Choose the arrangement for the room there is. Pure: the same input always
 * gives the same plan, so a test can prove the no-overlap contract without a
 * browser (every plan it returns either fits, or is the final arrangement
 * and says `fits: false`, which the stylesheet answers by scrolling).
 */
export function planEdgeColumn(input: EdgePlanInput): EdgePlan {
  const floor = EDGE_COLUMN_TOKENS.minTarget;
  const sizes = EDGE_COLUMN_TOKENS.sizes.filter(
    (size) => size <= 48 || input.viewportWidth >= EDGE_COLUMN_TOKENS.narrowViewport
  );
  for (const size of sizes) {
    const plan = arrange(input, size, false, []);
    if (plan.fits) return plan;
  }
  const portrait = input.viewportHeight >= input.viewportWidth;
  const steps: Array<{ two: boolean; fold: readonly EdgeGroupId[] }> = [
    { two: false, fold: ['utility'] }
  ];
  if (portrait) steps.push({ two: false, fold: ['utility', 'hazards'] });
  steps.push({ two: true, fold: [] });
  for (let n = 1; n <= FOLD_ORDER.length; n += 1) {
    steps.push({ two: true, fold: FOLD_ORDER.slice(0, n) });
  }
  let last: EdgePlan | null = null;
  for (const step of steps) {
    last = arrange(input, floor, step.two, step.fold);
    if (last.fits) return last;
  }
  return last ?? arrange(input, floor, true, FOLD_ORDER);
}
