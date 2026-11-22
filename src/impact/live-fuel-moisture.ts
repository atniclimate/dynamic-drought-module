/**
 * The Impact Briefing's live fuel moisture reading (fire, current conditions).
 *
 * For the selected place it reads the five newest published maps, summarizes
 * the cells inside the place in each, and states the newest comparable one:
 * the median, the middle half of the area, and the map's dates, with one
 * earlier map beside it when there is one. Method M-115; the source, the
 * limits and every string are in src/config/live-fuel-moisture.ts.
 *
 * What it will not do: name a trend, a danger level or a threshold. The
 * source publishes none, and the authors say their display limits define no
 * fire-danger thresholds. It states the numbers and their dates.
 */

import {
  LFMC_BRIEFING,
  LFMC_COVERAGE,
  LFMC_TEXT,
  LIVE_FUEL_MOISTURE_LINKS,
  lfmcCovers
} from '../config/live-fuel-moisture';
import { trendLineSvg } from '../ui/charts';
import {
  lfmcBoxFor,
  lfmcDateSpan,
  readLfmcArea,
  readLfmcComposites,
  type LfmcAreaReading,
  type LfmcComposite
} from '../util/live-fuel-moisture-read';
import { isFetchTimeout } from '../util/fetch';
import { makeClaim, todayIso } from './evidence';
import type { SourceResult } from './sources';
import type { BoundarySelectionContext, SourcedClaim } from './types';

/** One map's reading for the place: null when the map does not reach the place at all. */
export interface LfmcMapReading {
  readonly map: LfmcComposite;
  readonly reading: LfmcAreaReading | null;
}

/**
 * The maps whose readings may be compared for this place, oldest first: those
 * carrying values for at least `comparableShare` of the cells the fullest map
 * carries there, and at least `minCells` of them (see LFMC_BRIEFING for why).
 */
export function comparableReadings(rows: readonly LfmcMapReading[]): (LfmcMapReading & { readonly reading: LfmcAreaReading })[] {
  const fullest = Math.max(0, ...rows.map((row) => row.reading?.cellsWithValue ?? 0));
  const floor = Math.max(LFMC_BRIEFING.minCells, fullest * LFMC_BRIEFING.comparableShare);
  return rows.filter(
    (row): row is LfmcMapReading & { readonly reading: LfmcAreaReading } =>
      row.reading !== null && row.reading.cellsWithValue >= floor
  );
}

const DAY_MS = 86_400_000;
/** The last day a map covers, as `YYYY-MM-DD` (the list gives the day after it). */
const lastDay = (map: LfmcComposite): string => new Date(Date.parse(map.endExclusive) - DAY_MS).toISOString().slice(0, 10);

/**
 * The briefing's claims from the maps read for a place. Pure: no network, no
 * clock but `retrieved`. Returns no claim when no map reaches the place, or
 * when the place holds too few valued cells for a statement.
 */
export function buildLfmcClaims(
  rows: readonly LfmcMapReading[],
  where: string,
  reporting: string,
  retrieved: string
): SourcedClaim[] {
  const reached = rows.filter((row) => row.reading !== null);
  if (reached.length === 0) return [];
  const usable = comparableReadings(rows);
  const common = {
    source: LFMC_TEXT.source,
    sourceUrl: LIVE_FUEL_MOISTURE_LINKS.viewer,
    product: 'live-fuel-moisture',
    // A retrieval from satellite observations and weather through a trained model: an analysis of
    // recent conditions, not a simulation and not a measurement.
    evidence: 'modeled-analysis'
  } as const;

  if (usable.length === 0) {
    // The absence is stated only when the maps read cells here and none of them holds a value.
    // A place with a few valued cells, fewer than a statement is made from, or one too small to
    // hold a cell centre, gets no sentence: its gap is DDM's floor or sampling, not the model's.
    const read = Math.max(0, ...reached.map((row) => row.reading!.cells));
    const valued = Math.max(0, ...reached.map((row) => row.reading!.cellsWithValue));
    if (read === 0 || valued > 0) return [];
    const first = reached[0]!.map;
    const last = reached[reached.length - 1]!.map;
    return [
      makeClaim({
        ...common,
        text:
          `No live fuel moisture estimate ${where} in the ${reached.length === 1 ? 'newest map' : `${reached.length} newest maps`} ` +
          `(${lfmcDateSpan(first.start, last.endExclusive)}). ` +
          'A cell has no value where the publisher\'s model made no estimate: land it does not treat as grass, shrub or tree, or satellite input that was missing or screened out. No value is not zero.',
        dates: { retrieved },
        support: { native: LFMC_TEXT.nativeSupport, reporting }
      })
    ];
  }

  const current = usable[usable.length - 1]!;
  const { median, q25, q75, cells, cellsWithValue, cellKm } = current.reading;
  // The earliest comparable map, when it is at least two maps (16 days) older.
  const earlier = usable.find((row) => Date.parse(current.map.start) - Date.parse(row.map.start) >= 16 * DAY_MS);
  const spread = q25 === q75 ? '' : `, with the middle half of the area between ${q25} and ${q75}`;
  const before = earlier
    ? ` In the estimate for ${lfmcDateSpan(earlier.map.start, earlier.map.endExclusive)} it was about ${earlier.reading.median}.`
    : '';
  const chartSvg = usable.length >= 3
    ? trendLineSvg(
        usable.map((row) => ({ t: Date.parse(row.map.start), v: row.reading.median })),
        {
          title: `Live fuel moisture ${where}, median percent of dry mass, ${lfmcDateSpan(usable[0]!.map.start, current.map.endExclusive)}`,
          yMax: 250,
          yLabel: 'Percent',
          source: LFMC_TEXT.issuer
        }
      )
    : '';
  const cellWidth = cellKm < 1 ? `${Math.round(cellKm * 10) * 100} m` : `${cellKm.toFixed(1)} km`;
  return [
    makeClaim({
      ...common,
      text:
        `Live fuel moisture ${where}: about ${median} percent of dry mass${spread}, ` +
        `in the satellite-based estimate for ${lfmcDateSpan(current.map.start, current.map.endExclusive)}.${before} ` +
        'Lower values mean drier living plants.',
      dates: { valid: lastDay(current.map), retrieved },
      support: {
        native: LFMC_TEXT.nativeSupport,
        effective: `median of the ${cellsWithValue.toLocaleString('en-US')} cells with a value, of ${cells.toLocaleString('en-US')} read, each about ${cellWidth} wide; computed by DDM from EOSIAL Laboratory maps`,
        reporting
      },
      uncertainty: { kind: 'not-quantified', text: `The maps carry no per-cell uncertainty. ${LFMC_TEXT.accuracyNote}` },
      method: {
        ...(current.map.modelVersion ? { version: `model ${current.map.modelVersion}` } : {}),
        basis: LFMC_TEXT.modelNote
      },
      ...(chartSvg ? { chartSvg } : {})
    })
  ];
}

/**
 * How the briefing names the ground it read. A place reaching past the maps'
 * area (Oklahoma, the Dakotas, a reservation across 101.4°W) is read only
 * where the maps reach, and its sentence says so: a strip is never given as
 * the whole place. An outline's box is touched by the outline, so a box past
 * an edge means the place is past it too.
 */
export function lfmcPlaceWording(
  title: string,
  box: readonly [number, number, number, number] | null
): { readonly where: string; readonly reporting: string } {
  if (box === null) {
    return {
      where: `within about ${LFMC_BRIEFING.pointHalfWidthKm} km of the selected point`,
      reporting: `a square about ${LFMC_BRIEFING.pointHalfWidthKm * 2} km across, centred on the selected point`
    };
  }
  const [west, south, east, north] = LFMC_COVERAGE;
  const partial = box[0] < west || box[1] < south || box[2] > east || box[3] > north;
  return partial
    ? { where: `across the part of ${title} the maps cover`, reporting: `the part of ${title} inside the maps' area` }
    : { where: `across ${title}`, reporting: title };
}

/**
 * Read the newest maps for the selection and state what they say. A place the
 * maps cannot cover states nothing and asks the network nothing. A list or a
 * map that cannot be read is a note, never a missing-value sentence.
 */
export async function fetchLiveFuelMoistureClaims(context: BoundarySelectionContext, signal: AbortSignal): Promise<SourceResult> {
  if (context.bboxCrossesAntimeridian) return { claims: [], ok: true };
  const area = context.bbox !== undefined && context.bbox[0] < context.bbox[2] && context.bbox[1] < context.bbox[3];
  const box = lfmcBoxFor(context.lngLat, context.bbox);
  if (!lfmcCovers(box)) return { claims: [], ok: true };
  const { where, reporting } = lfmcPlaceWording(context.title, area ? box : null);

  try {
    const composites = await readLfmcComposites(signal);
    if (signal.aborted) return { claims: [], ok: false };
    const recent = composites.slice(-LFMC_BRIEFING.recentMaps);
    let failed = 0;
    const rows = await Promise.all(
      recent.map(async (map): Promise<LfmcMapReading | null> => {
        try {
          return { map, reading: await readLfmcArea(map.url, box, area ? context.placeGeometry : null, signal) };
        } catch (err) {
          if (!signal.aborted) console.warn(`[impact] Live fuel moisture map ${map.start} failed.`, err);
          failed += 1;
          return null;
        }
      })
    );
    if (signal.aborted) return { claims: [], ok: false };
    const read = rows.filter((row): row is LfmcMapReading => row !== null);
    if (read.length === 0) {
      return { claims: [], ok: false, note: 'The live fuel moisture maps could not be read.' };
    }
    const claims = buildLfmcClaims(read, where, reporting, todayIso());
    return failed === 0
      ? { ok: true, claims }
      : { ok: true, partial: true, claims, note: `${failed} of the ${recent.length} newest live fuel moisture maps could not be read.` };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] Live fuel moisture list failed.', err);
    return {
      claims: [],
      ok: false,
      note: isFetchTimeout(err) ? 'The live fuel moisture maps did not answer in time.' : 'The live fuel moisture maps did not respond.'
    };
  }
}
