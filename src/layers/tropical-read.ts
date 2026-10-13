/**
 * The tropical cyclones slot sweep (ENSO block B3): reads the NHC and CPHC
 * Tropical Weather MapServer the way its admission specifies
 * (planning/2026-09-25-desktop-pass/admissions/noaa-tropical-cyclones.md,
 * lines 5 to 8) and maps the answer onto the six layer states. No DOM, no
 * map: the layer module draws what this returns, and tests/tropical-read.test.mjs
 * drives it in Node.
 *
 * The read. The Forecast Points layer of all fifteen slots first (AT1 to CP5;
 * slots are not filled in order, so every one is read): a slot is occupied
 * when its points layer returns at least one feature. That is the one rule
 * DDM adds, and it reads issuer data, it computes none. Then the Forecast
 * Track, Forecast Cone and Watch-Warning layers of each occupied slot.
 *
 * Bounds. Every request goes through `fetchJsonWithBudget` with a 10 s
 * timeout and a 1 MiB decoded cap, under one sweep controller linked to the
 * caller's signal; a 10 s deadline on the whole sweep aborts what is still
 * open, so a stalled sublayer reads `live (partial)` or `unavailable`, never
 * an endless `loading`. A caller abort (deactivate, supersession) resolves
 * the sweep to null: a late answer can never be drawn.
 *
 * States. `unavailable`: no presence read succeeded, or none drew while some
 * failed (a failure is HTTP non-2xx, a timeout, JSON that does not parse, a
 * body that is not a FeatureCollection, or an ArcGIS error envelope, which
 * this service answers at HTTP 200 and is tested before `features`).
 * `no data`: all fifteen presence reads answered a valid empty collection,
 * a verified absence for the three basins only. `live (partial)`: a storm is
 * drawn while a slot or a sublayer failed, a feature had unusable geometry,
 * a response reached the 2000-record cap, or a slot's sublayers disagree on
 * the advisory number (the disagreeing sublayer is not drawn: two
 * advisories are never drawn as one). `live`: a storm is drawn and none of
 * those happened.
 */

import type { Feature, Geometry } from 'geojson';

import {
  TROPICAL_PART_OFFSET,
  TROPICAL_SLOTS,
  type TropicalPart,
  type TropicalSlot
} from '../config/tropical-presentation';
import { fetchJsonWithBudget, linkAbort } from '../util/fetch';
import { isObject } from '../util/guards';

export type TropicalState = 'live' | 'live (partial)' | 'unavailable' | 'no data';

export interface TropicalReadLimits {
  readonly requestTimeoutMs: number;
  readonly sweepDeadlineMs: number;
  readonly maxDecodedBytes: number;
}

/** The admission's bounds: 10 s per request, a 10 s sweep deadline, 1 MiB per body. */
export const TROPICAL_READ_LIMITS: TropicalReadLimits = {
  requestTimeoutMs: 10_000,
  sweepDeadlineMs: 10_000,
  maxDecodedBytes: 1_048_576
};

/** One drawn storm, in the issuer's words, for the key. */
export interface TropicalStorm {
  readonly bin: string;
  readonly name: string;
  /** The issuer's `basin` value as given; the key names it or marks it unrecognised. */
  readonly basin: string;
  readonly advisory: string;
  readonly issued: string;
}

export interface TropicalSweep {
  readonly state: TropicalState;
  /** Issuer features, each tagged with `ddmPart` (points, track, cone, ww). */
  readonly features: readonly Feature[];
  readonly storms: readonly TropicalStorm[];
  /** What made the read partial or unavailable, for the console and the key. */
  readonly problems: readonly string[];
}

/** The service's own record cap (`maxRecordCount`); reaching it is not completeness. */
const RECORD_CAP = 2000;

/** The fields each part reads (the service's field names, checked 2026-10-13). */
const POINT_OUT_FIELDS =
  'stormname,stormtype,dvlbl,stormsrc,basin,advdate,advisnum,maxwind,gust,mslp,ssnum,tcdvlp,tcdir,tcspd,tau,fldatelbl,binnumber,idp_source';
const LINE_OUT_FIELDS = 'stormname,stormtype,basin,advdate,advisnum,binnumber,idp_source';
const WW_OUT_FIELDS = 'stormname,stormtype,basin,advdate,advisnum,tcww,binnumber,idp_source';

const PART_QUERY: Readonly<Record<TropicalPart, { readonly outFields: string; readonly geometry: readonly string[] }>> = {
  points: { outFields: POINT_OUT_FIELDS, geometry: ['Point'] },
  track: { outFields: LINE_OUT_FIELDS, geometry: ['LineString', 'MultiLineString'] },
  cone: { outFields: LINE_OUT_FIELDS, geometry: ['Polygon', 'MultiPolygon'] },
  ww: { outFields: WW_OUT_FIELDS, geometry: ['LineString', 'MultiLineString'] }
};

let pendingReads = 0;

/** Requests still open (the "zero pending work after cancel" observation). */
export function pendingTropicalReads(): number {
  return pendingReads;
}

export function tropicalQueryUrl(baseUrl: string, slot: TropicalSlot, part: TropicalPart): string {
  const params = new URLSearchParams({ where: '1=1', returnGeometry: 'true', outSR: '4326', f: 'geojson' });
  params.set('outFields', PART_QUERY[part].outFields);
  return `${baseUrl}/${slot.base + TROPICAL_PART_OFFSET[part]}/query?${params.toString()}`;
}

/** Nested coordinate arrays of the given depth (0 = one position), every number finite. */
function isCoords(value: unknown, depth: number): boolean {
  if (!Array.isArray(value)) return false;
  if (depth === 0) return value.length >= 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  return value.length > 0 && value.every((item) => isCoords(item, depth - 1));
}

const DEPTH: Readonly<Record<string, number>> = { Point: 0, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

function isGeometry(value: unknown, allowed: readonly string[]): value is Geometry {
  return (
    isObject(value) &&
    typeof value.type === 'string' &&
    allowed.includes(value.type) &&
    isCoords(value.coordinates, DEPTH[value.type] ?? -1)
  );
}

interface PartRead {
  readonly features: Feature[];
  /** Features returned but not drawable (no or bad geometry, no properties). */
  readonly dropped: number;
  /** Reached the record cap or flagged `exceededTransferLimit`. */
  readonly capped: boolean;
}

type Outcome = { readonly ok: true; readonly read: PartRead } | { readonly ok: false; readonly why: string };

/** Validate one parsed body. The envelope check comes first: this service answers errors at HTTP 200. */
function parsePart(json: unknown, part: TropicalPart): Outcome {
  if (isObject(json) && json.error !== undefined) return { ok: false, why: 'ArcGIS error envelope' };
  if (!isObject(json) || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    return { ok: false, why: 'not a FeatureCollection' };
  }
  const features: Feature[] = [];
  let dropped = 0;
  for (const candidate of json.features as unknown[]) {
    if (!isObject(candidate) || !isObject(candidate.properties) || !isGeometry(candidate.geometry, PART_QUERY[part].geometry)) {
      dropped += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: candidate.geometry,
      properties: { ...candidate.properties, ddmPart: part }
    });
  }
  const limit = json.exceededTransferLimit === true || (isObject(json.properties) && json.properties.exceededTransferLimit === true);
  return { ok: true, read: { features, dropped, capped: limit || json.features.length >= RECORD_CAP } };
}

async function readPart(
  baseUrl: string,
  slot: TropicalSlot,
  part: TropicalPart,
  signal: AbortSignal,
  limits: TropicalReadLimits
): Promise<Outcome> {
  pendingReads += 1;
  try {
    const json = await fetchJsonWithBudget(tropicalQueryUrl(baseUrl, slot, part), null, signal, limits.requestTimeoutMs, limits.maxDecodedBytes);
    return parsePart(json, part);
  } catch (err) {
    // A caller abort discards the sweep, so an aborted sweep signal here is the deadline: say so in the console.
    if (signal.aborted) return { ok: false, why: `no answer before the ${limits.sweepDeadlineMs} ms sweep deadline` };
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  } finally {
    pendingReads -= 1;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

/**
 * Read all fifteen slots. Resolves null when `signal` aborts before the sweep
 * settles (the caller drew nothing and must draw nothing).
 */
export async function readTropicalSweep(
  baseUrl: string,
  signal: AbortSignal,
  limits: TropicalReadLimits = TROPICAL_READ_LIMITS
): Promise<TropicalSweep | null> {
  const sweep = new AbortController();
  const unlink = linkAbort(sweep, signal);
  const deadline = setTimeout(() => sweep.abort(), limits.sweepDeadlineMs);
  const problems: string[] = [];
  const features: Feature[] = [];
  const storms: TropicalStorm[] = [];
  let presenceOk = 0;
  let partial = false;
  try {
    const presence = await Promise.all(TROPICAL_SLOTS.map((slot) => readPart(baseUrl, slot, 'points', sweep.signal, limits)));
    if (signal.aborted) return null;
    const occupied: { readonly slot: TropicalSlot; readonly points: PartRead }[] = [];
    presence.forEach((outcome, i) => {
      const slot = TROPICAL_SLOTS[i]!;
      if (!outcome.ok) {
        problems.push(`${slot.bin} points: ${outcome.why}`);
        return;
      }
      presenceOk += 1;
      if (outcome.read.features.length > 0 || outcome.read.dropped > 0) occupied.push({ slot, points: outcome.read });
    });

    const rest = await Promise.all(
      occupied.map(({ slot }) =>
        Promise.all((['track', 'cone', 'ww'] as const).map((part) => readPart(baseUrl, slot, part, sweep.signal, limits)))
      )
    );
    if (signal.aborted) return null;

    occupied.forEach(({ slot, points }, i) => {
      const advisory = text(points.features[0]?.properties?.['advisnum']);
      // The points layer names the storm with its classification ("Hurricane Simon"); the
      // track, cone and watch-warning layers carry the bare name, so every part takes the points title.
      const ddmTitle = text(points.features[0]?.properties?.['stormname']);
      const reads: [TropicalPart, Outcome][] = [
        ['points', { ok: true, read: points }],
        ...(['track', 'cone', 'ww'] as const).map((part, j): [TropicalPart, Outcome] => [part, rest[i]![j]!])
      ];
      for (const [part, outcome] of reads) {
        if (!outcome.ok) {
          partial = true;
          problems.push(`${slot.bin} ${part}: ${outcome.why}`);
          continue;
        }
        const { read } = outcome;
        if (read.dropped > 0 || read.capped) {
          partial = true;
          problems.push(`${slot.bin} ${part}: ${read.dropped > 0 ? `${read.dropped} feature(s) without usable geometry` : 'record cap reached'}`);
        }
        // One advisory per slot: a sublayer from another advisory is not drawn under this one.
        const same = read.features.filter((f) => text(f.properties?.['advisnum']) === advisory);
        if (same.length < read.features.length) {
          partial = true;
          problems.push(`${slot.bin} ${part}: advisory number differs from the points advisory ${advisory}`);
        }
        features.push(...same.map((f) => ({ ...f, properties: { ...f.properties, ddmTitle } })));
      }
      const first = points.features[0]?.properties;
      if (first) {
        storms.push({
          bin: text(first['binnumber']) || slot.bin,
          name: text(first['stormname']),
          basin: text(first['basin']),
          advisory,
          issued: text(first['advdate'])
        });
      }
    });
  } finally {
    clearTimeout(deadline);
    unlink();
  }
  if (signal.aborted) return null;

  let state: TropicalState;
  if (features.length === 0) {
    state = presenceOk === TROPICAL_SLOTS.length && problems.length === 0 ? 'no data' : 'unavailable';
  } else {
    state = partial || presenceOk < TROPICAL_SLOTS.length ? 'live (partial)' : 'live';
  }
  return { state, features, storms, problems };
}
