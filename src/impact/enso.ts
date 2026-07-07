/**
 * El Nino / Southern Oscillation (ENSO) long-range modifier.
 *
 * Reads the bundled ENSO index snapshot (the Oceanic Nino Index, ONI, and the
 * Relative ONI, RONI; built at commit time by scripts/build-enso-snapshot.mjs
 * from the no-CORS CPC sources) and turns the current ENSO state into a
 * long-range tilt claim for the Pacific Northwest, with a chart that plots both
 * indices. The claim modifies the seasonal outlook framing: El Nino strengthens
 * a "drought persists or develops" read and tilts the following fire and heat
 * season toward elevated risk; La Nina reverses it, with the grass-fine-fuel
 * caveat; a neutral phase leaves the outlook resting on the CPC products and
 * current conditions.
 *
 * RONI is carried as a corroborating index: it removes the tropical-mean ocean
 * warming background, so in a warming climate it often reads cooler than the raw
 * ONI. When the two diverge, that is surfaced honestly, because RONI is the
 * better gauge of the relative state.
 *
 * Honesty (ddm-enso-correlation): ENSO shifts the odds, it does not set the
 * outcome. Every statement is a tilt with the modulators named (the Pacific
 * Decadal Oscillation, event strength and timing, and intraseasonal
 * variability), and it cites the ONI and RONI read alongside the CPC Seasonal
 * Drought Outlook in the same horizon.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { oniLineSvg, ensoPlumeSvg, type OniPoint, type EnsoPlumePoint } from '../ui/charts';
import type { SourceResult } from './sources';
import type { BoundarySelectionContext } from './types';

type EnsoPhase = 'el-nino' | 'la-nina' | 'neutral';

interface IndexSeries {
  readonly phase: EnsoPhase;
  readonly latest: OniPoint;
  readonly values: OniPoint[];
}

/** The optional CPC probabilities block (present when the build-time scrape
 * succeeded; absent is an honest no-plume state, never an error). */
interface EnsoProbabilities {
  readonly sourceUrl: string;
  readonly issued: string | null;
  readonly baseline: string;
  readonly seasons: EnsoPlumePoint[];
}

interface EnsoSnapshot {
  readonly retrieved: string;
  readonly oni: IndexSeries;
  readonly roni: IndexSeries;
  readonly probabilities?: EnsoProbabilities;
}

const SOURCE = 'NOAA CPC Oceanic Nino Index and Relative ONI';
const SOURCE_URL = 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/';
const MODULATORS =
  'This is a shift in the odds, not a forecast: the Pacific Decadal Oscillation, the event strength and timing, and intraseasonal variability can reinforce or mute the signal.';

/**
 * A snapshot-provenance sentence. The ENSO phase is read from a build-time
 * snapshot, so the prose carries its retrieval date (not only the chart), and
 * degrades from an unqualified present-tense read to a dated, hedged one once
 * the snapshot is old enough that a new ONI/RONI season has likely posted. This
 * keeps the horizon honest even when the chart is absent (the honest-feedback
 * invariant; CLAUDE.md section 6).
 */
/**
 * Hard staleness cutoff (#14). Past this age a new ONI/RONI season has very
 * likely posted and the phase may have flipped, so the present-tense phase
 * claim in `tiltText` degrades to a dated past-tense read rather than asserting
 * a possibly-stale phase as current. The 45-day soft hedge below still applies
 * earlier for the provenance sentence.
 */
const HARD_STALE_DAYS = 120;

/** Age of a snapshot in days, or null when the date does not parse. */
function snapshotAgeDays(retrieved: string): number | null {
  const ms = Date.parse(`${retrieved}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / 86_400_000;
}

function snapshotProvenance(retrieved: string): string {
  const ageDays = snapshotAgeDays(retrieved);
  if (ageDays === null) {
    return ` This ENSO read is from the CPC index snapshot dated ${retrieved}.`;
  }
  if (ageDays > 45) {
    const weeks = Math.round(ageDays / 7);
    return ` This ENSO read is from the CPC index snapshot retrieved ${retrieved}, now about ${weeks} weeks old and possibly out of date; refresh the snapshot for the current state.`;
  }
  return ` This ENSO read is from the CPC index snapshot retrieved ${retrieved}.`;
}

/** Format a signed anomaly, for example "+0.11" or "-0.48". */
function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** Format the latest reading, for example "+0.11 (FMA 2026)". */
function latestStr(latest: OniPoint): string {
  return `${signed(latest.anom)} (${latest.seas} ${latest.year})`;
}

/** The PNW long-range tilt text for the primary (ONI) phase. */
function tiltText(phase: EnsoPhase, latest: OniPoint, retrieved: string): string {
  const oni = latestStr(latest);

  // Hard-stale snapshot (#14): do not assert a possibly-changed phase in the
  // present tense. State it as a dated past reading, nudge a refresh, and drop
  // the confident seasonal tilt (which should not rest on a stale phase). The
  // shift-in-odds modulators still apply.
  const ageDays = snapshotAgeDays(retrieved);
  if (ageDays !== null && ageDays > HARD_STALE_DAYS) {
    const weeks = Math.round(ageDays / 7);
    const wasPhase =
      phase === 'neutral'
        ? 'neutral'
        : `in ${phase === 'el-nino' ? 'an El Nino' : 'a La Nina'} phase`;
    return (
      `As of the CPC snapshot dated ${retrieved} (about ${weeks} weeks old, so a new ONI season has likely posted and the phase may have changed), ENSO was ${wasPhase} (ONI ${oni}). Refresh the snapshot for the current phase before relying on the long-range tilt. ` +
      MODULATORS
    );
  }

  switch (phase) {
    case 'el-nino':
      return (
        `ENSO is in an El Nino phase (latest ONI ${oni}). For the Pacific Northwest this tilts the odds toward a warmer, drier winter with below-normal snowpack and an earlier melt-out, which strengthens a "drought persists or develops" read and tilts the following fire and heat season toward elevated risk. ` +
        MODULATORS
      );
    case 'la-nina':
      return (
        `ENSO is in a La Nina phase (latest ONI ${oni}). For the Pacific Northwest this tilts the odds toward a cooler, wetter winter with above-normal snowpack, which weakens a "drought persists or develops" read. La Nina is not a blanket all-clear for fire: a wet, productive winter can grow abundant fine fuels that cure through summer, so an active grass-fire season is still possible, especially east of the Cascades. ` +
        MODULATORS
      );
    default:
      return (
        `ENSO is currently neutral (latest ONI ${oni}). A neutral phase offers little long-range signal for the Pacific Northwest, so the seasonal tilt rests on the CPC Seasonal Drought Outlook and current conditions (snowpack, soil moisture, the U.S. Drought Monitor) rather than the ocean state. ` +
        MODULATORS
      );
  }
}

const PHASE_NAME: Record<EnsoPhase, string> = { 'el-nino': 'El Nino', 'la-nina': 'La Nina', neutral: 'neutral' };

/**
 * One sentence comparing the warming-adjusted Relative ONI to the raw ONI. When
 * RONI lands in a different ENSO phase, or reads meaningfully cooler or warmer,
 * that divergence is surfaced because RONI is the better gauge of the relative
 * state in a warming climate.
 */
function roniCorroboration(oni: IndexSeries, roni: IndexSeries): string {
  const o = oni.latest.anom;
  const r = roni.latest.anom;
  const rStr = signed(r);

  if (roni.phase !== 'neutral' && roni.phase !== oni.phase) {
    return `The warming-adjusted Relative ONI (RONI ${rStr}) sits in ${PHASE_NAME[roni.phase]} territory even though the raw ONI does not; because RONI removes the background ocean warming, weight the ${PHASE_NAME[roni.phase]} side of the odds in a warming climate.`;
  }
  if (r < o - 0.1) {
    const nearLaNina = r <= -0.4 && r > -0.5;
    return `The warming-adjusted Relative ONI is cooler at ${rStr}${nearLaNina ? ', just shy of the La Nina threshold' : ''}; removing the background ocean warming, the relative state leans cooler than the raw index, nudging the odds toward the cooler, wetter side.`;
  }
  if (r > o + 0.1) {
    const nearElNino = r >= 0.4 && r < 0.5;
    return `The warming-adjusted Relative ONI is warmer at ${rStr}${nearElNino ? ', near the El Nino threshold' : ''}; the relative state leans warmer than the raw index.`;
  }
  return `The warming-adjusted Relative ONI agrees (RONI ${rStr}), so the read does not hinge on background ocean warming.`;
}

function isIndexSeries(v: unknown): v is IndexSeries {
  return isObject(v) && isObject(v.latest) && Array.isArray(v.values) && typeof v.phase === 'string';
}

function isPlumePoint(v: unknown): v is EnsoPlumePoint {
  return (
    isObject(v) &&
    typeof v.seas === 'string' &&
    typeof v.laNina === 'number' &&
    typeof v.neutral === 'number' &&
    typeof v.elNino === 'number'
  );
}

function isProbabilities(v: unknown): v is EnsoProbabilities {
  return (
    isObject(v) &&
    typeof v.sourceUrl === 'string' &&
    typeof v.baseline === 'string' &&
    (typeof v.issued === 'string' || v.issued === null) &&
    Array.isArray(v.seasons) &&
    v.seasons.length >= 2 &&
    v.seasons.every(isPlumePoint)
  );
}

/**
 * One sentence naming the most likely ENSO state at the far end of the plume.
 * Worded as odds, never as an outcome.
 */
function plumeHeadline(p: EnsoProbabilities): string {
  const far = p.seasons[p.seasons.length - 1]!;
  const categories = [
    { name: 'El Nino', pct: far.elNino },
    { name: 'ENSO-neutral', pct: far.neutral },
    { name: 'La Nina', pct: far.laNina }
  ].sort((a, b) => b.pct - a.pct);
  const lead = categories[0]!;
  const issued = p.issued ? ` (issued ${p.issued})` : '';
  return `The official CPC probabilistic outlook${issued} puts the ${far.seas} odds at ${lead.pct}% ${lead.name}.`;
}

/**
 * Build the ENSO long-range claim from the bundled snapshot, with a chart that
 * plots ONI and RONI together. The snapshot is local (the no-CORS CPC sources
 * were read at build time), so this is a fast read; it still goes through
 * `fetchWithBudget` with the master signal so a hung load cannot block the
 * horizon.
 */
/** Load and validate the bundled ENSO snapshot. Throws on any malformation.
 * The probabilities block is optional: a malformed one is dropped (indices
 * still render), never fatal. */
async function loadEnsoSnapshot(signal: AbortSignal): Promise<EnsoSnapshot> {
  const resp = await fetchWithBudget(URLS.ensoIndicesLocal, { headers: { Accept: 'application/json' } }, signal, 6000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json: unknown = await resp.json();
  if (!isObject(json) || !isIndexSeries(json.oni) || !isIndexSeries(json.roni)) {
    throw new Error('malformed ENSO snapshot');
  }
  const snap = json as unknown as EnsoSnapshot & { probabilities?: unknown };
  if (snap.probabilities !== undefined && !isProbabilities(snap.probabilities)) {
    console.warn('[enso] malformed probabilities block in snapshot; plume omitted.');
    const { probabilities: _dropped, ...rest } = snap;
    return rest as EnsoSnapshot;
  }
  return snap as EnsoSnapshot;
}

/** The compact read for the sidebar ENSO driver line (0.4.0 B2 slice 1). */
export interface EnsoDriverSummary {
  /** "El Nino", "La Nina", or "neutral". */
  readonly phaseName: string;
  /** For example "ONI -0.48 (FMA 2026)". */
  readonly latest: string;
  /** A five-or-so-word Pacific Northwest tilt, phase-appropriate. */
  readonly shortTilt: string;
  /** The full tilt paragraph (odds-never-outcomes, modulators named). */
  readonly detail: string;
  /** Snapshot retrieval date, for provenance. */
  readonly retrieved: string;
  /** Source link for the details block. */
  readonly sourceUrl: string;
}

const SHORT_TILT: Record<EnsoPhase, string> = {
  'el-nino': 'winters tilt warmer and drier here',
  'la-nina': 'winters tilt cooler and wetter here',
  neutral: 'little long-range signal'
};

/**
 * The one-line ENSO driver summary for the sidebar, from the bundled snapshot.
 * Returns null on any failure (missing or malformed snapshot, abort); the
 * caller hides the line rather than showing a faked phase.
 */
export async function fetchEnsoDriverSummary(
  signal: AbortSignal
): Promise<EnsoDriverSummary | null> {
  try {
    const snap = await loadEnsoSnapshot(signal);
    if (signal.aborted) return null;
    return {
      phaseName: PHASE_NAME[snap.oni.phase],
      latest: `ONI ${latestStr(snap.oni.latest)}`,
      shortTilt: SHORT_TILT[snap.oni.phase],
      detail:
        `${tiltText(snap.oni.phase, snap.oni.latest, snap.retrieved)} ${roniCorroboration(snap.oni, snap.roni)}` +
        (snap.probabilities ? ` ${plumeHeadline(snap.probabilities)}` : '') +
        snapshotProvenance(snap.retrieved),
      retrieved: snap.retrieved,
      sourceUrl: SOURCE_URL
    };
  } catch (err) {
    if (!signal.aborted) console.warn('[enso] driver summary read failed.', err);
    return null;
  }
}

export async function fetchEnsoClaims(
  _context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  try {
    const snap = await loadEnsoSnapshot(signal);
    if (signal.aborted) return { claims: [], ok: false };

    const text =
      `${tiltText(snap.oni.phase, snap.oni.latest, snap.retrieved)} ${roniCorroboration(snap.oni, snap.roni)}` +
      snapshotProvenance(snap.retrieved);

    const chartSvg = oniLineSvg(snap.oni.values, {
      title: 'Observed ONI and warming-adjusted RONI over recent seasons',
      source: `CPC ONI and RONI, retrieved ${snap.retrieved}`,
      primaryLabel: 'ONI',
      compare: { values: snap.roni.values, label: 'RONI' }
    });

    // The forward plume (odds by season), when the build-time scrape landed.
    // Absent probabilities are an honest no-plume state, not an error.
    const plumeClaims = [];
    if (snap.probabilities) {
      const p = snap.probabilities;
      const plumeSvg = ensoPlumeSvg(p.seasons, {
        title: 'Official CPC odds of El Nino, neutral, and La Nina by season',
        source: `NOAA CPC probabilistic ENSO outlook${p.issued ? `, issued ${p.issued}` : ''}`
      });
      if (plumeSvg) {
        plumeClaims.push({
          text:
            `${plumeHeadline(p)} These are odds across overlapping three-month seasons, not a forecast of outcomes; ` +
            `the categories are defined against the ${p.baseline}.`,
          source: 'NOAA CPC official probabilistic ENSO outlook (CPC/IRI consensus)',
          sourceUrl: p.sourceUrl,
          kind: 'outlook' as const,
          chartSvg: plumeSvg
        });
      }
    }

    return {
      ok: true,
      claims: [
        {
          text,
          source: SOURCE,
          sourceUrl: SOURCE_URL,
          kind: 'outlook',
          ...(chartSvg ? { chartSvg } : {})
        },
        ...plumeClaims
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] ENSO snapshot read failed.', err);
    return { claims: [], ok: false, note: 'The ENSO index snapshot was unavailable.' };
  }
}
