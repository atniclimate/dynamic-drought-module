/**
 * Locate: the pure core (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * Locate finds the person's own position and names the place they are
 * standing in. The person's point is the most sensitive value this
 * application ever holds, so the shape of this module is a privacy shape:
 *
 *   - THE POINT LIVES IN MEMORY ONLY. `LocateState.fix` is the one place it
 *     is kept. Nothing here reads or writes storage, the URL or the network.
 *     The single stored value is the launch preference, the word `yes` or
 *     `no` (src/state/locate-preference.ts).
 *   - THE FIRST ANSWER IS LOCAL. `findStates` tests the point against the
 *     bundled Census state outlines the page already holds.
 *   - THE CAMERA NEVER CENTRES ON THE POINT. Boundary layers, base map tiles
 *     and imagery all load by map view, so a view centred on a person tells
 *     every map source where that person is. `coarseCell` snaps the point
 *     to a half-degree grid square instead: every request the frame causes
 *     is a function of the square, never of the point inside it.
 *   - NO CLAIM THE RING CANNOT SUPPORT. A position is a disc, not a dot: the
 *     device's own accuracy radius, widened by how coarsely the boundary
 *     being tested was drawn. `classifyDisc` says `inside` only when the
 *     whole disc is inside, and `straddles` when the disc reaches a line.
 *
 * THE STATE MACHINE (`reduceLocate`) is a plain reducer. Every in-flight
 * event carries the attempt number it belongs to, and an event is acted on
 * only while its attempt is the current one AND that attempt is still in
 * flight. That one rule is the whole cancellation contract: an answer that
 * arrives after a cancel, a timeout or a newer press finds nothing to
 * revive.
 *
 * Kept import-free on purpose (type-only imports are erased), so
 * `node --test` can load it with Node's type stripping and no resolve hook.
 */

import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Position } from 'geojson';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** The stated bound on acquiring a position, in ms. The interface says "12 seconds". */
export const LOCATE_TIMEOUT_MS = 12_000;

/** A fix at or under this radius is taken the moment it arrives. */
export const GOOD_FIX_M = 100;

/**
 * A coarser first fix waits this long for a better one before it is taken.
 * Phones often answer first from the network and a second or two later from
 * the satellites; the wait is inside the 12 s bound, never added to it.
 */
export const FIX_SETTLE_MS = 3_000;

/** Above this radius the state is "located with low accuracy". */
export const LOW_ACCURACY_M = 1_000;

/** The side of the grid square the camera frames, in degrees. */
export const LOCATE_CELL_DEG = 0.5;

/**
 * DDM's own margin around the bundled state outline, in metres. NOT an
 * issuer figure. The outline is the Census 1:20,000,000 cartographic file
 * (scripts/build-states.mjs), deliberately coarse: its median chord in the
 * Pacific Northwest states is about 7 km. A position closer than this to
 * the drawn line is reported as at the line, never placed on one side.
 */
export const STATE_OUTLINE_MARGIN_M = 2_000;

/** Mean metres per degree of latitude, and of longitude at the equator. */
const M_PER_DEG = 111_320;
/** Mean Earth radius in metres (IUGG), for the accuracy ring. */
const EARTH_RADIUS_M = 6_371_008.8;

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * The eight states. `asking`: the browser's own permission sheet is (or may
 * be) up, and no clock runs while the person reads it. `locating`: allowed,
 * waiting for a fix, bounded by LOCATE_TIMEOUT_MS.
 */
export type LocatePhase =
  | 'idle'
  | 'asking'
  | 'locating'
  | 'located'
  | 'located-low'
  | 'denied'
  | 'unavailable'
  | 'timeout';

/** What the Permissions API said. `unknown`: the browser has no such API. */
export type PermissionReading = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Why no position can be had. */
export type UnavailableReason = 'unsupported' | 'insecure' | 'no-fix';

/** A position as the device reports it. In memory only. */
export interface LocateFix {
  readonly lng: number;
  readonly lat: number;
  /** The device's own accuracy radius in metres. */
  readonly accuracy: number;
}

export interface LocateState {
  readonly phase: LocatePhase;
  /** The attempt this state belongs to. In-flight events for any other attempt are ignored. */
  readonly attempt: number;
  /** The permission reading when this attempt began, for the wording. */
  readonly permission: PermissionReading;
  readonly reason: UnavailableReason | null;
  /** The accepted position. Null in every state but the two located ones. */
  readonly fix: LocateFix | null;
  /** The best coarse fix so far, held while a better one may still arrive. */
  readonly pending: LocateFix | null;
  /** How many retries a timeout may still offer. One per press. */
  readonly retriesLeft: number;
}

export type LocateEvent =
  | {
      readonly type: 'start';
      readonly attempt: number;
      readonly supported: boolean;
      readonly secure: boolean;
      readonly permission: PermissionReading;
      /** True for the one retry a timeout offers. */
      readonly retry?: boolean;
    }
  | { readonly type: 'permission'; readonly attempt: number; readonly permission: 'granted' | 'denied' | 'prompt' }
  | { readonly type: 'fix'; readonly attempt: number; readonly fix: LocateFix }
  | { readonly type: 'settle'; readonly attempt: number }
  | {
      readonly type: 'error';
      readonly attempt: number;
      readonly code: number;
      /** The permission reading taken after a refusal (code 1), where the browser offers one. */
      readonly permission?: PermissionReading;
    }
  | { readonly type: 'deadline'; readonly attempt: number }
  | { readonly type: 'cancel' }
  | { readonly type: 'clear' }
  | { readonly type: 'dismiss' };

export const IDLE_STATE: LocateState = Object.freeze({
  phase: 'idle',
  attempt: 0,
  permission: 'unknown',
  reason: null,
  fix: null,
  pending: null,
  retriesLeft: 1
});

/** Whether a phase is waiting on the browser or the device. */
export function isInFlight(phase: LocatePhase): boolean {
  return phase === 'asking' || phase === 'locating';
}

/** Whether a phase holds a position. */
export function isLocated(phase: LocatePhase): boolean {
  return phase === 'located' || phase === 'located-low';
}

function validFix(fix: LocateFix): boolean {
  return (
    Number.isFinite(fix.lng) &&
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.accuracy) &&
    fix.accuracy >= 0 &&
    Math.abs(fix.lat) <= 90 &&
    Math.abs(fix.lng) <= 180
  );
}

function accept(state: LocateState, fix: LocateFix): LocateState {
  return {
    ...state,
    phase: fix.accuracy > LOW_ACCURACY_M ? 'located-low' : 'located',
    fix,
    pending: null,
    reason: null
  };
}

function fail(state: LocateState, phase: 'denied' | 'unavailable' | 'timeout', reason: UnavailableReason | null): LocateState {
  return { ...state, phase, reason, fix: null, pending: null };
}

/**
 * The reducer. Pure: the same state and event always give the same state,
 * and an event that does not apply returns the SAME object, so a caller can
 * tell "nothing happened" by identity.
 */
export function reduceLocate(state: LocateState, event: LocateEvent): LocateState {
  switch (event.type) {
    case 'start': {
      // A new press supersedes whatever was there. Attempts only ever grow.
      if (event.attempt <= state.attempt) return state;
      const base: LocateState = {
        phase: 'idle',
        attempt: event.attempt,
        permission: event.permission,
        reason: null,
        fix: null,
        pending: null,
        retriesLeft: event.retry ? 0 : 1
      };
      if (!event.supported) return fail(base, 'unavailable', 'unsupported');
      if (!event.secure) return fail(base, 'unavailable', 'insecure');
      // Already refused: the browser will not ask again, and neither do we.
      if (event.permission === 'denied') return fail(base, 'denied', null);
      return { ...base, phase: event.permission === 'granted' ? 'locating' : 'asking' };
    }
    case 'cancel':
      return isInFlight(state.phase) ? { ...state, phase: 'idle', pending: null } : state;
    case 'clear':
      return isLocated(state.phase) ? { ...state, phase: 'idle', fix: null } : state;
    case 'dismiss':
      return state.phase === 'denied' || state.phase === 'unavailable' || state.phase === 'timeout'
        ? { ...state, phase: 'idle', reason: null }
        : state;
    default:
      break;
  }

  // Everything below is an answer from the browser, the device or a clock.
  // It counts only for the current attempt, and only while that attempt is
  // still in flight: a late answer finds nothing to revive.
  if (event.attempt !== state.attempt || !isInFlight(state.phase)) return state;

  switch (event.type) {
    case 'permission':
      if (state.phase !== 'asking') return state;
      // `prompt` only sharpens the wording: the browser's sheet is known to be up.
      if (event.permission === 'prompt') {
        return state.permission === 'prompt' ? state : { ...state, permission: 'prompt' };
      }
      return event.permission === 'granted'
        ? { ...state, phase: 'locating', permission: 'granted' }
        : fail({ ...state, permission: 'denied' }, 'denied', null);
    case 'fix': {
      if (!validFix(event.fix)) return state;
      if (event.fix.accuracy <= GOOD_FIX_M) return accept(state, event.fix);
      const better = state.pending === null || event.fix.accuracy < state.pending.accuracy;
      // A fix means the browser said yes, whatever the permission reading was.
      return { ...state, phase: 'locating', pending: better ? event.fix : state.pending };
    }
    case 'settle':
      return state.pending ? accept(state, state.pending) : state;
    case 'deadline':
      return state.pending ? accept(state, state.pending) : fail(state, 'timeout', null);
    case 'error':
      // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT (Geolocation API).
      // A refusal keeps the reading taken after it: `denied` means the browser
      // now blocks this site, anything else that the question was only closed.
      if (event.code === 1) {
        return fail({ ...state, permission: event.permission ?? state.permission }, 'denied', null);
      }
      if (state.pending) return accept(state, state.pending);
      return event.code === 3 ? fail(state, 'timeout', null) : fail(state, 'unavailable', 'no-fix');
    default:
      return state;
  }
}

/** The words of one state: what happened, in one plain line, and the next step. */
export interface PhaseCopy {
  readonly title: string;
  readonly body: string;
  /** The label of the step the person can take next, or null when the state needs none. */
  readonly next: string | null;
}

const SECONDS = Math.round(LOCATE_TIMEOUT_MS / 1000);

/**
 * The plain line for every state that is not a located one (those are
 * worded from the place they resolve to, in the card). One entry per state
 * and per reason, so no two conditions share a sentence.
 */
export function phaseCopy(state: LocateState): PhaseCopy | null {
  switch (state.phase) {
    case 'asking':
      return {
        title: 'Waiting for your answer',
        body:
          state.permission === 'prompt'
            ? 'Your browser is asking whether this map may use your position. Answer there to continue.'
            : 'Your browser may be asking whether this map may use your position. Answer there to continue.',
        next: 'Cancel'
      };
    case 'locating':
      return {
        title: 'Finding your position',
        body: `This stops by itself after ${SECONDS} seconds if your device has no answer.`,
        next: 'Cancel'
      };
    case 'denied':
      // Blocked: the browser will not ask, so the way back is its settings.
      if (state.permission === 'denied') {
        return {
          title: 'Location is blocked for this map',
          body:
            'Your browser will not ask again by itself. To allow it later, open the settings for this site in your browser and allow Location. On a phone, also check that location is on for the browser. Then press Locate.',
          next: 'Close'
        };
      }
      // Not allowed this time: the question was closed or answered no, and
      // the browser may ask again. Nothing here claims a block it did not read.
      return {
        title: 'This map was not allowed to use your position',
        body:
          'Nothing was read. Press Locate when you want to be asked again. If your browser does not ask, open the settings for this site and allow Location. On a phone, also check that location is on for the browser.',
        next: 'Close'
      };
    case 'timeout':
      return state.retriesLeft > 0
        ? {
            title: `No position after ${SECONDS} seconds`,
            body: 'Your device did not answer in time. You can try once more. The second try accepts a quicker, less exact position.',
            next: 'Try again'
          }
        : {
            title: 'Still no position',
            body: 'Your device did not answer the second time either. You can find your place by name with Place.',
            next: 'Close'
          };
    case 'unavailable':
      if (state.reason === 'insecure') {
        return {
          title: 'Location needs a secure page',
          body: 'Browsers share a position only with pages opened over https. Open this map from its https address to use Locate.',
          next: 'Close'
        };
      }
      if (state.reason === 'unsupported') {
        return {
          title: 'This browser does not offer location',
          body: 'Locate needs a browser that can share a position. You can find your place by name with Place.',
          next: 'Close'
        };
      }
      return {
        title: 'Your position could not be found',
        body: 'Your device returned no position. This happens indoors, or with location switched off on the device. Try again outdoors or after switching it on.',
        next: 'Try again'
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Plain units
// ---------------------------------------------------------------------------

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

function trimDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/**
 * A distance in plain units, metric first: "20 m (65 ft)", "350 m (1,150 ft)",
 * "5 km (3.1 mi)". Rounded to what a person can use, never to more digits
 * than a device's accuracy radius deserves.
 */
export function plainDistance(metres: number): string {
  const m = Math.max(0, metres);
  if (m < 1000) {
    const shown = m < 30 ? roundTo(m, 5) : m < 100 ? roundTo(m, 10) : roundTo(m, 50);
    if (shown < 1000) {
      const feet = shown * 3.28084;
      const shownFeet = feet < 100 ? roundTo(feet, 5) : feet < 1000 ? roundTo(feet, 50) : roundTo(feet, 100);
      return `${shown} m (${shownFeet.toLocaleString('en-US')} ft)`;
    }
  }
  const km = Math.max(m, 1000) / 1000;
  const miles = (Math.max(m, 1000) / 1609.344);
  const kmText = km < 10 ? trimDecimal(km) : String(Math.round(km));
  const miText = miles < 10 ? trimDecimal(miles) : String(Math.round(miles));
  return `${kmText} km (${miText} mi)`;
}

// ---------------------------------------------------------------------------
// The grid square and the ring
// ---------------------------------------------------------------------------

/** `[west, south, east, north]`, EPSG:4326. */
export type Envelope = readonly [number, number, number, number];

/**
 * The grid square that contains a point: the point snapped DOWN to the
 * grid, plus one cell. A function of the square the point is in and of
 * nothing else about the point, which is what makes it safe to frame.
 */
export function coarseCell(lng: number, lat: number, size: number = LOCATE_CELL_DEG): [number, number, number, number] {
  const west = Math.floor(lng / size) * size;
  const south = Math.floor(lat / size) * size;
  return [west, south, west + size, south + size];
}

/** The square's ground size in whole kilometres, at its own latitude. */
export function cellSizeKm(cell: Envelope): { readonly widthKm: number; readonly heightKm: number } {
  const midLat = (cell[1] + cell[3]) / 2;
  return {
    widthKm: Math.round(((cell[2] - cell[0]) * M_PER_DEG * Math.cos((midLat * Math.PI) / 180)) / 1000),
    heightKm: Math.round(((cell[3] - cell[1]) * M_PER_DEG) / 1000)
  };
}

/**
 * A closed ring of `steps` points at `radiusM` ground metres from a centre,
 * on the sphere (the destination-point formula), so the accuracy ring is
 * drawn in true ground metres at every zoom and latitude.
 */
export function discRing(lng: number, lat: number, radiusM: number, steps = 96): Position[] {
  const delta = radiusM / EARTH_RADIUS_M;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lng * Math.PI) / 180;
  const ring: Position[] = [];
  for (let i = 0; i < steps; i += 1) {
    const theta = (i / steps) * 2 * Math.PI;
    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
    );
    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
      );
    ring.push([(lambda2 * 180) / Math.PI, (phi2 * 180) / Math.PI]);
  }
  const first = ring[0];
  if (first) ring.push([first[0] as number, first[1] as number]);
  return ring;
}

/** Whether a disc lies wholly inside an envelope (a layer's loaded coverage). */
export function discInsideEnvelope(lng: number, lat: number, radiusM: number, envelope: Envelope): boolean {
  const dLat = radiusM / M_PER_DEG;
  const dLng = radiusM / (M_PER_DEG * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return (
    lng - dLng >= envelope[0] &&
    lat - dLat >= envelope[1] &&
    lng + dLng <= envelope[2] &&
    lat + dLat <= envelope[3]
  );
}

// ---------------------------------------------------------------------------
// A disc against a boundary
// ---------------------------------------------------------------------------

function ringsOf(geometry: Geometry | null | undefined): Position[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function inRing(lng: number, lat: number, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const xi = a[0] as number;
    const yi = a[1] as number;
    const xj = b[0] as number;
    const yj = b[1] as number;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Even-odd containment for a Polygon or MultiPolygon, the same rule as
 * src/util/point-in-polygon.ts (kept here so this module stays import-free).
 * Any other geometry contains nothing.
 */
export function pointInGeometry(lng: number, lat: number, geometry: Geometry | null | undefined): boolean {
  return ringsOf(geometry).some((polygon) => {
    let inside = false;
    for (const ring of polygon) if (inRing(lng, lat, ring)) inside = !inside;
    return inside;
  });
}

/**
 * Ground metres from a point to the nearest drawn edge of a Polygon or
 * MultiPolygon (outer rings and holes alike), on a local flat projection
 * centred on the point. Infinity for a geometry with no edges.
 */
export function edgeDistanceM(lng: number, lat: number, geometry: Geometry | null | undefined): number {
  const mx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const polygon of ringsOf(geometry)) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const a = ring[i - 1];
        const b = ring[i];
        if (!a || !b) continue;
        const ax = ((a[0] as number) - lng) * mx;
        const ay = ((a[1] as number) - lat) * M_PER_DEG;
        const dx = ((b[0] as number) - lng) * mx - ax;
        const dy = ((b[1] as number) - lat) * M_PER_DEG - ay;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
        const distance = Math.hypot(ax + t * dx, ay + t * dy);
        if (distance < best) best = distance;
      }
    }
  }
  return best;
}

/**
 * `inside`: the whole disc is inside. `outside`: no part of it is.
 * `straddles`: the disc reaches the drawn edge, so neither can be claimed.
 */
export type DiscRelation = 'inside' | 'outside' | 'straddles';

export interface DiscReading {
  readonly relation: DiscRelation;
  /** Ground metres from the centre to the nearest drawn edge. */
  readonly edgeM: number;
  readonly centreInside: boolean;
}

/** Test a disc (a position and its uncertainty radius) against one boundary. */
export function classifyDisc(
  lng: number,
  lat: number,
  radiusM: number,
  geometry: Geometry | null | undefined
): DiscReading {
  const centreInside = pointInGeometry(lng, lat, geometry);
  const edgeM = edgeDistanceM(lng, lat, geometry);
  const relation: DiscRelation = edgeM <= radiusM ? 'straddles' : centreInside ? 'inside' : 'outside';
  return { relation, edgeM, centreInside };
}

// ---------------------------------------------------------------------------
// Which state
// ---------------------------------------------------------------------------

function firstString(props: GeoJsonProperties | undefined, keys: readonly string[]): string | null {
  if (!props) return null;
  const record = props as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** A state by its Census postal code and name. */
export interface StateRef {
  readonly code: string;
  readonly name: string;
}

/**
 * `in`: the whole disc is inside one state's outline. `edge`: the disc
 * reaches a drawn state line; `states` lists every state it touches, the
 * one holding the centre first. `outside`: the disc touches no outline.
 */
export type StateFinding =
  | { readonly kind: 'in'; readonly state: StateRef }
  | { readonly kind: 'edge'; readonly states: readonly StateRef[] }
  | { readonly kind: 'outside' };

/**
 * Resolve the state from the bundled outlines, in the client. The disc is
 * the device's radius widened by `marginM` (DDM's margin for the coarse
 * outline), so a position near a state line is reported as at the line.
 */
export function findStates(
  collection: FeatureCollection,
  fix: LocateFix,
  marginM: number = STATE_OUTLINE_MARGIN_M
): StateFinding {
  const radius = fix.accuracy + marginM;
  const touched: { state: StateRef; reading: DiscReading }[] = [];
  for (const feature of collection.features ?? []) {
    const code = firstString(feature.properties, ['STUSPS']);
    if (!code) continue;
    const reading = classifyDisc(fix.lng, fix.lat, radius, feature.geometry);
    if (reading.relation === 'outside') continue;
    touched.push({
      state: { code: code.toUpperCase(), name: firstString(feature.properties, ['NAME', 'name']) ?? code.toUpperCase() },
      reading
    });
  }
  if (touched.length === 0) return { kind: 'outside' };
  const only = touched[0];
  if (touched.length === 1 && only && only.reading.relation === 'inside') {
    return { kind: 'in', state: only.state };
  }
  touched.sort(
    (a, b) =>
      Number(b.reading.centreInside) - Number(a.reading.centreInside) || a.reading.edgeM - b.reading.edgeM
  );
  return { kind: 'edge', states: touched.map((entry) => entry.state) };
}

// ---------------------------------------------------------------------------
// Which Tribal land area, from boundaries already loaded
// ---------------------------------------------------------------------------

/** The three boundary sources location identity reads (src/state/location-identity.ts). */
export type TribalSource = 'tribal' | 'aiannh' | 'bia-reservation';

/**
 * AIANNHCC values the Census product identifies as legal entities. MIRROR of
 * LEGAL_AIANNH_CODES in src/state/location-identity.ts (kept there private);
 * tests/geolocate.test.mjs reads that file as text and fails when the two
 * disagree.
 */
export const LEGAL_AIANNH_CODES: readonly string[] = ['D1', 'D2', 'D3', 'D4', 'F1'];

/** The name fields each source's features carry, as location identity reads them. */
const NAME_KEYS: Readonly<Record<TribalSource, readonly string[]>> = {
  tribal: ['LARName', 'LARNAME', 'NAME', 'name', 'TRIBE', 'RESERV_NAM'],
  aiannh: ['NAME', 'BASENAME', 'name'],
  'bia-reservation': ['LARNAME', 'LARName', 'NAME', 'name']
};

/** One loaded boundary feature the position's disc touches. */
export interface TribalHit {
  readonly source: TribalSource;
  readonly feature: Feature;
  /** The source's own area name. Never presented as a Tribe's name for itself. */
  readonly name: string;
  /** A Census legal entity (AIANNHCC). Always false for the other sources. */
  readonly legal: boolean;
  readonly reading: DiscReading;
}

/** Every loaded feature the disc touches (inside or straddling), per source. */
export function findTribalHits(
  loaded: readonly { readonly source: TribalSource; readonly collection: FeatureCollection }[],
  fix: LocateFix,
  toleranceM: number
): TribalHit[] {
  const radius = fix.accuracy + toleranceM;
  const hits: TribalHit[] = [];
  for (const { source, collection } of loaded) {
    for (const feature of collection.features ?? []) {
      const name = firstString(feature.properties, NAME_KEYS[source]);
      if (!name) continue;
      const reading = classifyDisc(fix.lng, fix.lat, radius, feature.geometry);
      if (reading.relation === 'outside') continue;
      const code = firstString(feature.properties, ['AIANNHCC', 'aiannhcc']);
      hits.push({
        source,
        feature,
        name,
        legal: source === 'aiannh' && code !== null && LEGAL_AIANNH_CODES.includes(code.toUpperCase()),
        reading
      });
    }
  }
  return hits;
}

/**
 * The precedence location identity applies (D-0.8.0-052, quoted from
 * src/state/location-identity.ts): deployer data, Census AIANNH legal
 * entity, BIA land area, then Census AIANNH statistical entity.
 */
function rank(hit: TribalHit): number {
  if (hit.source === 'tribal') return 0;
  if (hit.source === 'aiannh' && hit.legal) return 1;
  if (hit.source === 'bia-reservation') return 2;
  return 3;
}

/** One boundary layer as the registry reports it. `off`: the layer is not on. */
export interface TribalLayerReading {
  readonly key: string;
  readonly status: 'ready' | 'degraded' | 'no-data' | 'error' | 'loading' | 'zoom-in' | 'off';
}

/**
 * What the client may say after testing the position against the loaded
 * boundaries. Each kind is a different sentence:
 *
 *   inside      the whole disc is inside one loaded area (the ranked winner)
 *   near        the disc reaches a loaded area's edge: neither side is claimed
 *   none        every layer that is on loaded fully, and the disc touches nothing
 *   incomplete  nothing touched, but a layer failed, was partial or was still loading;
 *               where the disc also reaches past what was loaded (`covered`
 *               false), the layers that did load prove nothing either
 *   too-wide    nothing touched, but the disc reaches past what was loaded
 *   layers-off  no Tribal boundary layer is on, so nothing was tested
 */
export type TribalVerdict =
  | { readonly kind: 'layers-off' }
  | { readonly kind: 'inside'; readonly hit: TribalHit; readonly biaLandArea: string | null }
  | { readonly kind: 'near'; readonly hits: readonly TribalHit[] }
  | { readonly kind: 'none'; readonly tested: readonly string[] }
  | {
      readonly kind: 'incomplete';
      readonly tested: readonly string[];
      readonly untested: readonly TribalLayerReading[];
      readonly covered: boolean;
    }
  | { readonly kind: 'too-wide'; readonly tested: readonly string[] };

/**
 * Decide the verdict. `covered` says whether the whole disc lies inside the
 * envelope the layers were asked for: outside it, an area that was never
 * loaded could still contain the position, so "none" cannot be said.
 */
export function tribalVerdict(
  layers: readonly TribalLayerReading[],
  hits: readonly TribalHit[],
  covered: boolean
): TribalVerdict {
  const on = layers.filter((layer) => layer.status !== 'off');
  if (on.length === 0) return { kind: 'layers-off' };

  const inside = hits.filter((hit) => hit.reading.relation === 'inside');
  if (inside.length > 0) {
    const winner = [...inside].sort((a, b) => rank(a) - rank(b) || b.reading.edgeM - a.reading.edgeM)[0] as TribalHit;
    // A legal Census area keeps the BIA land area under the same point, so a
    // consumer can title it by the Nation name the BIA area's click gives.
    const bia =
      winner.source === 'aiannh' && winner.legal
        ? hits.find((hit) => hit.source === 'bia-reservation' && hit.reading.centreInside)
        : undefined;
    return { kind: 'inside', hit: winner, biaLandArea: bia?.name ?? null };
  }

  const near = [...hits].sort((a, b) => rank(a) - rank(b) || a.reading.edgeM - b.reading.edgeM);
  if (near.length > 0) return { kind: 'near', hits: near };

  const tested = on.filter((layer) => layer.status === 'ready' || layer.status === 'no-data').map((layer) => layer.key);
  const untested = on.filter((layer) => layer.status !== 'ready' && layer.status !== 'no-data');
  if (untested.length > 0) return { kind: 'incomplete', tested, untested, covered };
  if (!covered) return { kind: 'too-wide', tested };
  return { kind: 'none', tested };
}

/**
 * How coarsely a viewport-loaded boundary was drawn, in ground metres: the
 * boundary layers ask the service to generalize to half a screen pixel at
 * the integer zoom (`resolveMaxAllowableOffset`, src/layers/aiannh.ts and
 * src/layers/bia-reservations.ts: 360 / (512 * 2^zoom) * 0.5 degrees). A
 * position closer than this to a drawn edge cannot be placed on one side.
 */
export function generalizationM(zoomBucket: number): number {
  return (360 / (512 * Math.pow(2, zoomBucket))) * 0.5 * M_PER_DEG;
}

// ---------------------------------------------------------------------------
// The words of a located position
// ---------------------------------------------------------------------------

/** How good the position is, in plain units. The first sentence of every located line. */
export function accuracyLine(fix: LocateFix): string {
  return fix.accuracy > LOW_ACCURACY_M
    ? `Approximate: good to about ${plainDistance(fix.accuracy)}.`
    : `Good to about ${plainDistance(fix.accuracy)}.`;
}

/** A state's name as a sentence takes it. */
function stateInSentence(state: StateRef): string {
  return state.code === 'DC' ? 'the District of Columbia' : state.name;
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The head of a located card: the claim, its qualification, and what it offers to open. */
export interface LocatedCopy {
  readonly title: string;
  /** The qualification of the claim the title makes. Follows `accuracyLine` in the card. */
  readonly qualifier: string;
  /** States whose briefing the card may open. Empty when no outline was touched. */
  readonly states: readonly StateRef[];
  /** True only when the whole disc is inside one state: that briefing opens without asking. */
  readonly certain: boolean;
}

/**
 * Word what the bundled outlines support, and nothing more. `null`: the
 * outlines could not be read, which is said as that and not as "nowhere".
 */
export function locatedCopy(fix: LocateFix, finding: StateFinding | null): LocatedCopy {
  if (finding === null) {
    return {
      title: 'Position found, place not named',
      qualifier: 'This map could not read its own state outlines.',
      states: [],
      certain: false
    };
  }
  if (finding.kind === 'in') {
    return {
      title: `You are in ${stateInSentence(finding.state)}`,
      qualifier: '',
      states: [finding.state],
      certain: true
    };
  }
  if (finding.kind === 'outside') {
    return {
      title: 'You are outside the states this map names',
      qualifier: 'Its outlines cover the 50 states, the District of Columbia and Puerto Rico.',
      states: [],
      certain: false
    };
  }
  const names = finding.states.map(stateInSentence);
  if (names.length === 1) {
    return {
      title: `You are at the edge of ${names[0]}`,
      qualifier: 'The state outline this map carries is too coarse to tell which side you are on.',
      states: finding.states,
      certain: false
    };
  }
  return {
    title:
      names.length === 2
        ? `You are near the ${finding.states[0]?.name} and ${finding.states[1]?.name} line`
        : `You are near where ${listOf(names)} meet`,
    qualifier:
      fix.accuracy > STATE_OUTLINE_MARGIN_M
        ? 'That reaches more than one state, so this map does not pick one.'
        : 'The state outlines this map carries are too coarse to pick a side here.',
    states: finding.states,
    certain: false
  };
}

/** Who draws each boundary source, as a sentence names them. */
const SOURCE_DRAWN_BY: Readonly<Record<TribalSource, string>> = {
  // The names src/config/acknowledgements.ts gives the two agencies.
  aiannh: 'the U.S. Census Bureau',
  'bia-reservation': 'the Bureau of Indian Affairs',
  tribal: 'the boundary data this map was given'
};

/** Who draws a boundary source. */
export function drawnBy(source: TribalSource): string {
  return SOURCE_DRAWN_BY[source];
}

/** The six layer states, in the catalog's own words, for a layer that could not be tested. */
function untestedWord(status: TribalLayerReading['status']): string {
  switch (status) {
    case 'error':
      return 'unavailable';
    case 'degraded':
      return 'live (partial)';
    case 'loading':
      return 'still loading';
    case 'zoom-in':
      return 'zoom in to load';
    default:
      return status;
  }
}

/**
 * The plain note shown BEFORE the map frames the grid square. Three
 * sentences, each read against the code it describes:
 *
 *   - What moves, and who is asked. src/layers/aiannh.ts and
 *     src/layers/bia-reservations.ts each ask their service for the map view
 *     (`buildQueryEnvelope(map.getBounds())`). `agencies` are the services of
 *     the boundary layers that are on, so none is named that is not asked.
 *   - What any source can learn from that. Everything that loads by map view
 *     (those two, the base map, imagery) is asked for a view that is a
 *     function of the square, so the sentence speaks of the map's sources
 *     and not of the two agencies alone.
 *   - What follows. A position the check places inside an area opens that
 *     area (`openTribalBriefingFor`, src/ui/locate-place.ts): the map frames
 *     it and its briefing is read, as the search does for a place found by
 *     name. From then on sources are asked about the area, which can be far
 *     smaller than the square, so the note says so before the person agrees
 *     and does not leave "the square" as the last word.
 */
export function tribalDisclosure(agencies: readonly string[], cell: Envelope): string {
  const { widthKm, heightKm } = cellSizeKm(cell);
  return (
    `To check, the map moves to a grid square that contains you (about ${widthKm} by ${heightKm} km) ` +
    `and loads Tribal boundaries there from ${listOf(agencies)}. ` +
    "Your exact position is not sent: the map's sources see that square, not where you are in it. " +
    'If the check places you inside an area, the map opens that area, and its sources see the area asked for.'
  );
}

/** What a Tribal lands check may say. `names` maps a layer key to its catalog name. */
export interface TribalCopy {
  /** Replaces the card's title when the check places the position; null keeps the state's. */
  readonly title: string | null;
  /** Follows `accuracyLine` in the card's head. */
  readonly qualifier: string;
  /** Further lines for the card's body. */
  readonly detail: readonly string[];
}

/**
 * The sentence the absence of a boundary carries on this map, verbatim from
 * the boundary popups (src/ui/popups.ts): no result here is ever an all-clear.
 */
export const NO_AREA_CAVEAT =
  'No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.';

/** Word a verdict. Every kind is a different sentence, and only `inside` names a place as the position's. */
export function tribalCopy(verdict: TribalVerdict, names: (key: string) => string): TribalCopy {
  const list = (keys: readonly string[]): string => listOf(keys.map(names));
  switch (verdict.kind) {
    case 'inside':
      return {
        title: `You are within ${verdict.hit.name}`,
        qualifier: `As ${drawnBy(verdict.hit.source)} draws it.`,
        detail: []
      };
    case 'near': {
      const first = verdict.hits[0] as TribalHit;
      return {
        title: `You are near the edge of ${first.name}`,
        qualifier: `That reaches the edge ${drawnBy(first.source)} draws, so this map does not place you inside or outside it.`,
        detail: verdict.hits.length > 1 ? [`The same holds for ${listOf(verdict.hits.slice(1).map((hit) => hit.name))}.`] : []
      };
    }
    case 'none':
      return {
        title: null,
        qualifier: `Not inside any area drawn by ${list(verdict.tested)}.`,
        detail: [NO_AREA_CAVEAT]
      };
    case 'incomplete': {
      const untested = verdict.untested.map((layer) => `${names(layer.key)} (${untestedWord(layer.status)})`);
      // Past the loaded area a layer that loaded proves nothing either (the
      // same rule that makes "too-wide"), so it is not called checked.
      if (!verdict.covered) {
        const unreached = verdict.tested.map((key) => `${names(key)} (the position reaches past the area that was loaded)`);
        return {
          title: null,
          qualifier: 'Tribal lands check incomplete.',
          detail: [`Not checked: ${listOf([...untested, ...unreached])}.`]
        };
      }
      return {
        title: null,
        qualifier: 'Tribal lands check incomplete.',
        detail: [
          `Not checked: ${listOf(untested)}.`,
          ...(verdict.tested.length > 0 ? [`Checked, and you are not inside any area it draws: ${list(verdict.tested)}.`] : [])
        ]
      };
    }
    case 'too-wide':
      return {
        title: null,
        qualifier: 'That is wider than the area that was loaded, so Tribal lands could not be checked.',
        detail: []
      };
    default:
      return {
        title: null,
        qualifier: 'Tribal lands not checked: no Tribal boundary layer is on.',
        detail: []
      };
  }
}
