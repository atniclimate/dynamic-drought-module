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
 * Three CPC rules, three answers (2026-09-02, report 13 ENSOSCI-01). The
 * headline reports `conditions`, CPC's ONSET rule on the newest three-month
 * season; the historical five-season `episode` classification follows as a
 * second sentence and never leads; `emerging` names the state where the
 * first has crossed the threshold and the second has not yet been met.
 * Collapsing the two made the application print "ENSO is currently neutral"
 * while NOAA held a standing El Nino Advisory. CPC's own status lives in the
 * ENSO Diagnostic Discussion, which is HTML: this module links it and never
 * parses it, the same doctrine that removed the probabilistic plume.
 *
 * Honesty: ENSO shifts the odds, it does not set the outcome. Every regional
 * statement is a tendency across past events, carries the modulators (the
 * Pacific Decadal Oscillation, event strength and timing, and intraseasonal
 * variability), and cites the issuer that states it. Nino 3.4 never declares
 * a state on its own, and SOI never drives it.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { oniLineSvg, ensoPlumeSvg, type OniPoint, type EnsoPlumePoint } from '../ui/charts';
import { makeClaim } from './evidence';
import type { SourceResult } from './sources';
import type { BoundarySelectionContext } from './types';

type EnsoPhase = 'el-nino' | 'la-nina' | 'neutral';

/** The trailing-season trajectory word carried by the snapshot's state block. */
type EnsoDirection = 'strengthening' | 'weakening' | 'steady';

interface SeasonalIndexPoint extends OniPoint {
  readonly preliminary: boolean;
  /** Present on `latest` from snapshot builds after 2026-09-02. */
  readonly exceedsThreshold?: boolean;
  readonly thresholdSide?: 'above' | 'below' | 'within';
}

/**
 * CPC's rules, kept apart (report 13, ENSOSCI-01). `conditions` answers the
 * onset rule on the newest three-month season, which is the present-tense
 * question a reader is asking; `episode` is the historical five-season
 * classification and is never the headline; `emerging` is derived from the
 * two. The snapshot computes these, and `readState` recomputes them from the
 * series when an older snapshot carries only the legacy `phase`.
 */
interface IndexState {
  readonly conditions: EnsoPhase;
  readonly episode: EnsoPhase;
  readonly direction: EnsoDirection;
  readonly emerging: boolean;
  readonly threshold: number;
  readonly conditionsRule: string;
  readonly episodeRule: string;
}

interface IndexSeries {
  readonly sourceUrl: string;
  readonly published?: string;
  /** Legacy alias of `state.episode`, retained so an old file still loads. */
  readonly phase: EnsoPhase;
  readonly state?: IndexState;
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

/** A label-only read of the bundled snapshot's operational RONI state. */
export interface EnsoPhaseLabel {
  /**
   * CPC's current-conditions read on the newest season: 'El Nino',
   * 'La Nina', or 'neutral', verbatim from PHASE_NAME. This is what a label
   * should show; it is the same value that leads the briefing headline.
   */
  readonly conditionsName: string;
  /**
   * The historical five-season episode classification, verbatim from
   * PHASE_NAME. Kept because a label may want to say which one it is
   * showing; it must never be presented as the current state.
   */
  readonly phaseName: string;
  /** Conditions are present while the five-season criterion is not yet met. */
  readonly emerging: boolean;
  /** The RONI season the state is read from, for example 'MJJ'. */
  readonly season: string;
  /** The calendar year that season ends in. */
  readonly year: number;
}

/**
 * Name the current ENSO state for a surface that only needs a LABEL (the
 * ENSO minimap's scale slot, EF-6), never a claim about a place.
 *
 * It reuses the same bundled artifact, the same validated loader, and the
 * same operational-RONI state this module's briefing claims use, so it
 * introduces no source and cannot disagree with the briefing. A failed or
 * malformed read returns null, which callers render as their existing
 * no-label state rather than as an ENSO claim.
 */
export async function readEnsoPhaseLabel(
  signal: AbortSignal
): Promise<EnsoPhaseLabel | null> {
  try {
    const snap = await loadEnsoSnapshot(signal);
    const state = readState(snap.roni);
    return {
      conditionsName: PHASE_NAME[state.conditions],
      phaseName: PHASE_NAME[state.episode],
      emerging: state.emerging,
      season: snap.roni.latest.seas,
      year: snap.roni.latest.year
    };
  } catch {
    return null;
  }
}

// Acronym convention (spell out on first use): RONI is spelled out here because
// this string is user-facing claim-source copy and is the first place a reader
// meets the index. U-ENSO-REPAIR briefly shipped a bare "operational RONI"
// here; the full-suite run caught it through tests/evidence-contract.spec.ts,
// which was outside that lane's fence and outside both review rounds.
const SOURCE = 'NOAA CPC Relative Oceanic Nino Index (RONI) and observed ENSO indices';
const MODULATORS = // vocab-allow: honesty disclaimer, denies being a forecast
  'This is a shift in the odds, not a forecast: the Pacific Decadal Oscillation, the event strength and timing, and intraseasonal variability can reinforce or mute the signal.';

/**
 * The CPC and regional pages this module cites, with the date each link and
 * the statement resting on it were last verified against the live product
 * (the fixed-claim rule used by `CPC_SEASONAL_OUTLOOK` in hydrate.ts).
 * Verified 2026-09-02 by research worker 13's live fetches and re-checked
 * the same day, HTTP 200 each. Re-stamp `CITATIONS_VERIFIED` whenever these
 * are re-read; do not extend a statement past what its page says.
 */
const CITATIONS_VERIFIED = '2026-09-02';
const CPC_STATUS_URL =
  'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml';
const RONI_PRODUCT_URL =
  'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/';
const NW_HUB_EL_NINO_URL =
  'https://www.climatehubs.usda.gov/hubs/northwest/topic/el-nino-northwest-what-can-we-expect';
const NW_HUB_LA_NINA_URL =
  'https://www.climatehubs.usda.gov/hubs/northwest/topic/la-nina-northwest-what-can-we-expect';
const CPC_COMPOSITES_URL =
  'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/ENSO/composites/';

/**
 * The same rule constants the builder applies
 * (`scripts/build-enso-snapshot.mjs`), used only when a snapshot predates
 * the state block. Keep the two in step: they are one rule expressed twice,
 * exactly as the load guards mirror the shared contract file.
 */
const THRESHOLD = 0.5;
const RUN_LENGTH = 5;
const DIRECTION_BAND = 0.2;
const DIRECTION_SPAN = 3;
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

/**
 * How old this read really is (ENSO-05). `retrieved` is rewritten on every
 * scheduled build whether or not CPC published anything, so retrieval age
 * alone can never notice a frozen upstream. The hedges therefore key on the
 * LARGER of the retrieval age and the age of the oldest captured CPC
 * publication date, and `basis` records which one is speaking so the prose
 * never attributes a publication age to the snapshot file.
 */
interface SnapshotAge {
  readonly days: number;
  readonly basis: 'retrieval' | 'publication';
}

function snapshotAge(snap: EnsoSnapshot): SnapshotAge | null {
  const retrievedAge = snapshotAgeDays(snap.retrieved);
  if (retrievedAge === null) return null;
  const publishedAges = [
    snap.roni.published,
    snap.oni.published,
    snap.nino34?.published,
    snap.soi?.published
  ]
    .map((day) => (day === undefined ? null : snapshotAgeDays(day)))
    .filter((age): age is number => age !== null);
  const oldestPublishedAge =
    publishedAges.length > 0 ? Math.max(...publishedAges) : null;
  if (oldestPublishedAge !== null && oldestPublishedAge > retrievedAge) {
    return { days: oldestPublishedAge, basis: 'publication' };
  }
  return { days: retrievedAge, basis: 'retrieval' };
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
  const age = snapshotAge(snap);
  if (age === null) {
    return ` This ENSO read is from the CPC index snapshot dated ${snap.retrieved}.${publishedText}`;
  }
  if (age.days > 45) {
    const weeks = Math.round(age.days / 7);
    return age.basis === 'publication'
      ? ` This ENSO read is from the CPC index snapshot retrieved ${snap.retrieved}, but its oldest captured CPC publication date is now about ${weeks} weeks old, so the indices themselves are possibly out of date; check CPC for a newer issue.${publishedText}`
      : ` This ENSO read is from the CPC index snapshot retrieved ${snap.retrieved}, now about ${weeks} weeks old and possibly out of date; refresh the snapshot for the current state.${publishedText}`;
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

/**
 * Resolve the three CPC states for one index series. The snapshot computes
 * them (`scripts/build-enso-snapshot.mjs`); a snapshot built before
 * 2026-09-02 carries only the legacy `phase`, so the same rules are applied
 * here rather than letting the historical episode classification take the
 * present-tense headline back.
 */
function readState(series: IndexSeries): IndexState {
  if (series.state) return series.state;
  const values = series.values;
  const anom = series.latest.anom;
  const conditions: EnsoPhase =
    anom >= THRESHOLD ? 'el-nino' : anom <= -THRESHOLD ? 'la-nina' : 'neutral';
  const tail = values.slice(-RUN_LENGTH);
  const episode: EnsoPhase =
    tail.length === RUN_LENGTH && tail.every((point) => point.anom >= THRESHOLD)
      ? 'el-nino'
      : tail.length === RUN_LENGTH && tail.every((point) => point.anom <= -THRESHOLD)
        ? 'la-nina'
        : 'neutral';
  const previous = values[values.length - DIRECTION_SPAN];
  const change = previous === undefined ? 0 : anom - previous.anom;
  const direction: EnsoDirection =
    change >= DIRECTION_BAND
      ? 'strengthening'
      : change <= -DIRECTION_BAND
        ? 'weakening'
        : 'steady';
  return {
    conditions,
    episode,
    direction,
    emerging: conditions !== 'neutral' && episode === 'neutral',
    threshold: THRESHOLD,
    conditionsRule: RONI_PRODUCT_URL,
    episodeRule: RONI_PRODUCT_URL
  };
}

/** How an event is moving. Only used when conditions are present. */
const EVENT_TREND: Record<EnsoDirection, string> = {
  strengthening: ' and strengthening',
  weakening: ' and weakening',
  steady: ' and holding steady'
};

/**
 * How the index is moving while conditions are neutral. Stated as arithmetic
 * on the last three seasons, never as an event that is not there yet.
 */
const NEUTRAL_TREND: Record<EnsoDirection, string> = {
  strengthening: ', with the index warming across the last three seasons',
  weakening: ', with the index cooling across the last three seasons',
  steady: ', with the index little changed across the last three seasons'
};

/**
 * The headline: CPC's ONSET rule on the newest season, which is the
 * present-tense answer. Before 2026-09-02 this sentence reported the
 * five-season episode classification instead, so the application printed
 * "ENSO is currently neutral" while NOAA held a standing El Nino Advisory.
 */
function conditionsSentence(state: IndexState, latest: SeasonalIndexPoint): string {
  const roni = latestStr(latest);
  const threshold = state.threshold.toFixed(1);
  if (state.conditions === 'neutral') {
    return `ENSO conditions are neutral${NEUTRAL_TREND[state.direction]}: the newest operational RONI season is ${roni}, inside the CPC onset thresholds of plus or minus ${threshold} degrees Celsius.`;
  }
  const side = state.conditions === 'el-nino' ? 'above' : 'below';
  const sign = state.conditions === 'el-nino' ? 'plus' : 'minus';
  return `${PHASE_NAME[state.conditions]} conditions are present${EVENT_TREND[state.direction]}: the newest operational RONI season is ${roni}, ${side} the CPC onset threshold of ${sign} ${threshold} degrees Celsius for a single three-month season.`;
}

/**
 * The historical five-season classification, kept as a secondary sentence.
 * It is CPC's rule "for historical purposes" and never leads.
 */
function episodeSentence(state: IndexState): string {
  if (state.emerging) {
    const article = state.conditions === 'el-nino' ? 'an' : 'a';
    return `CPC classifies ${article} ${PHASE_NAME[state.conditions]} episode only once five consecutive overlapping seasons hold past that threshold, which this run of seasons has not yet done, so the historical episode classification still reads neutral.`;
  }
  if (state.conditions === state.episode) {
    return state.episode === 'neutral'
      ? 'The historical five-season episode classification also reads neutral.'
      : `The historical five-season episode classification agrees: five consecutive overlapping seasons have held past the threshold, so the CPC ${PHASE_NAME[state.episode]} episode criterion is met.`;
  }
  return `The historical five-season episode classification still reads ${PHASE_NAME[state.episode]}, because that rule looks back across five consecutive overlapping seasons.`;
}

/**
 * The observed-state text for the operational RONI series: conditions first,
 * episode second. Past the hard staleness cutoff both degrade to a dated
 * past-tense read (ENSO-05) and the regional tendency claim is withheld.
 */
function observedStateText(
  state: IndexState,
  latest: SeasonalIndexPoint,
  retrieved: string,
  age: SnapshotAge | null
): string {
  if (age !== null && age.days > HARD_STALE_DAYS) {
    const weeks = Math.round(age.days / 7);
    // The parenthetical names WHICH age crossed the cutoff, so a publication
    // age is never reported as the age of the snapshot file (ENSO-05).
    const ageClause =
      age.basis === 'publication'
        ? `its oldest captured CPC publication date is about ${weeks} weeks old, so a new RONI season has likely posted and the state may have changed`
        : `about ${weeks} weeks old, so a new RONI season has likely posted and the state may have changed`;
    const wasConditions =
      state.conditions === 'neutral'
        ? 'inside the CPC onset thresholds'
        : `past the CPC onset threshold for ${PHASE_NAME[state.conditions]} conditions`;
    return `As of the CPC snapshot dated ${retrieved} (${ageClause}), the newest operational RONI season was ${latestStr(latest)}, ${wasConditions}, and the historical five-season episode classification read ${PHASE_NAME[state.episode]}. Refresh the snapshot for the current state, and read the CPC ENSO Diagnostic Discussion for the official status.`;
  }
  return `${conditionsSentence(state, latest)} ${episodeSentence(state)}`;
}

/**
 * One Pacific Northwest tendency read, with the issuer that supports it.
 * Every branch names a page that states the tendency, so the module no
 * longer points a regional impact statement at a column of index numbers
 * (report 13, ENSOSCI-09).
 */
interface TendencyRead {
  readonly text: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly lineage: readonly string[];
}

const NW_HUB_LINEAGE = 'USDA Northwest Climate Hub ENSO regional tendency summary';
const CPC_COMPOSITE_LINEAGE =
  'NOAA CPC ENSO temperature, precipitation and snow composites';
const WA_CLIMATE_OFFICE_LINEAGE =
  'Washington State Climate Office, University of Washington College of the Environment';

/**
 * What past events of this phase did in the Pacific Northwest.
 *
 * The El Nino branch carries the snowpack counter-evidence deliberately: the
 * flat "below-normal snowpack" claim this replaced was wrong in exactly the
 * class of event now underway, because the three strongest El Ninos on
 * record each produced near-normal Washington snowpack. The former La Nina
 * fine-fuels sentence is gone rather than softened; no issuer states it as
 * an ENSO teleconnection (report 13, ENSOSCI-09, UNVERIFIED).
 */
function tendency(state: IndexState): TendencyRead {
  switch (state.conditions) {
    case 'el-nino':
      return {
        text:
          'With El Nino conditions present, the Pacific Northwest read rests on what past El Nino events did. Across those events, fall and winter in Idaho, Oregon and Washington have tended to run warmer and drier, with more precipitation falling as rain than snow; the USDA Northwest Climate Hub associates that combination with decreased runoff, less summer water availability, and increased wildfire risk. Snowpack is the least reliable part of the tendency: the Washington State Climate Office notes that the three strongest El Ninos on record (1982-83, 1997-98 and 2015-16) each produced near-normal Washington snowpack. ' +
          MODULATORS,
        source: 'USDA Northwest Climate Hub, El Nino in the Northwest',
        sourceUrl: NW_HUB_EL_NINO_URL,
        lineage: [NW_HUB_LINEAGE, WA_CLIMATE_OFFICE_LINEAGE, CPC_COMPOSITE_LINEAGE]
      };
    case 'la-nina':
      return {
        text:
          'With La Nina conditions present, the Pacific Northwest read rests on what past La Nina events did. Across those events, winter in Idaho, Oregon and Washington has usually run cooler, and some events brought above-normal precipitation, though the USDA Northwest Climate Hub states the precipitation association is not as strong as the temperature one. A deeper snowpack has been associated with increased runoff, more reliable summer water availability, and reduced drought severity. ' +
          MODULATORS,
        source: 'USDA Northwest Climate Hub, La Nina in the Northwest',
        sourceUrl: NW_HUB_LA_NINA_URL,
        lineage: [NW_HUB_LINEAGE, CPC_COMPOSITE_LINEAGE]
      };
    default:
      return {
        text:
          'With neither El Nino nor La Nina conditions present, there is no warm-phase or cool-phase composite to lean on: CPC publishes composites describing the tendencies of each phase, and with neither in place the seasonal read rests on the CPC Seasonal Drought Outlook and on current conditions (snowpack, soil moisture, the U.S. Drought Monitor). ' +
          MODULATORS,
        source: 'NOAA CPC ENSO temperature, precipitation and snow composites',
        sourceUrl: CPC_COMPOSITES_URL,
        lineage: [CPC_COMPOSITE_LINEAGE, 'NOAA CPC Seasonal Drought Outlook']
      };
  }
}

/**
 * The pointer to CPC's own status. The ENSO Diagnostic Discussion is HTML
 * and is never parsed here (the doctrine that removed the probabilistic
 * plume applies to it too), so the application computes the index state and
 * LINKS the authority instead of restating it.
 */
const AUTHORITY_TEXT =
  'NOAA CPC states the official ENSO status, including any El Nino or La Nina Advisory, in its ENSO Diagnostic Discussion, issued on the second Thursday of each month. That product is the authority on the current status; this read computes the index state from CPC index files and links the discussion rather than restating it.';

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

  // Present tense compares CONDITIONS, not the historical episode rule: two
  // series can sit in the same five-season episode while disagreeing about
  // what the newest season shows, which is the disagreement worth surfacing.
  const rConditions = readState(roni).conditions;
  const oConditions = readState(oni).conditions;
  if (oConditions !== rConditions) {
    return `The historical-continuity Oceanic Nino Index (ONI ${oStr}) reads ${PHASE_NAME[oConditions]} conditions while operational RONI (${rStr}) reads ${PHASE_NAME[rConditions]}; RONI is the CPC primary standard and controls the headline, and the divergence remains visible because ONI retains the background ocean warming influence.`;
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

/**
 * Whole months between the analyzed month and the month the snapshot was
 * retrieved in. Null when `retrieved` is unparseable, so the sentence simply
 * drops the gap rather than guessing at one.
 */
function monthsBehindRetrieval(
  latest: Nino34Point,
  retrieved: string
): number | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(retrieved);
  if (!match) return null;
  const gap =
    (Number(match[1]) - latest.year) * 12 + (Number(match[2]) - latest.month);
  return gap > 0 ? gap : null;
}

function nino34Text(series: Nino34Series, retrieved: string): string {
  const latest = series.latest;
  // ENSO-11: the month alone let the "fast-moving monthly companion" framing
  // read as the freshest signal when it is in fact the oldest, so the gap to
  // the retrieval month is stated. ENSO-06 (partial): the measured sea
  // surface temperature and the CPC climatological adjustment it is compared
  // against are both already in the validated snapshot, so the anomaly is no
  // longer a bare number with no measurement behind it.
  const gap = monthsBehindRetrieval(latest, retrieved);
  const gapText =
    gap === null
      ? ''
      : `, ${gap} ${gap === 1 ? 'month' : 'months'} behind the snapshot retrieval`;
  return `The analyzed monthly Nino 3.4 sea surface temperature was ${latest.total.toFixed(2)} degrees Celsius against the CPC climatological adjustment of ${latest.climAdjust.toFixed(2)} degrees Celsius, an anomaly of ${signed(latest.anom)} degrees Celsius (${monthYear(latest.year, latest.month)}, the most recent analyzed month${gapText}). It is the fast-moving monthly companion, not an ENSO phase declaration on its own.`;
}

function soiAgreementText(roni: IndexSeries, soi: SoiSeries): string {
  const value = soi.latest.value;
  const reading = `${signed(value, 1)} (${monthYear(soi.latest.year, soi.latest.month)})`;
  // Agreement is read against current CONDITIONS. Keying it to the
  // five-season episode rule muted an ENSO-consistent atmosphere for as long
  // as the episode criterion lagged the ocean (ENSO-01).
  const conditions = readState(roni).conditions;
  if (conditions === 'neutral' || value === 0) {
    return `The standardized Southern Oscillation Index (SOI) supporting read is ${reading}; it is an ocean-atmosphere agreement flag only and does not create or drive a state declaration while operational RONI conditions are neutral.`;
  }
  const agrees =
    (conditions === 'el-nino' && value < 0) ||
    (conditions === 'la-nina' && value > 0);
  return `The standardized Southern Oscillation Index (SOI) supporting read is ${reading}; its atmospheric sign ${agrees ? 'agrees' : 'does not agree'} with the operational RONI direction, as an ocean-atmosphere agreement flag only, and it never drives the state declaration.`;
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

function isDirection(value: unknown): value is EnsoDirection {
  return value === 'strengthening' || value === 'weakening' || value === 'steady';
}

/**
 * The state block is optional so a snapshot built before 2026-09-02 still
 * loads; when present it must be complete, because a half-filled block would
 * let the headline fall back to the historical episode rule silently.
 */
function isIndexState(value: unknown): value is IndexState {
  return (
    isObject(value) &&
    isPhase(value.conditions) &&
    isPhase(value.episode) &&
    isDirection(value.direction) &&
    typeof value.emerging === 'boolean' &&
    typeof value.threshold === 'number' &&
    Number.isFinite(value.threshold) &&
    value.threshold > 0 &&
    typeof value.conditionsRule === 'string' &&
    typeof value.episodeRule === 'string'
  );
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
    (value.state === undefined || isIndexState(value.state)) &&
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

    const age = snapshotAge(snap);
    const state = readState(snap.roni);
    const stale = age !== null && age.days > HARD_STALE_DAYS;
    const text =
      `${observedStateText(state, snap.roni.latest, snap.retrieved, age)} ${oniContinuity(snap.roni, snap.oni)}` +
      (snap.soi ? ` ${soiAgreementText(snap.roni, snap.soi)}` : '') +
      snapshotProvenance(snap);

    const chartSvg = oniLineSvg(snap.roni.values, {
      title: 'Observed operational RONI and historical-continuity ONI over recent seasons',
      source: `NOAA CPC RONI and ONI, retrieved ${snap.retrieved}`,
      primaryLabel: 'RONI',
      compare: { values: snap.oni.values, label: 'ONI' }
    });

    // The regional tendency moved to its own cited claim, so this lineage
    // names only what the index read stands on. The former
    // "ddm-enso-correlation doctrine" entry is gone: it was an internal
    // process label, not a source (report 13, ENSOSCI-09).
    const lineage = [
      'NOAA CPC RONI operational-index snapshot',
      'NOAA CPC ONI historical-continuity snapshot',
      ...(snap.soi ? ['NOAA CPC standardized SOI supporting snapshot'] : []),
      'NOAA CPC ENSO onset rule (one three-month season past the threshold)',
      'NOAA CPC RONI Cold and Warm Episodes by Season (five-season episode rule)'
    ];

    // Where CPC states the official status. Its own claim so the link is
    // reachable: a reader who needs the authority should not have to find it
    // inside another claim's prose. Withheld only when the whole read has
    // degraded past the hard staleness cutoff, where the state sentence
    // already names the discussion.
    const authorityClaims = stale
      ? []
      : [
          makeClaim({
            text: AUTHORITY_TEXT,
            source: 'NOAA CPC ENSO Diagnostic Discussion',
            sourceUrl: CPC_STATUS_URL,
            evidence: 'analyzed',
            dates: { retrieved: CITATIONS_VERIFIED }
          })
        ];

    // The Pacific Northwest tendency, cited to the issuer that states it.
    // Withheld past the hard staleness cutoff, because a tendency read on a
    // state that may already have changed is the claim least worth keeping.
    const tendencyRead = tendency(state);
    const tendencyClaims = stale
      ? []
      : [
          makeClaim({
            text: tendencyRead.text,
            source: tendencyRead.source,
            sourceUrl: tendencyRead.sourceUrl,
            evidence: 'derived',
            dates: { retrieved: CITATIONS_VERIFIED },
            lineage: tendencyRead.lineage,
            uncertainty: {
              kind: 'typical',
              text: // vocab-allow: honesty disclaimer, denies being a forecast
                'a tendency across past events of this phase, not a forecast of outcomes; the named modulators can reinforce or mute the signal'
            }
          })
        ];

    const observedCompanionClaims = snap.nino34
      ? [
          makeClaim({
            text: nino34Text(snap.nino34, snap.retrieved),
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
          // The CPC RONI product page, not the bare index file: it is where
          // CPC states the thresholds, the five-season episode rule, the
          // 1991-2020 base period, ERSSTv6 and the two-month revision
          // window this sentence rests on. The index file itself is named in
          // the lineage below (report 13, ENSOSCI-09).
          sourceUrl: RONI_PRODUCT_URL,
          evidence: 'derived',
          dates: claimDates(snap.retrieved, snap.roni.published),
          lineage,
          // This claim is now an index-state read, so its uncertainty is the
          // index's own: CPC states the revision window and its cause on the
          // RONI page this claim links (report 13, ENSOSCI-03). The
          // odds-not-outcomes disclaimer moved to the tendency claim, which
          // is the statement it actually qualifies.
          uncertainty: {
            kind: 'typical',
            text: 'the newest seasons are preliminary: CPC states that RONI values may change up to two months after the initial real-time value is posted, because of the high frequency filter applied to the ERSSTv6 data'
          },
          ...(chartSvg ? { chartSvg } : {})
        }),
        ...authorityClaims,
        ...tendencyClaims,
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
