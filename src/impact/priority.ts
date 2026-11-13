/**
 * The priority briefing's reading order (owner direction 2026-11-09 (sprint),
 * DR-pending): ONE published table and one pure function that orders a
 * place's structured readings by it.
 *
 * WHAT THIS IS. A lexicographic reading order over issuer classes as issued:
 * first by the table's row, then by the issuer's own class order inside the
 * row, then by a fixed hazard order so ties are stable. It decides which read
 * a person meets first. The briefing matrix (src/impact/matrix.ts) is not
 * touched by it and is never reordered.
 *
 * WHAT THIS IS NOT. It is not a severity score. Nothing here adds, weights,
 * averages or compares classes across hazards, and no number is computed: a
 * higher row is read sooner, it is not "worse". The row order itself is
 * DDM's, stated in the table and rendered in the briefing's technical
 * section; the order inside a row is the issuer's.
 *
 * ABSENCE. A read with no ranked class (no polygon, no area drawn, no product
 * in effect, the issuer's lowest class) is not good news and is not ranked as
 * such: it is returned in `rest`, in the issuer's words. A cell that was not
 * read is returned in `rest` under its own state. Every hazard appears in
 * `ranked`, in `rest`, or in both; none is dropped.
 *
 * Pure: no DOM, no fetch, no clock. `tests/briefing-priority.test.mjs`
 * exercises it under plain node.
 */

import {
  HEATRISK_CATEGORIES,
  SPC_FIREWX_CATEGORIES,
  USDM_CATEGORIES,
  USDM_NONE_SWATCH
} from '../config/palette';
import { HAZARD_KEYS } from './matrix';
import type {
  ClaimReading,
  HazardCell,
  HazardKey,
  HorizonKey,
  HorizonStatus,
  SourcedClaim
} from './types';

/** The rows of the published table, in reading order. */
export type PriorityRowKey =
  | 'nws-product'
  | 'wfigs-wildfire'
  | 'usdm-category'
  | 'heatrisk-level'
  | 'spc-category'
  | 'spc-probability'
  | 'enso-conditions';

/**
 * One issuer product family. A family is one entry in the lead view even
 * when it answers for several days (the SPC outlook), and takes the place of
 * its first-read class.
 */
export type PriorityFamily = 'nws' | 'wfigs' | 'usdm' | 'heatrisk' | 'spc' | 'enso';

export interface PriorityRow {
  readonly key: PriorityRowKey;
  /** What puts a read in this row, in plain words. */
  readonly title: string;
  readonly issuer: string;
  /** The issuer field the class is read from, as the repository reads it. */
  readonly field: string;
  /** The row's classes in the issuer's words, first-read first. */
  readonly classes: readonly string[];
  /** Where the order inside the row comes from. */
  readonly orderBasis: string;
  /** The issuer page that states the classes or their order. */
  readonly basisUrl?: string;
}

/**
 * The National Weather Service's own display priority for the products the
 * briefing reads (`FIRE_EVENTS` and `HEAT_EVENTS`, src/impact/sources.ts).
 * Lower is read first. Receipt: the "Priority" column of the hazards table at
 * https://www.weather.gov/help-map (read 2026-11-09), whose page says of the
 * map it describes that "only the most significant threat to life or
 * property is displayed"; the Hex Code column of the same rows matches
 * `NWS_ALERT_COLORS` (src/config/palette.ts:503-510), which is how the read
 * was cross-checked. The table lists the 2025 names only; a product issued
 * under a former Excessive Heat name takes its renamed row's number, the
 * same alias the palette and the map key already apply
 * (src/config/palette.ts:498-507).
 */
export const NWS_PRODUCT_PRIORITY: Readonly<Record<string, number>> = {
  'Extreme Heat Warning': 44, // vocab-allow: verbatim NWS product names, quoted source data
  'Excessive Heat Warning': 44, // vocab-allow: verbatim NWS product names, quoted source data
  'Red Flag Warning': 52, // vocab-allow: verbatim NWS product names, quoted source data
  'Heat Advisory': 63,
  'Extreme Heat Watch': 93,
  'Excessive Heat Watch': 93,
  'Fire Weather Watch': 96
};

/** A product name the table does not carry is read after every listed one. */
const UNLISTED_NWS_PRIORITY = 1000;

function nwsPriority(event: string): number {
  return NWS_PRODUCT_PRIORITY[event] ?? UNLISTED_NWS_PRIORITY;
}

/** The current product names in the issuer's priority order (former names folded into their rows). */
const NWS_ROW_CLASSES: readonly string[] = Object.keys(NWS_PRODUCT_PRIORITY)
  .filter((name) => !name.startsWith('Excessive'))
  .sort((a, b) => nwsPriority(a) - nwsPriority(b));

/** SPC `dn` values, highest category first (src/config/palette.ts:561-573). */
const SPC_DN_FIRST: readonly number[] = SPC_FIREWX_CATEGORIES.map((category) => category.dn).sort(
  (a, b) => b - a
);

function spcCategoryLabel(dn: number): string {
  return SPC_FIREWX_CATEGORIES.find((category) => category.dn === dn)?.label ?? `dn ${dn}`;
}

/**
 * THE TABLE. One row per kind of issuer class the briefing can read as data,
 * in the order a person meets them: what is in effect at the point, what is
 * mapped now, this week's analyzed class, the class for the current 24-hour
 * period, the classes for the days ahead, and the season's climate driver.
 * Each row cites the field the repository reads.
 */
export const PRIORITY_ROWS: readonly PriorityRow[] = [
  {
    key: 'nws-product',
    title: 'A National Weather Service product in effect at the selected point',
    issuer: 'National Weather Service',
    // src/impact/sources.ts fetchNwsAlertClaims: `properties.event`, kept only
    // for the names in FIRE_EVENTS and HEAT_EVENTS.
    field: 'the product name as issued (event) in the NWS active products feed for the point',
    classes: NWS_ROW_CLASSES,
    orderBasis:
      'the Priority column of the NWS hazards map table, read 2026-11-09; a product issued under a former Excessive Heat name takes its renamed row',
    basisUrl: 'https://www.weather.gov/help-map'
  },
  {
    key: 'wfigs-wildfire',
    title: 'A current mapped wildfire perimeter in the bounding box around the selection',
    issuer: 'NIFC WFIGS',
    // src/impact/sources.ts fetchNifcClaims: `attr_IncidentTypeCategory`,
    // classed by classifyNifcIncidentType (src/config/wildfire-presentation.ts).
    field: 'attr_IncidentTypeCategory WF or CX on a current perimeter',
    classes: ['Wildfire or incident complex perimeter mapped'],
    orderBasis:
      'presence only: the count is stated on the read and never ranked; Prescribed fire and unclassified records are listed, not ranked'
  },
  {
    key: 'usdm-category',
    title: 'A U.S. Drought Monitor category at the selected point',
    issuer: 'U.S. Drought Monitor (NDMC / NOAA / USDA)',
    // src/impact/sources.ts fetchUsdmClaims: `DM`, an integer 0 to 4.
    field: 'DM field, 0 (D0) to 4 (D4); where class polygons overlap at the point, the highest class is shown',
    classes: [...USDM_CATEGORIES].reverse().map((category) => `${category.code} ${category.label}`),
    orderBasis: 'the D0 to D4 scale, D4 first',
    basisUrl: 'https://droughtmonitor.unl.edu/About/AbouttheData/DroughtClassification.aspx'
  },
  {
    key: 'heatrisk-level',
    title: 'A National Weather Service HeatRisk level at the selected point',
    issuer: 'National Weather Service HeatRisk (Experimental)',
    // src/impact/sources.ts fetchHeatRiskClaims: `identified.value`, the
    // verified identify pixel value for one 24-hour period.
    field: 'the HeatRisk raster class, 0 to 4, for one 24-hour period',
    classes: [...HEATRISK_CATEGORIES]
      .reverse()
      .filter((category) => category.value > 0)
      .map((category) => `${category.value} ${category.label}`),
    orderBasis:
      'the 0 to 4 scale, 4 first; 0 (Little to None) is read and listed, not ranked',
    basisUrl: 'https://www.wpc.ncep.noaa.gov/heatrisk/pdf/HeatRisk-v2.6-Understanding-HeatRisk.pdf'
  },
  {
    key: 'spc-category',
    title: 'A Storm Prediction Center Day 1 or Day 2 Fire Weather Outlook category at the selected point',
    issuer: 'NOAA Storm Prediction Center',
    // src/impact/sources.ts spcCategoricalClaim: `dn` (5, 8, 10) on layers 1 and 4.
    field: 'dn 10, 8 or 5 on the Day 1 or Day 2 layer',
    classes: SPC_DN_FIRST.map(spcCategoryLabel),
    orderBasis: 'the outlook categories, highest first; Day 1 before Day 2',
    basisUrl: 'https://www.spc.noaa.gov/misc/about.html'
  },
  {
    key: 'spc-probability',
    title: 'A Storm Prediction Center Days 3 to 8 Fire Weather Outlook probability at the selected point',
    issuer: 'NOAA Storm Prediction Center',
    // src/impact/sources.ts fetchSpcFireOutlookClaims: `label` "0.70" or "0.40".
    field: 'label 0.70 or 0.40 on a Day 3 to Day 8 layer',
    classes: ['70%', '40%'],
    orderBasis:
      'the two mapped probabilities, higher first, then the earlier day; the service value Probability Too Low is listed, not ranked',
    basisUrl: 'https://www.spc.noaa.gov/misc/SPC_Fire_Probabilistic_Information.pdf'
  },
  {
    key: 'enso-conditions',
    title: 'El Nino or La Nina conditions present',
    issuer: 'NOAA Climate Prediction Center',
    // src/impact/enso.ts fetchEnsoClaims: `roni.state.conditions` of the bundled snapshot.
    field: 'the newest operational RONI season against the CPC threshold of plus or minus 0.5 degrees Celsius',
    classes: ['El Nino conditions', 'La Nina conditions'],
    orderBasis: 'presence only; neutral conditions are read and listed, not ranked',
    basisUrl: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/'
  }
];

/** The one-line statement every surface that uses the order carries. */
export const PRIORITY_ORDER_NOTE = 'Reading order, not a severity score.';

/** What the order does and does not do, rendered with the table. */
export const PRIORITY_RULE_STATEMENTS: readonly string[] = [
  'The priority view lists the reads for the selected place in the order below: by row, then by the issuer\'s own class order inside the row. Ties keep one fixed hazard order: Drought, Fire, Heat, ENSO.',
  'This is a reading order, not a severity score. DDM adds, weights and compares nothing across hazards, and computes no number: a read in a higher row is met sooner, it is not stated to be worse.',
  'One issuer product is one entry. Where a product answers for several days, its days share the entry, placed by its first class in this order.',
  'A read with no class in the table (no polygon, no area drawn, no product in effect, an issuer\'s lowest class) is listed after the ranked reads in the issuer\'s words. It is not an all-clear.',
  'A hazard that was not read is listed after the ranked reads under its own state (loading, live (partial) or unavailable) with the reason. It is never dropped and never shown as clear.',
  'Only current and near-term reads enter the order. Seasonal outlooks stay in the full detail, which this order never rearranges.'
];

/** The horizons whose cells enter the order. */
export const PRIORITY_HORIZONS: readonly HorizonKey[] = ['current', 'nearTerm'];

/** A claim that carries a reading, with the cell it was read in. */
export interface PriorityMember {
  readonly horizon: HorizonKey;
  readonly claim: SourcedClaim;
  readonly reading: ClaimReading;
}

/** One ranked entry: an issuer product family holding a class the table lists. */
export interface PriorityEntry {
  readonly hazard: HazardKey;
  readonly family: PriorityFamily;
  readonly row: PriorityRowKey;
  /** The row's position in the published table, from 1. */
  readonly rowNumber: number;
  /** The member whose class placed the entry. */
  readonly lead: PriorityMember;
  /** Every read of the family for this hazard, ranked or not, in cell order. */
  readonly members: readonly PriorityMember[];
  /** The issuer's class in the issuer's words, for example "D2 Severe drought". */
  readonly headline: string;
  /** Why the entry is here, as a sentence, for example "NWS Red Flag Warning in effect here". */
  readonly reason: string;
}

/** A family that was read and holds no ranked class. */
export interface PriorityUnrankedRead {
  readonly family: PriorityFamily;
  readonly members: readonly PriorityMember[];
  /**
   * The read in the issuer's words where typed data can say it; null where
   * the claim's own sentence is the short and complete form.
   */
  readonly headline: string | null;
}

/** A cell that holds claims but no reading: its leading claim, as text. */
export interface PriorityTextRead {
  readonly horizon: HorizonKey;
  readonly claim: SourcedClaim;
}

/** A cell that is not fully read: its own state and reason. */
export interface PriorityCellState {
  readonly horizon: HorizonKey;
  readonly status: Exclude<HorizonStatus, 'ready'>;
  readonly note?: string;
}

/** What a hazard holds beyond its ranked entries. */
export interface PriorityRest {
  readonly hazard: HazardKey;
  readonly reads: readonly PriorityUnrankedRead[];
  readonly texts: readonly PriorityTextRead[];
  readonly states: readonly PriorityCellState[];
}

export interface PriorityOrder {
  /** Ranked entries in reading order. */
  readonly ranked: readonly PriorityEntry[];
  /** Everything else, by hazard in the fixed hazard order. */
  readonly rest: readonly PriorityRest[];
}

/** The cell fields the order reads. */
export type PriorityCell = Pick<HazardCell, 'hazard' | 'horizon' | 'status' | 'claims'> & {
  readonly note?: string;
};

interface Rank {
  readonly rowIndex: number;
  readonly classRank: number;
  /** Inside one class: the earlier day first. */
  readonly day: number;
}

const ROW_INDEX: Readonly<Record<PriorityRowKey, number>> = Object.fromEntries(
  PRIORITY_ROWS.map((row, index) => [row.key, index])
) as Record<PriorityRowKey, number>;

function familyOf(reading: ClaimReading): PriorityFamily | null {
  switch (reading.kind) {
    case 'nws-products':
      return 'nws';
    case 'wfigs-perimeters':
      return 'wfigs';
    case 'usdm-category':
      return 'usdm';
    case 'heatrisk-level':
      return 'heatrisk';
    case 'spc-fire-days':
      return 'spc';
    case 'enso-index':
      return 'enso';
    default:
      // A seasonal tercile is a reading (the evidence chain draws it) but is
      // no part of this order.
      return null;
  }
}

/** Where one reading sits in the table, or null when it holds no ranked class. */
function rankOf(reading: ClaimReading): Rank | null {
  switch (reading.kind) {
    case 'nws-products':
      return reading.events.length === 0
        ? null
        : {
            rowIndex: ROW_INDEX['nws-product'],
            classRank: Math.min(...reading.events.map(nwsPriority)),
            day: 0
          };
    case 'wfigs-perimeters':
      return reading.wildfire > 0
        ? { rowIndex: ROW_INDEX['wfigs-wildfire'], classRank: 0, day: 0 }
        : null;
    case 'usdm-category':
      return reading.dm === null
        ? null
        : { rowIndex: ROW_INDEX['usdm-category'], classRank: 4 - reading.dm, day: 0 };
    case 'heatrisk-level':
      return reading.value === null || reading.value === 0
        ? null
        : { rowIndex: ROW_INDEX['heatrisk-level'], classRank: 4 - reading.value, day: reading.day };
    case 'spc-fire-days': {
      const day = Math.min(...reading.days);
      if (reading.category !== undefined) {
        return {
          rowIndex: ROW_INDEX['spc-category'],
          classRank: SPC_DN_FIRST.indexOf(reading.category),
          day
        };
      }
      if (reading.probability === '0.70' || reading.probability === '0.40') {
        return {
          rowIndex: ROW_INDEX['spc-probability'],
          classRank: reading.probability === '0.70' ? 0 : 1,
          day
        };
      }
      return null;
    }
    case 'enso-index':
      return reading.conditions === 'neutral'
        ? null
        : { rowIndex: ROW_INDEX['enso-conditions'], classRank: 0, day: 0 };
    default:
      return null;
  }
}

function compareRank(a: Rank, b: Rank): number {
  return a.rowIndex - b.rowIndex || a.classRank - b.classRank || a.day - b.day;
}

/** "+1.69", the index's own printed form (src/impact/enso.ts `signed`). */
export function signedIndex(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

/** "Day 1", "Days 1 and 2", "Days 3 to 8" or "Days 3, 5 and 6". */
export function daysPhrase(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'no day';
  if (sorted.length === 1) return `Day ${sorted[0]}`;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (sorted.length > 2 && last - first === sorted.length - 1) return `Days ${first} to ${last}`;
  return `Days ${sorted.slice(0, -1).join(', ')} and ${last}`;
}

/** NWS product names in the issuer's priority order. */
export function sortNwsEvents(events: readonly string[]): string[] {
  return [...events].sort((a, b) => nwsPriority(a) - nwsPriority(b) || a.localeCompare(b, 'en'));
}

function ensoPhrase(reading: Extract<ClaimReading, { kind: 'enso-index' }>): string {
  const preliminary = reading.preliminary ? ', preliminary' : '';
  return `${reading.index} ${signedIndex(reading.value)} (${reading.season} ${reading.year}${preliminary})`;
}

const ENSO_CONDITIONS_WORD: Readonly<Record<'el-nino' | 'la-nina' | 'neutral', string>> = {
  'el-nino': 'El Nino',
  'la-nina': 'La Nina',
  neutral: 'Neutral'
};

/** The issuer's class in the issuer's words, for a reading that holds one. */
export function readingHeadline(reading: ClaimReading): string | null {
  switch (reading.kind) {
    case 'nws-products':
      return reading.events.length > 0 ? sortNwsEvents(reading.events).join(', ') : null;
    case 'wfigs-perimeters': {
      if (reading.wildfire === 0) return null;
      const floor = reading.lowerBound ? 'At least ' : '';
      return `${floor}${reading.wildfire} mapped wildfire ${reading.wildfire === 1 ? 'perimeter' : 'perimeters'}`;
    }
    case 'usdm-category': {
      if (reading.dm === null) return USDM_NONE_SWATCH.label;
      const category = USDM_CATEGORIES[reading.dm]!;
      return `${category.code} ${category.label}`;
    }
    case 'heatrisk-level':
      if (reading.value === null) return 'No data at the selected point';
      return `HeatRisk ${reading.value} ${HEATRISK_CATEGORIES[reading.value]!.label}`;
    case 'spc-fire-days': {
      const days = daysPhrase(reading.days);
      if (reading.category !== undefined) return `${spcCategoryLabel(reading.category)}, ${days}`;
      if (reading.probability === '0.70') return `70% probability, ${days}`;
      if (reading.probability === '0.40') return `40% probability, ${days}`;
      if (reading.probability !== undefined) return `${reading.probability}, ${days}`;
      return `No area drawn, ${days}`;
    }
    case 'enso-index':
      return `${ENSO_CONDITIONS_WORD[reading.conditions]} conditions`;
    default:
      return null;
  }
}

/** Why a ranked reading is where it is: a sentence built from issuer words. */
function reasonFor(reading: ClaimReading): string {
  switch (reading.kind) {
    case 'nws-products':
      return `NWS ${sortNwsEvents(reading.events).join(' and ')} in effect here`;
    case 'wfigs-perimeters': {
      const floor = reading.lowerBound ? 'At least ' : '';
      const verb = reading.wildfire === 1 ? 'perimeter intersects' : 'perimeters intersect';
      return `${floor}${reading.wildfire} current mapped NIFC wildfire ${verb} the bounding box around this selection`;
    }
    case 'usdm-category':
      return `U.S. Drought Monitor: ${readingHeadline(reading)} at the selected point`;
    case 'heatrisk-level':
      return `NWS HeatRisk: ${reading.value} ${HEATRISK_CATEGORIES[reading.value ?? 0]!.label} at the selected point, on the 0 to 4 scale`;
    case 'spc-fire-days': {
      const day = daysPhrase(reading.days);
      if (reading.category !== undefined) {
        return `SPC ${day} Fire Weather Outlook: ${spcCategoryLabel(reading.category)} at the selected point`;
      }
      const pct = reading.probability === '0.70' ? 70 : 40;
      return `SPC ${day} Fire Weather Outlook: ${pct}% probability within 12 miles of the selected point`;
    }
    case 'enso-index':
      return `${ENSO_CONDITIONS_WORD[reading.conditions]} conditions present: ${ensoPhrase(reading)}`;
    default:
      return '';
  }
}

/** A family read with no ranked class, in the issuer's words where typed data can say it. */
function unrankedHeadline(family: PriorityFamily, members: readonly PriorityMember[]): string | null {
  const first = members[0]!.reading;
  if (family === 'spc') {
    const none: number[] = [];
    const low: number[] = [];
    for (const { reading } of members) {
      if (reading.kind !== 'spc-fire-days') continue;
      (reading.probability === 'Probability Too Low' ? low : none).push(...reading.days);
    }
    const parts = [
      none.length > 0 ? `No area drawn over this point, ${daysPhrase(none)}` : null,
      low.length > 0 ? `Probability Too Low, ${daysPhrase(low)}` : null
    ].filter((part): part is string => part !== null);
    return parts.join('. ');
  }
  if (first.kind === 'enso-index') return `Neutral conditions: ${ensoPhrase(first)}`;
  if (first.kind === 'heatrisk-level' || first.kind === 'usdm-category') return readingHeadline(first);
  // NWS products and WFIGS perimeters: the claim's own sentence is the short form.
  return null;
}

/**
 * Order one place's current and near-term cells by the table.
 *
 * `cells` may be given in any order; the result does not depend on it beyond
 * the stated ties. Cells of other horizons are ignored.
 */
export function orderBriefing(cells: readonly PriorityCell[]): PriorityOrder {
  const considered = PRIORITY_HORIZONS.flatMap((horizon) =>
    HAZARD_KEYS.map((hazard) =>
      cells.find((cell) => cell.horizon === horizon && cell.hazard === hazard)
    ).filter((cell): cell is PriorityCell => cell !== undefined)
  );

  // Group every reading by hazard and issuer product family, in cell order.
  const groups = new Map<string, { hazard: HazardKey; family: PriorityFamily; members: PriorityMember[] }>();
  for (const cell of considered) {
    for (const claim of cell.claims) {
      const reading = claim.reading;
      if (reading === undefined) continue;
      const family = familyOf(reading);
      if (family === null) continue;
      const key = `${cell.hazard}:${family}`;
      const group = groups.get(key) ?? { hazard: cell.hazard, family, members: [] };
      group.members.push({ horizon: cell.horizon, claim, reading });
      groups.set(key, group);
    }
  }

  const ranked: Array<{ entry: PriorityEntry; rank: Rank; order: number }> = [];
  const unranked = new Map<HazardKey, PriorityUnrankedRead[]>();
  let order = 0;
  for (const group of groups.values()) {
    let best: { member: PriorityMember; rank: Rank } | null = null;
    for (const member of group.members) {
      const rank = rankOf(member.reading);
      if (rank !== null && (best === null || compareRank(rank, best.rank) < 0)) {
        best = { member, rank };
      }
    }
    if (best === null) {
      const list = unranked.get(group.hazard) ?? [];
      list.push({
        family: group.family,
        members: group.members,
        headline: unrankedHeadline(group.family, group.members)
      });
      unranked.set(group.hazard, list);
      continue;
    }
    const row = PRIORITY_ROWS[best.rank.rowIndex]!;
    ranked.push({
      rank: best.rank,
      order: order++,
      entry: {
        hazard: group.hazard,
        family: group.family,
        row: row.key,
        rowNumber: best.rank.rowIndex + 1,
        lead: best.member,
        members: group.members,
        headline: readingHeadline(best.member.reading) ?? '',
        reason: reasonFor(best.member.reading)
      }
    });
  }
  ranked.sort(
    (a, b) =>
      compareRank(a.rank, b.rank) ||
      HAZARD_KEYS.indexOf(a.entry.hazard) - HAZARD_KEYS.indexOf(b.entry.hazard) ||
      a.order - b.order
  );

  const rest: PriorityRest[] = [];
  for (const hazard of HAZARD_KEYS) {
    const own = considered.filter((cell) => cell.hazard === hazard);
    const texts: PriorityTextRead[] = [];
    const states: PriorityCellState[] = [];
    for (const cell of own) {
      // A cell whose claims carry no reading this order can place still has
      // something to say: its leading claim stands in, as text.
      const placed = cell.claims.some(
        (claim) => claim.reading !== undefined && familyOf(claim.reading) !== null
      );
      const leading = cell.claims[0];
      if (!placed && leading !== undefined) texts.push({ horizon: cell.horizon, claim: leading });
      if (cell.status !== 'ready') {
        states.push({
          horizon: cell.horizon,
          status: cell.status,
          // An empty note is a statement too: the matrix sets it on a cell
          // whose lane answered with nothing to say, to keep the absence
          // sentence off it. It travels as it is.
          ...(cell.note !== undefined ? { note: cell.note } : {})
        });
      }
    }
    const reads = unranked.get(hazard) ?? [];
    const isRanked = ranked.some(({ entry }) => entry.hazard === hazard);
    if (reads.length === 0 && texts.length === 0 && states.length === 0) {
      if (isRanked) continue;
      // Nothing was given for this hazard at all (no cell in the input). It
      // is still listed, as not read, never left out.
      states.push({ horizon: 'current', status: 'unavailable' });
    }
    rest.push({ hazard, reads, texts, states });
  }

  return { ranked: ranked.map(({ entry }) => entry), rest };
}
