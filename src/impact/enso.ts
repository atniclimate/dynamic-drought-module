/**
 * El Nino / Southern Oscillation (ENSO) long-range modifier.
 *
 * Reads the bundled observed-index snapshot built from four National Oceanic
 * and Atmospheric Administration (NOAA) Climate Prediction Center (CPC)
 * sources. The Relative Oceanic Nino Index (RONI) is the operational headline
 * and phase driver. The Oceanic Nino Index (ONI) remains the historical
 * continuity comparison, the analyzed monthly Nino 3.4 sea surface
 * temperature (SST) anomaly is a fast-moving companion, and the standardized
 * Southern Oscillation Index (SOI) is a supporting ocean-atmosphere agreement
 * flag only.
 *
 * Honesty (ddm-enso-correlation): ENSO shifts the odds, it does not set the
 * outcome. Every statement is a tilt with the modulators named (the Pacific
 * Decadal Oscillation, event strength and timing, and intraseasonal
 * variability). Nino 3.4 never declares a phase on its own, and SOI never
 * drives the phase.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { oniLineSvg, ensoPlumeSvg, type OniPoint, type EnsoPlumePoint } from '../ui/charts';
import { makeClaim } from './evidence';
import type { SourceResult } from './sources';
import type { BoundarySelectionContext } from './types';

type EnsoPhase = 'el-nino' | 'la-nina' | 'neutral';

interface SeasonalIndexPoint extends OniPoint {
  readonly preliminary: boolean;
}

interface IndexSeries {
  readonly sourceUrl: string;
  readonly published?: string;
  readonly phase: EnsoPhase;
  readonly latest: SeasonalIndexPoint;
  readonly values: SeasonalIndexPoint[];
}

interface Nino34Point {
  readonly year: number;
  readonly month: number;
  readonly total: number;
  readonly climAdjust: number;
  readonly anom: number;
}

interface Nino34Series {
  readonly sourceUrl: string;
  readonly published?: string;
  readonly latest: Nino34Point;
  readonly values: Nino34Point[];
}

interface SoiPoint {
  readonly year: number;
  readonly month: number;
  readonly value: number | null;
}

interface SoiLatestPoint extends Omit<SoiPoint, 'value'> {
  readonly value: number;
}

interface SoiSeries {
  readonly sourceUrl: string;
  readonly published?: string;
  readonly block: 'standardized';
  readonly latest: SoiLatestPoint;
  readonly values: SoiPoint[];
}

/** The optional probabilities block. The CPC Hypertext Markup Language (HTML)
 * scrape that once produced it was removed 2026-07-21 (T-P0-1), so current
 * snapshots never carry it; absent is the honest no-plume state, never an
 * error. The shape is retained only for a future documented machine feed. */
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
  readonly nino34?: Nino34Series;
  readonly soi?: SoiSeries;
  readonly probabilities?: EnsoProbabilities;
}

// Acronym convention (CLAUDE.md section 5): RONI is spelled out here because
// this string is user-facing claim-source copy and is the first place a reader
// meets the index. U-ENSO-REPAIR briefly shipped a bare "operational RONI"
// here; the full-suite run caught it through tests/evidence-contract.spec.ts,
// which was outside that lane's fence and outside both review rounds.
const SOURCE = 'NOAA CPC Relative Oceanic Nino Index (RONI) and observed ENSO indices';
const MODULATORS = // vocab-allow: honesty disclaimer, denies being a forecast
  'This is a shift in the odds, not a forecast: the Pacific Decadal Oscillation, the event strength and timing, and intraseasonal variability can reinforce or mute the signal.';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const;

/**
 * Hard staleness cutoff (#14). Past this age a new RONI season has very likely
 * posted and the phase may have flipped, so the present-tense phase claim
 * degrades to a dated past-tense read. The 45-day soft hedge in the provenance
 * sentence still applies earlier.
 */
const HARD_STALE_DAYS = 120;

function snapshotAgeDays(retrieved: string): number | null {
  const ms = Date.parse(`${retrieved}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / 86_400_000;
}

function publishedParts(snap: EnsoSnapshot): string[] {
  return [
    snap.roni.published ? `RONI published ${snap.roni.published}` : null,
    snap.oni.published ? `ONI published ${snap.oni.published}` : null,
    snap.nino34?.published ? `analyzed monthly Nino 3.4 published ${snap.nino34.published}` : null,
    snap.soi?.published ? `standardized SOI published ${snap.soi.published}` : null
  ].filter((part): part is string => part !== null);
}

/**
 * Snapshot provenance is always visible in prose because a claim's displayed
 * date line gives a captured published date precedence over its retrieval
 * date. This also preserves the shipped 45-day hedge and 120-day degradation.
 */
function snapshotProvenance(snap: EnsoSnapshot): string {
  const published = publishedParts(snap);
  const publishedText =
    published.length > 0 ? ` CPC published dates captured in the snapshot: ${published.join('; ')}.` : '';
  const ageDays = snapshotAgeDays(snap.retrieved);
  if (ageDays === null) {
    return ` This ENSO read is from the CPC index snapshot dated ${snap.retrieved}.${publishedText}`;
  }
  if (ageDays > 45) {
    const weeks = Math.round(ageDays / 7);
    return ` This ENSO read is from the CPC index snapshot retrieved ${snap.retrieved}, now about ${weeks} weeks old and possibly out of date; refresh the snapshot for the current state.${publishedText}`;
  }
  return ` This ENSO read is from the CPC index snapshot retrieved ${snap.retrieved}.${publishedText}`;
}

function signed(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function latestStr(latest: SeasonalIndexPoint): string {
  const status = latest.preliminary ? '; preliminary and may change' : '';
  return `${signed(latest.anom)} (${latest.seas} ${latest.year}${status})`;
}

function seasonalValueStr(point: SeasonalIndexPoint): string {
  const status = point.preliminary ? ', preliminary and may change' : '';
  return `${signed(point.anom)}${status}`;
}

/** The Pacific Northwest long-range tilt text for the operational RONI phase. */
function tiltText(phase: EnsoPhase, latest: SeasonalIndexPoint, retrieved: string): string {
  const roni = latestStr(latest);

  const ageDays = snapshotAgeDays(retrieved);
  if (ageDays !== null && ageDays > HARD_STALE_DAYS) {
    const weeks = Math.round(ageDays / 7);
    const wasPhase =
      phase === 'neutral'
        ? 'neutral'
        : `in ${phase === 'el-nino' ? 'an El Nino' : 'a La Nina'} phase`;
    return (
      `As of the CPC snapshot dated ${retrieved} (about ${weeks} weeks old, so a new RONI season has likely posted and the phase may have changed), ENSO was ${wasPhase} (operational RONI ${roni}). Refresh the snapshot for the current phase before relying on the long-range tilt. ` +
      MODULATORS
    );
  }

  switch (phase) {
    case 'el-nino':
      return (
        `ENSO is in an El Nino phase (latest operational RONI ${roni}). For the Pacific Northwest this tilts the odds toward a warmer, drier winter with below-normal snowpack and an earlier melt-out, which strengthens a "drought persists or develops" read and tilts the following fire and heat season toward elevated risk. ` +
        MODULATORS
      );
    case 'la-nina':
      return (
        `ENSO is in a La Nina phase (latest operational RONI ${roni}). For the Pacific Northwest this tilts the odds toward a cooler, wetter winter with above-normal snowpack, which weakens a "drought persists or develops" read. La Nina is not a blanket all-clear for fire: a wet, productive winter can grow abundant fine fuels that cure through summer, so an active grass-fire season is still possible, especially east of the Cascades. ` +
        MODULATORS
      );
    default:
      return (
        `ENSO is currently neutral (latest operational RONI ${roni}). A neutral phase offers little long-range signal for the Pacific Northwest, so the seasonal tilt rests on the CPC Seasonal Drought Outlook and current conditions (snowpack, soil moisture, the U.S. Drought Monitor) rather than the ocean state. ` +
        MODULATORS
      );
  }
}

const PHASE_NAME: Record<EnsoPhase, string> = {
  'el-nino': 'El Nino',
  'la-nina': 'La Nina',
  neutral: 'neutral'
};

/**
 * Historical-continuity ONI comparison. Operational RONI always controls the
 * phase, while any divergence from the raw index remains explicit.
 */
function oniContinuity(roni: IndexSeries, oni: IndexSeries): string {
  const r = roni.latest.anom;
  const o = oni.latest.anom;
  const rStr = seasonalValueStr(roni.latest);
  const oStr = seasonalValueStr(oni.latest);

  if (oni.phase !== roni.phase) {
    return `The historical-continuity Oceanic Nino Index (ONI ${oStr}) reads ${PHASE_NAME[oni.phase]} while operational RONI (${rStr}) reads ${PHASE_NAME[roni.phase]}; RONI controls the phase headline, and the divergence remains visible because ONI retains the background ocean warming influence.`;
  }
  if (o > r + 0.1) {
    return `The historical-continuity Oceanic Nino Index (ONI ${oStr}) is warmer than operational RONI (${rStr}); the divergence remains visible because RONI removes the background ocean warming influence.`;
  }
  if (o < r - 0.1) {
    return `The historical-continuity Oceanic Nino Index (ONI ${oStr}) is cooler than operational RONI (${rStr}); the comparison is surfaced without displacing the operational headline.`;
  }
  return `The historical-continuity Oceanic Nino Index agrees closely (ONI ${oStr} versus operational RONI ${rStr}), so the observed-state read does not hinge on their difference.`;
}

function monthYear(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function nino34Text(series: Nino34Series): string {
  return `The analyzed monthly Nino 3.4 sea surface temperature anomaly was ${signed(series.latest.anom)} degrees Celsius (${monthYear(series.latest.year, series.latest.month)}). It is the fast-moving monthly companion, not an ENSO phase declaration on its own.`;
}

function soiAgreementText(roni: IndexSeries, soi: SoiSeries): string {
  const value = soi.latest.value;
  const reading = `${signed(value, 1)} (${monthYear(soi.latest.year, soi.latest.month)})`;
  if (roni.phase === 'neutral' || value === 0) {
    return `The standardized Southern Oscillation Index (SOI) supporting read is ${reading}; it is an ocean-atmosphere agreement flag only and does not create or drive a phase declaration while operational RONI is neutral.`;
  }
  const agrees =
    (roni.phase === 'el-nino' && value < 0) ||
    (roni.phase === 'la-nina' && value > 0);
  return `The standardized Southern Oscillation Index (SOI) supporting read is ${reading}; its atmospheric sign ${agrees ? 'agrees' : 'does not agree'} with the operational RONI direction, as an ocean-atmosphere agreement flag only, and it never drives the phase declaration.`;
}

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY.test(value);
}

function hasValidPublished(value: Record<string, unknown>): boolean {
  return value.published === undefined || isIsoDay(value.published);
}

function isPhase(value: unknown): value is EnsoPhase {
  return value === 'el-nino' || value === 'la-nina' || value === 'neutral';
}

function isSeasonalIndexPoint(value: unknown): value is SeasonalIndexPoint {
  return (
    isObject(value) &&
    typeof value.seas === 'string' &&
    Number.isInteger(value.year) &&
    typeof value.anom === 'number' &&
    Number.isFinite(value.anom) &&
    typeof value.preliminary === 'boolean'
  );
}

function isIndexSeries(value: unknown): value is IndexSeries {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    isPhase(value.phase) &&
    isSeasonalIndexPoint(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length >= 5 &&
    value.values.every(isSeasonalIndexPoint)
  );
}

function isNino34Point(value: unknown): value is Nino34Point {
  return (
    isObject(value) &&
    Number.isInteger(value.year) &&
    typeof value.month === 'number' &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    typeof value.total === 'number' &&
    Number.isFinite(value.total) &&
    typeof value.climAdjust === 'number' &&
    Number.isFinite(value.climAdjust) &&
    typeof value.anom === 'number' &&
    Number.isFinite(value.anom)
  );
}

function isNino34Series(value: unknown): value is Nino34Series {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    isNino34Point(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length > 0 &&
    value.values.every(isNino34Point)
  );
}

function isSoiPoint(value: unknown): value is SoiPoint {
  return (
    isObject(value) &&
    Number.isInteger(value.year) &&
    typeof value.month === 'number' &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    (value.value === null ||
      (typeof value.value === 'number' &&
        Number.isFinite(value.value) &&
        value.value !== -999.9))
  );
}

function isSoiLatestPoint(value: unknown): value is SoiLatestPoint {
  return isSoiPoint(value) && typeof value.value === 'number';
}

function isSoiSeries(value: unknown): value is SoiSeries {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    value.block === 'standardized' &&
    isSoiLatestPoint(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length > 0 &&
    value.values.every(isSoiPoint)
  );
}

function isPlumePoint(value: unknown): value is EnsoPlumePoint {
  return (
    isObject(value) &&
    typeof value.seas === 'string' &&
    typeof value.laNina === 'number' &&
    typeof value.neutral === 'number' &&
    typeof value.elNino === 'number'
  );
}

function isProbabilities(value: unknown): value is EnsoProbabilities {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    typeof value.baseline === 'string' &&
    (typeof value.issued === 'string' || value.issued === null) &&
    Array.isArray(value.seasons) &&
    value.seasons.length >= 2 &&
    value.seasons.every(isPlumePoint)
  );
}

function plumeHeadline(probabilities: EnsoProbabilities): string {
  const far = probabilities.seasons[probabilities.seasons.length - 1]!;
  const categories = [
    { name: 'El Nino', pct: far.elNino },
    { name: 'ENSO-neutral', pct: far.neutral },
    { name: 'La Nina', pct: far.laNina }
  ].sort((a, b) => b.pct - a.pct);
  const lead = categories[0]!;
  const issued = probabilities.issued ? ` (issued ${probabilities.issued})` : '';
  return `The official CPC probabilistic outlook${issued} puts the ${far.seas} odds at ${lead.pct}% ${lead.name}.`;
}

/**
 * Load and validate the bundled snapshot. RONI and ONI are required. The new
 * Nino 3.4 and SOI blocks are optional and are dropped independently when
 * malformed, so the observed seasonal indices still render.
 */
async function loadEnsoSnapshot(signal: AbortSignal): Promise<EnsoSnapshot> {
  const resp = await fetchWithBudget(
    URLS.ensoIndicesLocal,
    { headers: { Accept: 'application/json' } },
    signal,
    6000
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json: unknown = await resp.json();
  if (
    !isObject(json) ||
    !isIsoDay(json.retrieved) ||
    !isIndexSeries(json.oni) ||
    !isIndexSeries(json.roni)
  ) {
    throw new Error('malformed ENSO snapshot');
  }

  const nino34 =
    json.nino34 === undefined
      ? undefined
      : isNino34Series(json.nino34)
        ? json.nino34
        : null;
  if (nino34 === null) {
    console.warn('[enso] malformed Nino 3.4 block in snapshot; seasonal indices still render.');
  }

  const soi =
    json.soi === undefined
      ? undefined
      : isSoiSeries(json.soi)
        ? json.soi
        : null;
  if (soi === null) {
    console.warn('[enso] malformed SOI block in snapshot; seasonal indices still render.');
  }

  const probabilities =
    json.probabilities === undefined
      ? undefined
      : isProbabilities(json.probabilities)
        ? json.probabilities
        : null;
  if (probabilities === null) {
    console.warn('[enso] malformed probabilities block in snapshot; plume omitted.');
  }

  return {
    retrieved: json.retrieved,
    oni: json.oni,
    roni: json.roni,
    ...(nino34 ? { nino34 } : {}),
    ...(soi ? { soi } : {}),
    ...(probabilities ? { probabilities } : {})
  };
}

/** The compact read for the sidebar ENSO driver line. */
export interface EnsoDriverSummary {
  /** "El Nino", "La Nina", or "neutral". */
  readonly phaseName: string;
  /** For example "RONI -0.48 (FMA 2026)". */
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

export async function fetchEnsoDriverSummary(
  signal: AbortSignal
): Promise<EnsoDriverSummary | null> {
  try {
    const snap = await loadEnsoSnapshot(signal);
    if (signal.aborted) return null;
    return {
      phaseName: PHASE_NAME[snap.roni.phase],
      latest: `RONI ${latestStr(snap.roni.latest)}`,
      shortTilt: SHORT_TILT[snap.roni.phase],
      detail:
        `${tiltText(snap.roni.phase, snap.roni.latest, snap.retrieved)} ${oniContinuity(snap.roni, snap.oni)}` +
        (snap.nino34 ? ` ${nino34Text(snap.nino34)}` : '') +
        (snap.soi ? ` ${soiAgreementText(snap.roni, snap.soi)}` : '') +
        (snap.probabilities ? ` ${plumeHeadline(snap.probabilities)}` : '') +
        snapshotProvenance(snap),
      retrieved: snap.retrieved,
      sourceUrl: snap.roni.sourceUrl
    };
  } catch (err) {
    if (!signal.aborted) console.warn('[enso] driver summary read failed.', err);
    return null;
  }
}

function claimDates(retrieved: string, published?: string): {
  readonly retrieved: string;
  readonly published?: string;
} {
  return { retrieved, ...(published ? { published } : {}) };
}

export async function fetchEnsoClaims(
  _context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  try {
    const snap = await loadEnsoSnapshot(signal);
    if (signal.aborted) return { claims: [], ok: false };

    const text =
      `${tiltText(snap.roni.phase, snap.roni.latest, snap.retrieved)} ${oniContinuity(snap.roni, snap.oni)}` +
      (snap.soi ? ` ${soiAgreementText(snap.roni, snap.soi)}` : '') +
      snapshotProvenance(snap);

    const chartSvg = oniLineSvg(snap.roni.values, {
      title: 'Observed operational RONI and historical-continuity ONI over recent seasons',
      source: `NOAA CPC RONI and ONI, retrieved ${snap.retrieved}`,
      primaryLabel: 'RONI',
      compare: { values: snap.oni.values, label: 'ONI' }
    });

    const lineage = [
      'NOAA CPC RONI operational-index snapshot',
      'NOAA CPC ONI historical-continuity snapshot',
      ...(snap.soi ? ['NOAA CPC standardized SOI supporting snapshot'] : []),
      'DDM Pacific Northwest tilt read (ddm-enso-correlation doctrine)'
    ];

    const observedCompanionClaims = snap.nino34
      ? [
          makeClaim({
            text: nino34Text(snap.nino34),
            source: 'NOAA CPC analyzed monthly Nino 3.4 sea surface temperature anomaly',
            sourceUrl: snap.nino34.sourceUrl,
            evidence: 'analyzed',
            dates: claimDates(snap.retrieved, snap.nino34.published),
            uncertainty: {
              kind: 'typical',
              text: 'the newest analyzed Extended Reconstructed Sea Surface Temperature inputs can revise for up to two months; this monthly companion does not declare an ENSO phase'
            }
          })
        ]
      : [];

    // The forward plume remains absent unless a future snapshot carries a
    // probabilities block from a documented machine source.
    const plumeClaims = [];
    if (snap.probabilities) {
      const probabilities = snap.probabilities;
      const plumeSvg = ensoPlumeSvg(probabilities.seasons, {
        title: 'Official CPC odds of El Nino, neutral, and La Nina by season',
        source: `NOAA CPC probabilistic ENSO outlook${probabilities.issued ? `, issued ${probabilities.issued}` : ''}`
      });
      if (plumeSvg) {
        plumeClaims.push(
          makeClaim({
            text: // vocab-allow: honesty disclaimer, denies being a forecast
              `${plumeHeadline(probabilities)} These are odds across overlapping three-month seasons, not a forecast of outcomes; ` +
              `the categories are defined against the ${probabilities.baseline}.`,
            source: 'NOAA CPC official probabilistic ENSO outlook (CPC/IRI consensus)',
            sourceUrl: probabilities.sourceUrl,
            evidence: 'outlook',
            dates: {
              retrieved: snap.retrieved,
              ...(probabilities.issued ? { issued: probabilities.issued } : {})
            },
            uncertainty: {
              kind: 'categorical',
              text: // vocab-allow: honesty disclaimer, denies being a forecast
                'category odds by overlapping three-month season, not a forecast of outcomes'
            },
            ...(plumeSvg ? { chartSvg: plumeSvg } : {})
          })
        );
      }
    }

    return {
      ok: true,
      claims: [
        makeClaim({
          text,
          source: SOURCE,
          sourceUrl: snap.roni.sourceUrl,
          evidence: 'derived',
          dates: claimDates(snap.retrieved, snap.roni.published),
          lineage,
          uncertainty: {
            kind: 'typical',
            text: // vocab-allow: honesty disclaimer, denies being a forecast
              'a shift in the odds, not a forecast of outcomes; the named modulators can reinforce or mute the signal'
          },
          ...(chartSvg ? { chartSvg } : {})
        }),
        ...observedCompanionClaims,
        ...plumeClaims
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] ENSO snapshot read failed.', err);
    return { claims: [], ok: false, note: 'The ENSO index snapshot was unavailable.' };
  }
}
