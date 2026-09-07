/**
 * The briefing matrix: four hazard rows by three horizon columns (DR-012 b).
 *
 * The briefing used to be three horizon sections holding one undifferentiated
 * list of claims, so a drought issuer's status pill spoke for a wildfire
 * sentence beside it and one failed source made the whole horizon read
 * partial. This module makes the twelve cells explicit: each cell owns its
 * claims, its status, and its note, and nothing in a cell comes from a lane
 * that was not declared for it.
 *
 * Two tables carry the whole arrangement:
 *
 *   LANE_PLACEMENT   which hazard rows and which horizon columns each source
 *                    family feeds. A source that answers for two hazards
 *                    (the NWS active-alerts query answers for fire and for
 *                    heat) declares both; a source that answers across
 *                    horizons (the ENSO snapshot) declares both horizons and
 *                    its claims name their own.
 *   CELL_ABSENCE     what a cell says when it has nothing to show and no
 *                    failing source explained why. Every cell has one, so a
 *                    cell can never render blank.
 *
 * The module is pure: no DOM, no fetches, no application state. `hydrate.ts`
 * settles lanes and calls `applyMatrix` after each one.
 */

import type { BriefingSourceKey } from '../config/source-capability';
import type {
  HazardCell,
  HazardKey,
  Horizon,
  HorizonKey,
  HorizonStatus,
  SourcedClaim
} from './types';

/** The hazard rows in display order. */
export const HAZARD_KEYS: readonly HazardKey[] = [
  'drought',
  'fire',
  'heat',
  'enso'
];

/** The horizon columns in display order. */
export const HORIZON_KEYS: readonly HorizonKey[] = [
  'current',
  'nearTerm',
  'longRange'
];

/**
 * The row labels. Deliberately the plainest possible names for the four
 * hazards the module already speaks in; the briefing's door names and any
 * per-screen title are a separate, open question (DR-013) and are not
 * settled here.
 */
export const HAZARD_LABELS: Readonly<Record<HazardKey, string>> = {
  drought: 'Drought',
  fire: 'Fire',
  heat: 'Heat',
  enso: 'ENSO'
};

/**
 * Every source family that feeds the matrix. Point heat is not here: it is
 * its own briefing lane with its own section, describing the selected
 * coordinate rather than a hazard row.
 */
export type MatrixLaneKey = Exclude<BriefingSourceKey, 'pointHeat'>;

export interface MatrixLanePlacement {
  /** The hazard rows this lane may fill. */
  readonly hazards: readonly HazardKey[];
  /** The horizon columns this lane may fill. */
  readonly horizons: readonly HorizonKey[];
}

/**
 * Which cells each lane is responsible for. This table IS the matrix: a cell
 * with no lane here renders its `CELL_ABSENCE` state, and a lane can never
 * write into a cell it does not name.
 */
export const LANE_PLACEMENT: Readonly<
  Record<MatrixLaneKey, MatrixLanePlacement>
> = {
  usdm: { hazards: ['drought'], horizons: ['current'] },
  dsci: { hazards: ['drought'], horizons: ['current'] },
  nifc: { hazards: ['fire'], horizons: ['current'] },
  // One query, two hazards: the fire-weather claim carries hazards ['fire'],
  // the extreme-heat claim carries ['heat'], and the claim reporting neither
  // in effect speaks for both rows, so it keeps the lane's own pair.
  nwsAlerts: { hazards: ['fire', 'heat'], horizons: ['current'] },
  heatRisk: { hazards: ['heat'], horizons: ['nearTerm'] },
  nwsForecast: { hazards: ['heat'], horizons: ['nearTerm'] },
  cpcExtended: { hazards: ['drought'], horizons: ['nearTerm'] },
  // One snapshot, two clocks: the observed index state is a current read and
  // the seasonal tendency is a long-range one, so its claims name their own
  // horizon rather than all landing under the season.
  enso: { hazards: ['enso'], horizons: ['current', 'longRange'] },
  waterSupply: { hazards: ['drought'], horizons: ['longRange'] },
  cpcSeasonal: { hazards: ['drought'], horizons: ['longRange'] }
};

/** Every lane key, in a stable order. */
export const MATRIX_LANE_KEYS: readonly MatrixLaneKey[] = [
  'usdm',
  'dsci',
  'nifc',
  'nwsAlerts',
  'heatRisk',
  'nwsForecast',
  'cpcExtended',
  'enso',
  'waterSupply',
  'cpcSeasonal'
];

/**
 * What each cell says when it holds no claim and no source failure explained
 * the absence. Three of these describe work this briefing has not done yet
 * and name the product that will fill the cell (DR-022 for the two fire
 * cells, DR-019 for the seasonal heat cell); the rest name the product that
 * had nothing to report for this selection. None of them is a claim about
 * conditions, and none is a blank.
 */
export const CELL_ABSENCE: Readonly<
  Record<HorizonKey, Readonly<Record<HazardKey, string>>>
> = {
  current: {
    drought: 'No U.S. Drought Monitor read is available for this selection.',
    fire: 'No NIFC current mapped fire perimeter read is available for this selection.',
    // vocab-allow: names the upstream NWS active alerts product
    heat: 'No NWS active alerts read is available for this selection.',
    enso: 'No NOAA CPC ENSO index read is available for this selection.'
  },
  nearTerm: {
    drought:
      'No NOAA CPC extended-range outlook is available for this selection.',
    fire:
      'No near-term fire outlook is read here yet: the NOAA Storm Prediction Center fire weather outlooks for Days 1 to 8 are not wired into this briefing.',
    heat: 'No near-term heat read is available for this selection.',
    enso:
      'No ENSO product is read at this horizon: the ENSO reads this briefing carries are a current index state and a season-ahead tendency, so they appear under the current and long-range horizons.'
  },
  longRange: {
    drought: 'No long-range drought outlook is available for this selection.',
    fire:
      'No season-ahead fire outlook is read here yet: the National Interagency Fire Center Predictive Services significant fire potential outlook for Months 1 to 4 is not wired into this briefing.',
    heat:
      'No season-ahead heat outlook is read here yet: the NOAA CPC seasonal temperature outlook is not wired into this briefing.',
    enso: 'No ENSO seasonal tendency is shown for this selection.'
  }
};

/** The settled outcome of one lane, structurally a `SourceResult`. */
export interface MatrixLaneResult {
  readonly claims: readonly SourcedClaim[];
  readonly ok: boolean;
  readonly note?: string;
}

/** The lanes settled so far, keyed by lane. An absent key is still in flight. */
export type MatrixLaneResults = ReadonlyMap<MatrixLaneKey, MatrixLaneResult>;

/** Build the four empty cells of one horizon, all waiting on their lanes. */
export function createHorizonCells(
  horizon: HorizonKey
): Record<HazardKey, HazardCell> {
  const cells = {} as Record<HazardKey, HazardCell>;
  for (const hazard of HAZARD_KEYS) {
    const lanes = lanesForCell(horizon, hazard);
    cells[hazard] = {
      hazard,
      horizon,
      label: HAZARD_LABELS[hazard],
      claims: [],
      // A cell no lane feeds never loads, so it says what it is missing from
      // the first paint rather than spinning for a source that will not come.
      status: lanes.length > 0 ? 'loading' : 'unavailable',
      ...(lanes.length > 0 ? {} : { note: CELL_ABSENCE[horizon][hazard] })
    };
  }
  return cells;
}

/** Put every cell of one horizon into the same explicit state. */
export function markHorizonCells(
  horizon: Horizon,
  status: HorizonStatus,
  note: string
): void {
  for (const hazard of HAZARD_KEYS) {
    const cell = horizon.cells[hazard];
    cell.claims = [];
    cell.status = status;
    cell.note = note;
  }
  horizon.claims = [];
  horizon.status = status;
}

/** The lanes declared for one cell. */
export function lanesForCell(
  horizon: HorizonKey,
  hazard: HazardKey
): readonly MatrixLaneKey[] {
  return MATRIX_LANE_KEYS.filter((key) => {
    const placement = LANE_PLACEMENT[key];
    return (
      placement.horizons.includes(horizon) && placement.hazards.includes(hazard)
    );
  });
}

/** Whether one claim from `lane` belongs in the cell at (horizon, hazard). */
function claimBelongs(
  claim: SourcedClaim,
  lane: MatrixLaneKey,
  horizon: HorizonKey,
  hazard: HazardKey
): boolean {
  const placement = LANE_PLACEMENT[lane];
  const claimHorizon = claim.horizon ?? placement.horizons[0];
  const claimHazards = claim.hazards ?? placement.hazards;
  return claimHorizon === horizon && claimHazards.includes(hazard);
}

/**
 * Recompute one cell from the lanes declared for it. Idempotent: it reads the
 * settled results and writes the whole cell, so a later publish cannot leave
 * a stale claim or a stale note behind.
 */
export function fillCell(cell: HazardCell, results: MatrixLaneResults): void {
  const lanes = lanesForCell(cell.horizon, cell.hazard);
  const claims: SourcedClaim[] = [];
  const notes: string[] = [];
  let settled = 0;
  let answered = 0;

  for (const lane of lanes) {
    const result = results.get(lane);
    if (!result) continue;
    settled += 1;
    if (result.ok) {
      answered += 1;
      for (const claim of result.claims) {
        if (claimBelongs(claim, lane, cell.horizon, cell.hazard)) {
          claims.push(claim);
        }
      }
    } else if (result.note) {
      notes.push(result.note);
    }
  }

  cell.claims = claims;
  const pending = lanes.length - settled;
  if (lanes.length === 0) {
    cell.status = 'unavailable';
  } else if (pending > 0) {
    // A lane is still in flight, so the cell has not settled: what is already
    // in hand reads live (partial), and an empty cell keeps loading rather
    // than announcing an absence that may yet fill.
    cell.status = claims.length > 0 ? 'partial' : 'loading';
  } else if (claims.length === 0) {
    // Every lane settled and the cell has nothing to say. That is an honest
    // absence, never a live cell with an empty body.
    cell.status = 'unavailable';
  } else if (answered === lanes.length) {
    cell.status = 'ready';
  } else {
    cell.status = 'partial';
  }

  const note = notes.length > 0 ? notes.join(' ') : null;
  if (note !== null) {
    cell.note = note;
  } else if (cell.status === 'unavailable') {
    cell.note = CELL_ABSENCE[cell.horizon][cell.hazard];
  } else {
    delete cell.note;
  }
}

/** Fold four cell statuses into the horizon's own summary status. */
function horizonStatus(cells: readonly HazardCell[]): HorizonStatus {
  const every = (status: HorizonStatus): boolean =>
    cells.every((cell) => cell.status === status);
  if (every('loading')) return 'loading';
  if (every('ready')) return 'ready';
  if (every('unavailable')) return 'unavailable';
  return 'partial';
}

/**
 * Recompute all twelve cells from the lanes settled so far, and refresh each
 * horizon's flattened claim list and summary status.
 *
 * The horizon's status is a summary of its four cells and carries no issuer
 * and no validity date of its own; every issuer and every clock stays on the
 * claim that owns it.
 */
export function applyMatrix(
  horizons: Record<HorizonKey, Horizon>,
  results: MatrixLaneResults
): void {
  for (const horizonKey of HORIZON_KEYS) {
    const horizon = horizons[horizonKey];
    const cells = HAZARD_KEYS.map((hazard) => horizon.cells[hazard]);
    for (const cell of cells) fillCell(cell, results);
    horizon.claims = cells.flatMap((cell) => cell.claims);
    horizon.status = horizonStatus(cells);
  }
}
