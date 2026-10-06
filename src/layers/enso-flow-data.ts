import type { EnsoFlowKind } from '../state/enso-flow';
import { isObject } from '../util/guards';

export type ActiveFlowKind = Exclude<EnsoFlowKind, 'off'>;
/** The kinds drawn from NOAA NODD as flowing paths (ENSO-FLOW-PLAN E2-1). */
export type FlowFieldKind = Exclude<ActiveFlowKind, 'currents'>;
export interface FlowPoint {
  readonly longitude: number;
  readonly latitude: number;
  /** Direction towards which water travels, degrees clockwise from north. */
  readonly bearing: number;
  readonly value: number;
}
export interface FlowFrame {
  readonly time: number;
  readonly points: readonly FlowPoint[];
  readonly missing: number;
  readonly total: number;
}

/**
 * The Open-Meteo variables of the one kind still read from Open-Meteo, ocean
 * currents (the DR-161 interim, ENSO-FLOW-PLAN owner question 4). Wind and
 * waves read NOAA NODD through the lazy flow chunk (src/layers/flow/).
 */
export const FLOW_VARIABLES = {
  currents: ['ocean_current_velocity', 'ocean_current_direction']
} as const satisfies Record<'currents', readonly [string, string]>;

/** Validate the complete bounded response. Never join values from different valid times. */
export function parseFlowFrame(json: unknown, kind: 'currents', expectedCount: number): FlowFrame {
  if (kind !== 'currents') throw new Error('Only ocean currents are sampled.');
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length !== expectedCount || expectedCount < 1 || expectedCount > 40) {
    throw new Error('The flow response has an unexpected location count.');
  }
  const [valueKey, directionKey] = FLOW_VARIABLES[kind];
  const points: FlowPoint[] = [];
  let time: number | null = null;
  let missing = 0;
  for (const row of rows) {
    if (!isObject(row) || !isObject(row.current) || !isObject(row.current_units)) {
      throw new Error('The flow response is missing its current data.');
    }
    const current = row.current;
    const units = row.current_units;
    const stamp = current.time;
    if (typeof stamp !== 'number' || !Number.isSafeInteger(stamp) || stamp <= 0 || units.time !== 'unixtime') {
      throw new Error('The flow response has no verified valid time.');
    }
    if (time !== null && time !== stamp * 1000) throw new Error('Flow valid times disagree.');
    time = stamp * 1000;
    const longitude = row.longitude;
    const latitude = row.latitude;
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
        typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
      throw new Error('The flow response has an invalid grid position.');
    }
    const value = current[valueKey];
    const direction = current[directionKey];
    // A masked marine cell stays absent. Null is never a zero velocity.
    if (value === null && direction === null) { missing += 1; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        typeof direction !== 'number' || !Number.isFinite(direction) || direction < 0 || direction > 360 ||
        units[directionKey] !== '°') throw new Error('The flow response has invalid values.');
    const unit = units[valueKey];
    const factor = unit === 'm/s' ? 1 : unit === 'km/h' ? 1 / 3.6 : null;
    if (factor === null) throw new Error('The flow response has unexpected units.');
    // Ocean-current direction is TO, so it is the travel bearing as given.
    points.push({ longitude, latitude, bearing: direction % 360, value: value * factor });
  }
  if (time === null) throw new Error('The flow response is empty.');
  return { time, points, missing, total: rows.length };
}

export function normalizeFlowLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

/** A dated instant in UTC: month, day, hour, minute and "UTC" (one source for the panel and the key). */
export function dateLabel(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(time);
}

/**
 * Every sentence the ENSO wind and wave paths show, in the panel and the
 * map key's drawer row, from this one table (ENSO-FLOW-PLAN E2-1; C-fit.md
 * section 3). Every entry but `provenance` for wind is DDM's own wording and
 * waits for the owner's read-back (DR-177 (5)); each carries its C-fit.md
 * DRAFT number. A flow string never says now, right now, currently,
 * real-time, latest or today, claims no forecast and no transport, and uses
 * "path of" only inside the one negation of DRAFT 7 (tests/flow-wire.spec.ts).
 */
export const FLOW_WORDS = {
  // The owner's words (RATIFICATION-11 row 15), verbatim, as text: never an
  // attribution line or an emblem.
  // DRAFT wording (DR-177): the same words for GFS-Wave (C-fit.md 1.11; ENSO-FLOW-PLAN question 6).
  provenance: 'derived from NOAA GFS',
  // DRAFT wording (DR-177): C-fit DRAFT 1, "Model run <date>" in the line.
  modelRun: 'Model run',
  // DRAFT wording (DR-177): C-fit DRAFT 2, the loading words (C-fit.md 1.5).
  loading: { wind: 'NOAA GFS wind', waves: 'NOAA GFS-Wave' },
  // DRAFT wording (DR-177): C-fit DRAFT 3, the unavailable words.
  unavailable: { wind: 'NOAA GFS wind did not load', waves: 'NOAA GFS-Wave did not load' },
  // DRAFT wording (DR-177): C-fit DRAFT 4, the past-24-hour stale words (moving-paths section 11).
  staleModel: { wind: 'NOAA GFS', waves: 'NOAA GFS-Wave' },
  // DRAFT wording (DR-177): C-fit DRAFT 4, the stale words around the model name and run date.
  stale: { lead: 'The held', from: 'frame from', tail: 'is past its 24-hour limit' },
  // DRAFT wording (DR-177): C-fit DRAFT 5 (moving-paths section 11).
  noOcean: 'No ocean values in this view',
  // DRAFT wording (DR-177): C-fit.md 1.5, the live (partial) row's uncovered part named (the wave box).
  outside: 'This view is outside the area the wave marks cover',
  // DRAFT wording (DR-177): C-fit.md 1.5, the live (partial) row's uncovered part named (the wave box).
  waveBox: 'Wave marks cover 10 S to 62 N and 165 E to 100 W only; nothing is drawn outside that area.',
  // DRAFT wording (DR-177): C-fit DRAFT 6 (moving-paths section 7).
  pace: 'Line pace shows relative speed within this field; it is not real time.',
  // DRAFT wording (DR-177): C-fit DRAFT 7, scientific (moving-paths section 7); the one "path of".
  instant: 'Lines show the modeled flow at one instant, not the path of anything carried by it.',
  // DRAFT wording (DR-177): C-fit DRAFT 8, scientific (moving-paths section 7).
  modelOutput: 'Model output, not an observation.',
  // DRAFT wording (DR-177): C-fit DRAFT 9, the mask sentence ending "does not mean calm water".
  mask: 'No marks within one grid cell of the coast or where the model has no water value; no marks does not mean calm water.',
  // DRAFT wording (DR-177): C-fit DRAFT 10, the form notes.
  paused: 'Motion is paused, so the lines hold still.',
  // DRAFT wording (DR-177): C-fit DRAFT 10, the form notes.
  reduced: 'The lines hold still because this device asks for reduced motion.',
  // DRAFT wording (DR-177): C-fit DRAFT 10, the form notes (moving-paths section 7).
  sst: 'Lines hold still while the sea surface temperature days play; this frame keeps its own time.',
  // DRAFT wording (DR-177): the context-loss detail sentence (moving-paths section 14; ENSO-FLOW-PLAN question 6).
  context: 'The lines hold still because the browser reset graphics.',
  // DRAFT wording (DR-177): the failed-rebuild detail (moving-paths section 14: "fall to the still form and say so").
  rebuildFailed: 'The lines hold still because the browser could not rebuild their graphics.',
  // DRAFT wording (DR-177): C-fit DRAFT 11, the bins in real units.
  bins: {
    wind: 'Line width and brightness: under 5, 5 to 10, 10 or more m/s.',
    waves: 'Mark length and brightness: under 2, 2 to 4, 4 or more m significant wave height.'
  },
  // DRAFT wording (DR-177): C-fit DRAFT 11.
  binsNote: 'Display bins, not thresholds.',
  // DRAFT wording (DR-177): C-fit DRAFT 12, the R5 (a) wave sentences, scientific (moving-paths section 9).
  waves: 'Marks move the way the primary waves travel, all at one display speed; wave speed is not shown. The water does not travel with the marks.',
  // DRAFT wording (DR-177): C-fit DRAFT 13 (moving-paths section 7).
  pastGrid: "Zoomed in past the model grid: showing the values at the model's own points.",
  // DRAFT wording (DR-177): past the grid with no model node inside the view (block E2b review P1); nothing is drawn.
  noModelPoint: "No model point falls inside this view; zoom out to see the model's values.",
  // DRAFT wording (DR-177): actual grid points can have calm or masked values.
  noNodeDirection: 'Model points fall inside this view, but none has a direction mark.'
} as const;

/** The parts of the flow view's state (src/layers/flow/index.ts FlowViewState) the form note reads. */
export interface FlowFormState {
  readonly form: 'moving' | 'still' | 'arrows' | 'none';
  readonly motion: string;
  readonly hold: string | null;
  readonly rebuildFailed: boolean;
  readonly nodesInView: boolean;
  readonly features: number;
}

/**
 * The one sentence that says why the lines look as they do, or null: past
 * the grid, the node arrows (or, with no model node inside the view, that
 * none falls there, since nothing is drawn); in the still form, the reason
 * the lines hold still. The moving form needs no note.
 */
export function flowFormNote(state: FlowFormState): string | null {
  if (state.form === 'arrows') {
    if (!state.nodesInView) return FLOW_WORDS.noModelPoint;
    return state.features > 0 ? FLOW_WORDS.pastGrid : FLOW_WORDS.noNodeDirection;
  }
  if (state.form !== 'still') return null;
  if (state.rebuildFailed) return FLOW_WORDS.rebuildFailed;
  if (state.hold === 'context') return FLOW_WORDS.context;
  if (state.hold === 'sst') return FLOW_WORDS.sst;
  if (state.motion === 'reduced') return FLOW_WORDS.reduced;
  if (state.motion === 'paused') return FLOW_WORDS.paused;
  return null;
}

/** `<status> · Model run <date> · Model valid <date>`: no forecast hour, no "now". */
export function flowLiveLine(status: 'live' | 'live (partial)', cycle: number, validTime: number): string {
  return `${status} · ${FLOW_WORDS.modelRun} ${dateLabel(cycle)} · Model valid ${dateLabel(validTime)}`;
}

/** The stale line: the held frame's run and its 24-hour limit. */
export function flowStaleLine(kind: FlowFieldKind, cycle: number): string {
  const { lead, from, tail } = FLOW_WORDS.stale;
  return `unavailable · ${lead} ${FLOW_WORDS.staleModel[kind]} ${from} ${dateLabel(cycle)} ${tail}`;
}
