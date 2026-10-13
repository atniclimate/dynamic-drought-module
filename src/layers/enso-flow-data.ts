import type { EnsoFlowKind } from '../state/enso-flow';
import type { ScalarKind } from './flow/shade';

export type ActiveFlowKind = Exclude<EnsoFlowKind, 'off'>;
/**
 * The kinds drawn as a still shade and never as lines (src/layers/flow/shade.ts):
 * no ink, no motion and no direction. Typed here because the panel asks before
 * the lazy flow chunk is in.
 */
export const isShadeKind = (kind: EnsoFlowKind): kind is ScalarKind => kind === 'pwat';
/** The kinds read from NOAA NODD at runtime (ENSO-FLOW-PLAN E2-1): every kind but the committed currents frame. */
export type FlowFieldKind = Exclude<ActiveFlowKind, 'currents'>;
/** One string per kind: a kind without its words does not compile. */
type FlowKindWords = Readonly<Record<ActiveFlowKind, string>>;

/** A dated instant in UTC: month, day, hour, minute and "UTC" (one source for the panel and the key). */
export function dateLabel(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(time);
}

/**
 * Every sentence the ENSO wind, wave and current paths show, in the panel and the
 * map key's drawer row, from this one table (ENSO-FLOW-PLAN E2-1; C-fit.md
 * section 3). Every entry is DDM's own wording and waits for the owner's
 * read-back (DR-177 (5)); each carries its C-fit.md DRAFT number. The GFS
 * credits open with the owner's own words. A flow string never says now, right now, currently,
 * real-time, latest or today, and claims no forecast and no transport
 * (tests/flow-wire.spec.ts). The key keeps what decodes its symbols (the
 * bins) and the live state; the sentences that explain the paths read in the
 * Impact Briefing (src/ui/map-technical-information.ts FLOW_TECHNICAL_NOTES).
 * Precipitable water is named by the issuer's field name and never as a
 * weather feature, a rain amount or a movement of moisture: it is a column
 * total at one model instant (admission gfs-runtime-nodd, 2026-10-13).
 */
export const FLOW_WORDS = {
  // The credit under the state line, as text: never an attribution line or an emblem.
  // DRAFT wording (DR-177): the owner's words (RATIFICATION-11 row 15, "derived from NOAA GFS"), each followed by
  // the kind's own field, so the wind at 10 m and at 250 hPa do not read alike (C-fit.md 1.11 for GFS-Wave). The
  // currents credit is short for admission rtofs-currents-producer line 11 ("Surface currents: NOAA/NCEP Global
  // RTOFS, run <date> 00Z, valid <UTC>, re-encoded by DDM (model)"); its run and valid instant read in the state line.
  provenance: {
    wind: 'derived from NOAA GFS 10 m wind', jet: 'derived from NOAA GFS 250 hPa wind', waves: 'derived from NOAA GFS-Wave',
    currents: 'NOAA Global RTOFS, re-encoded by DDM', pwat: 'derived from NOAA GFS precipitable water'
  } satisfies FlowKindWords,
  // DRAFT wording (DR-177): C-fit DRAFT 1, "Model run <date>" in the line.
  modelRun: 'Model run',
  // DRAFT wording (DR-177): C-fit DRAFT 2, the kind's source by name: the loading line and the live line read it (C-fit.md 1.5).
  source: {
    wind: 'NOAA GFS 10 m wind', jet: 'NOAA GFS 250 hPa wind', waves: 'NOAA GFS-Wave', currents: 'NOAA RTOFS surface currents',
    pwat: 'NOAA GFS precipitable water'
  } satisfies FlowKindWords,
  // DRAFT wording (DR-177): C-fit DRAFT 3, the unavailable words.
  unavailable: {
    wind: 'NOAA GFS 10 m wind did not load', jet: 'NOAA GFS 250 hPa wind did not load', waves: 'NOAA GFS-Wave did not load',
    currents: 'NOAA RTOFS surface currents did not load', pwat: 'NOAA GFS precipitable water did not load'
  } satisfies FlowKindWords,
  // DRAFT wording (DR-177): C-fit DRAFT 4, the past-24-hour stale words (moving-paths section 11).
  // The currents frame has no such limit: it is a dated frame whose age is stated (CONTRADICTIONS-4 Q3 a).
  staleModel: {
    wind: 'NOAA GFS', jet: 'NOAA GFS', waves: 'NOAA GFS-Wave', pwat: 'NOAA GFS'
  } satisfies Readonly<Record<FlowFieldKind, string>>,
  // DRAFT wording (DR-177): C-fit DRAFT 4, the stale words around the model name and run date.
  stale: { lead: 'The held', from: 'frame from', tail: 'is past its 24-hour limit' },
  // DRAFT wording (DR-177): C-fit DRAFT 5 (moving-paths section 11).
  noOcean: 'No ocean values in this view',
  // DRAFT wording (DR-177): C-fit.md 1.5, the live (partial) row's uncovered part named (the wave box).
  outside: 'This view is outside the area the wave marks cover',
  // DRAFT wording (DR-177): the same row for the currents grid under the view (admission rtofs-currents-producer line 8).
  currentsOutside: 'This view is outside the area this ocean current grid covers',
  // DRAFT wording (DR-177): C-fit.md 1.5, the live (partial) row's uncovered part named (the wave box).
  waveBox: 'Wave marks cover 10 S to 62 N and 165 E to 100 W only; nothing is drawn outside that area.',
  // DRAFT wording (DR-177): C-fit DRAFT 9, the mask sentence ending "does not mean calm water" (the no-data state's reason).
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
  // DRAFT wording (DR-177): C-fit DRAFT 11, the bins in real units (src/layers/flow/field.ts FLOW_BINS; tests/flow-advect.test.mjs).
  bins: {
    wind: 'Line width and brightness: under 5, 5 to 10, 10 or more m/s.',
    jet: 'Line width and brightness: under 20, 20 to 40, 40 or more m/s.',
    waves: 'Mark length and brightness: under 2, 2 to 4, 4 or more m significant wave height.',
    currents: 'Line width and brightness: under 0.25, 0.25 to 0.5, 0.5 or more m/s.',
    // DRAFT wording (DR-177): the shade's steps in the issuer's unit (src/layers/flow/shade.ts SHADE_BINS; tests/flow-shade.test.mjs).
    pwat: 'Shade deepens in steps: none under 15, then 15 to 30, 30 to 45, 45 or more kg m-2.'
  } satisfies FlowKindWords,
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

/**
 * How old a dated frame is at `now`, in whole days since its valid instant.
 */
// DRAFT wording (DR-177): the age of the currents frame (CONTRADICTIONS-4 Q3 a: run, valid instant and age stated).
export function flowAgeWords(validTime: number, now: number): string {
  const days = Math.max(0, Math.floor((now - validTime) / 86_400_000));
  return days < 1 ? 'frame under 1 day old' : `frame ${days} ${days === 1 ? 'day' : 'days'} old`;
}

/**
 * `<status> · <the kind's source> · Model run <date> · Model valid <date>`: no
 * forecast hour, no "now". A dated frame (currents) passes the clock as
 * `ageAt` and gains its age.
 */
export function flowLiveLine(
  status: 'live' | 'live (partial)', kind: ActiveFlowKind, cycle: number, validTime: number, ageAt?: number
): string {
  const line = `${status} · ${FLOW_WORDS.source[kind]} · ${FLOW_WORDS.modelRun} ${dateLabel(cycle)} · Model valid ${dateLabel(validTime)}`;
  return ageAt === undefined ? line : `${line} · ${flowAgeWords(validTime, ageAt)}`;
}

/** A regional grid's node box in words ("40 S to 39 N and 130 E to 111 W"), from the grid itself. */
export function gridBoxWords(grid: {
  readonly lon0: number; readonly lat0: number; readonly dlon: number; readonly dlat: number; readonly nx: number; readonly ny: number;
}): string {
  const degrees = (x: number, plus: string, minus: string): string => `${Number(Math.abs(x).toFixed(1))} ${x < 0 ? minus : plus}`;
  const lon = (x: number): string => degrees(((x + 180) % 360 + 360) % 360 - 180, 'E', 'W');
  const south = grid.lat0 - (grid.ny - 1) * grid.dlat;
  return `${degrees(south, 'N', 'S')} to ${degrees(grid.lat0, 'N', 'S')} and ${lon(grid.lon0)} to ${lon(grid.lon0 + (grid.nx - 1) * grid.dlon)}`;
}

// DRAFT wording (DR-177): the wave box sentence, for the currents grid under the view.
export function currentsBoxNote(grid: Parameters<typeof gridBoxWords>[0]): string {
  return `Ocean current lines in this view cover ${gridBoxWords(grid)} only; nothing is drawn outside that area.`;
}

/** The stale line: the held frame's run and its 24-hour limit. */
export function flowStaleLine(kind: FlowFieldKind, cycle: number): string {
  const { lead, from, tail } = FLOW_WORDS.stale;
  return `unavailable · ${lead} ${FLOW_WORDS.staleModel[kind]} ${from} ${dateLabel(cycle)} ${tail}`;
}
