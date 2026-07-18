/**
 * US Census Bureau American Indian, Alaska Native, and Native Hawaiian Areas
 * (AIANNH) layer: the BROAD live Tribal Lands layer (D-0.7.0-032/033).
 *
 * Renders the Census TIGERweb AIANNH comprehensive layer (layer 47), which
 * carries federal reservations and off-reservation trust land PLUS the
 * statistical geographies the BIA AIAN-LAR does not: Oklahoma Tribal
 * Statistical Areas (OTSA), Alaska Native Village Statistical Areas (ANVSA),
 * Hawaiian Home Lands, state reservations, and joint-use areas. This closes
 * the Oklahoma gap where AIAN-LAR returns zero features.
 *
 * Stewardship (CLAUDE.md section 2; the Unit A source-aware boundary model):
 * AIANNH spans legal and statistical geographies. The per-feature legal vs
 * statistical distinction is drawn by `AIANNHCC` in `buildAiannhPopupHtml`
 * (src/ui/popups.ts); a statistical area is never labeled as jurisdiction or
 * land ownership, and the `aiannh` identity source ranks LOWEST in
 * location-identity precedence (src/state/location-identity.ts). This layer
 * deliberately double-draws with the BIA reservation layer on federal
 * reservations: two agencies' representations, separately labeled, never
 * blended into one dataset.
 *
 * NON-REDISTRIBUTION GUARD (CLAUDE.md hard rule 1; the plan-attack standing
 * guard): every AIANNH response is transient. It lives in the in-memory
 * session cache below and the MapLibre source, and nowhere else: never
 * committed, never emitted by the default build, never written to disk, and
 * never copied into a test fixture. Live-fetch of a public federal product is
 * not redistribution; see docs/ddm-tribal-geography-tier-assessment-2026-07-15.md.
 *
 * Source: `URLS.censusAiannhMapServer` layer 47 (verified 2026-07-15; see
 * urls.ts for the full provenance receipt). CORS is reflected-origin; no
 * proxy. The query is viewport-clipped with an Environmental Systems Research
 * Institute (ESRI) envelope, overscanned by OVERSCAN_FACTOR, with
 * `maxAllowableOffset` and `geometryPrecision` keyed to the current zoom so
 * the multi-megabyte full-precision geometries (an Oklahoma OTSA is 4.18 MB
 * raw) arrive generalized for display. The tolerance is deliberately
 * conservative (a fraction of one screen pixel) so small and detached parcels
 * survive; the browser verification pass (Unit H) confirms this visually.
 *
 * Viewport refresh (the lifecycle the pre-umbrella BIA layer lacked): while
 * active, a debounced `moveend` handler refetches the current view and swaps
 * the data into the EXISTING source with `setData` (never a second source).
 * A request-identity token plus the master abort signal guarantee a stale
 * response never renders over a newer one. The handler is removed on
 * `deactivate`. `bia-reservations.ts` carries the same lifecycle so the two
 * behave as peers under the Tribal Nations umbrella.
 *
 * Cancellation (CLAUDE.md section 6 invariant 5): every fetch goes through
 * `fetchWithBudget` with a per-call timeout and a master abort signal that
 * fires on `deactivate` or on a superseding fetch. Late responses to
 * superseded requests are dropped, not rendered. A cache hit renders
 * synchronously and never touches the abort signal.
 *
 * Response validation: `assertFeatureCollection` rejects ArcGIS error-shaped
 * bodies and non-FeatureCollection payloads; `exceededTransferLimit` is
 * logged, not silently treated as complete.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { AIANNH_FILL_COLOR, AIANNH_OUTLINE_COLOR } from '../config/palette';
import { buildAiannhPopupHtml } from '../ui/popups';
import { buildBoundaryContext, resolveBoundaryTitle } from '../impact/context';
import { registerClickTarget } from '../map/interaction-coordinator';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'aiannh';
const SOURCE_ID = 'aiannh';
/**
 * MUST stay `aiannh-fill`: src/state/location-identity.ts already reads this
 * id (AIANNH_FILL) for the lowest-precedence containment probe (Unit A).
 */
const FILL_LAYER_ID = 'aiannh-fill';
const OUTLINE_LAYER_ID = 'aiannh-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/** Symbol anchor so the boundary stacks below basemap labels (shared idiom). */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the AIANNH query. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Overscan margin applied to the query envelope, as a fraction of the
 * viewport's width and height on each side, so small pans render correctly at
 * their edges and are more likely to hit the response cache.
 */
const OVERSCAN_FACTOR = 0.25;

/**
 * Cache-key bounds precision in decimal degrees (see bia-reservations.ts for
 * the rationale): ordinary pans and re-toggles of the same region reuse a
 * cached response; a real region change misses.
 */
const CACHE_KEY_PRECISION = 1;

/** Distinct views kept in the response cache before the oldest is evicted. */
const CACHE_MAX_ENTRIES = 24;

/**
 * Debounce for the while-active viewport refresh: `moveend` bursts (inertia
 * pans, programmatic fit chains) collapse into one refetch.
 */
const REFRESH_DEBOUNCE_MS = 400;

/**
 * Geometry generalization tolerance, in screen pixels, converted to degrees
 * for `maxAllowableOffset` at the current zoom. Half a pixel is conservative
 * on purpose (the catalog caveat: verify small and detached parcels survive);
 * it still cuts the multi-megabyte OTSA geometries by roughly two orders of
 * magnitude versus full precision.
 */
const OFFSET_PIXEL_TOLERANCE = 0.5;

/**
 * Decimal places requested for coordinates (`geometryPrecision`). Five places
 * is roughly one meter, far below anything visible at any zoom this layer
 * serves, and materially shrinks the JSON payload.
 */
const GEOMETRY_PRECISION = 5;

/**
 * E1 composition targets (D-0.7.0-041 part 2, review E1.3; D-0.7.0-043
 * part 4): starting values for the stewardship visual review at unit
 * close. The Tribal Lands wash lightens to 0.12 with a 0.9 px outline; the
 * Reservation Boundaries pair (bia-reservations.ts) carries the STRONGER
 * fill (0.18) and the heavier outline (1.1 px). With both layers now in
 * the one Tribal family (src/config/palette.ts; pinned to #8d006b by E2,
 * D-0.7.0-058 ruling 3), outline weight and fill strength are the honest
 * non-color channel that keeps the two representations distinguishable.
 * The selected boosts stay.
 */
const FILL_OPACITY_BASE = 0.12;
const FILL_OPACITY_SELECTED = 0.4;
const OUTLINE_WIDTH_BASE = 0.9;
const OUTLINE_WIDTH_SELECTED = 2.4;

type Status = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each new fetch so a superseded request can
 * never render into a torn-down or newer view.
 */
let masterController: AbortController | null = null;

/**
 * Request-identity token: each fetch takes `++requestSeq` and drops its
 * response if the module has moved on. Belt to the abort signal's braces; a
 * response that raced past the abort still cannot render stale data.
 */
let requestSeq = 0;

/** The attached `moveend` refresh handler while the layer is active. */
let moveendHandler: (() => void) | null = null;

/** Pending debounce timer for the viewport refresh. */
let refreshTimer: number | null = null;

/**
 * The status last reported for actually-rendered data (`ready` or
 * `no-data`), or null when nothing is rendered (never activated, or torn
 * down). Lets `cancelActivation` restore the honest status of what is still
 * on the map when an in-flight REFRESH is cancelled: without it, a rapid
 * off/on during a refresh could strand the pill at `loading` while valid
 * data stays rendered (Codex Unit B re-verify finding 1, second case).
 */
let lastAppliedStatus: Extract<Status, 'ready' | 'no-data' | 'degraded'> | null = null;

/**
 * One cached response: the validated collection plus the COVERAGE envelope
 * (the queried envelope shrunk inward one grid quantum; see
 * `toCoverageEnvelope`). The envelope makes a cache hit conditional on
 * genuine coverage: two nearby viewports can share a bucketed key while one
 * extends past the other's queried envelope, and serving the stale
 * collection there would silently omit features at the newly exposed edge
 * (Codex Unit B finding 3, 2026-07-15).
 */
interface CachedResponse {
  readonly envelope: readonly [number, number, number, number];
  readonly geojson: FeatureCollection;
}

/**
 * Session-scoped response cache keyed by `buildCacheKey`. In browser memory
 * only, cleared on page reload; never written to disk or the repository
 * (hard rule 1 guard in the module docblock).
 */
const responseCache = new Map<string, CachedResponse>();

/**
 * The BIA reservation fill layer id (src/layers/bia-reservations.ts). When
 * present it is this layer's preferred insertion anchor, so the documented
 * double-draw hierarchy (the lighter AIANNH wash BELOW the stronger
 * reservation pair) holds
 * regardless of toggle order: without it, toggling AIANNH off and on while
 * BIA is active would reinsert AIANNH on top (Codex Unit B finding 4,
 * 2026-07-15). The literal is mirrored, not imported, to keep the layer
 * chunks independent (the same pattern location-identity.ts uses).
 */
const BIA_FILL_LAYER_ID = 'bia-reservations-fill';

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  if (map.getLayer(BIA_FILL_LAYER_ID)) return BIA_FILL_LAYER_ID;
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Integer zoom bucket used for BOTH the cache key and the generalization
 * tolerance, so one cache entry can never mix generalization levels (Codex
 * Unit B finding 3: a key on floored zoom with an offset on raw zoom let the
 * same key span nearly a twofold tolerance range).
 */
function resolveZoomBucket(map: maplibregl.Map): number {
  return Math.floor(map.getZoom());
}

/**
 * Bucketed cache key for the current viewport. Includes the zoom bucket
 * because the query's generalization tolerance is zoom-keyed: a response
 * generalized for zoom 4 must not satisfy a zoom 9 view of the same bounds.
 * The key is a fast-path bucket only; a hit must ALSO pass the
 * `envelopeCovers` coverage check before it is served.
 */
function buildCacheKey(map: maplibregl.Map, zoomBucket: number): string {
  const b = map.getBounds();
  const bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    .map((n) => n.toFixed(CACHE_KEY_PRECISION))
    .join(',');
  return `z${zoomBucket}:${bounds}`;
}

/**
 * Inverse of the five-decimal precision the query URL serializes envelope
 * coordinates at. The envelope is quantized OUTWARD to this grid (floor the
 * west/south edges, ceil the east/north edges) so the cached envelope and
 * the envelope actually sent to the service are the same numbers: a
 * coverage hit then proves the service was really asked for the whole
 * visible view, with no sliver between the raw and serialized edges (Codex
 * Unit B re-verify, finding 3 residual, 2026-07-15).
 */
const ENVELOPE_QUANTUM = 1e5;

/** The overscanned query envelope for the current viewport, `[w, s, e, n]`. */
function buildQueryEnvelope(map: maplibregl.Map): [number, number, number, number] {
  const b = map.getBounds();
  const west = b.getWest();
  const south = b.getSouth();
  const east = b.getEast();
  const north = b.getNorth();
  const marginX = (east - west) * OVERSCAN_FACTOR;
  const marginY = (north - south) * OVERSCAN_FACTOR;
  return [
    Math.floor((west - marginX) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM,
    Math.floor((south - marginY) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM,
    Math.ceil((east + marginX) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM,
    Math.ceil((north + marginY) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM
  ];
}

/** Whether a cached query envelope fully contains the current visible view. */
function envelopeCovers(
  envelope: readonly [number, number, number, number],
  map: maplibregl.Map
): boolean {
  const b = map.getBounds();
  return (
    envelope[0] <= b.getWest() &&
    envelope[1] <= b.getSouth() &&
    envelope[2] >= b.getEast() &&
    envelope[3] >= b.getNorth()
  );
}

/**
 * Shrink a query envelope inward by one grid quantum to form the COVERAGE
 * envelope stored with the cached response. The binary64 value `k / 1e5` can
 * sit a sub-ULP outside the exact decimal the URL carried, so comparing
 * against the query envelope itself left an equality-edge false-positive
 * path (Codex Unit B second re-verify, LOW, 2026-07-15). One quantum
 * (about one meter) of lost cache reuse is an acceptable false negative; a
 * passing coverage check now can never claim area outside the service
 * request.
 */
function toCoverageEnvelope(
  envelope: readonly [number, number, number, number]
): [number, number, number, number] {
  const q = 1 / ENVELOPE_QUANTUM;
  return [envelope[0] + q, envelope[1] + q, envelope[2] - q, envelope[3] - q];
}

/** Store a response in the cache, evicting the oldest entry if at capacity. */
function cacheResponse(
  key: string,
  envelope: readonly [number, number, number, number],
  geojson: FeatureCollection
): void {
  if (responseCache.size >= CACHE_MAX_ENTRIES && !responseCache.has(key)) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
  responseCache.set(key, { envelope: toCoverageEnvelope(envelope), geojson });
}

/**
 * Degrees of longitude per CSS pixel at the given zoom bucket (512-pixel
 * world tiles), scaled by OFFSET_PIXEL_TOLERANCE, for `maxAllowableOffset`.
 */
function resolveMaxAllowableOffset(zoomBucket: number): number {
  const degreesPerPixel = 360 / (512 * Math.pow(2, zoomBucket));
  return degreesPerPixel * OFFSET_PIXEL_TOLERANCE;
}

/**
 * Build the GeoJSON query URL against the comprehensive AIANNH layer (47),
 * clipped to the given overscanned envelope. `outFields` is limited to what
 * the popup, identity, and briefing read. Geometry is generalized
 * server-side by the zoom-bucket-keyed `maxAllowableOffset` plus a fixed
 * `geometryPrecision`; note AREALAND/AREAWATER arrive STRING-typed (catalog
 * caveat), so any consumer doing area math must parse first.
 */
function buildQueryUrl(
  envelope: readonly [number, number, number, number],
  zoomBucket: number
): string {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: envelope.map((n) => n.toFixed(5)).join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'NAME,AIANNHCC,MTFCC,BASENAME,AIANNHNS,AREALAND,AREAWATER',
    returnGeometry: 'true',
    geometryPrecision: String(GEOMETRY_PRECISION),
    maxAllowableOffset: resolveMaxAllowableOffset(zoomBucket).toFixed(6),
    f: 'geojson'
  });
  return `${URLS.censusAiannhMapServer}/47/query?${params.toString()}`;
}

/**
 * Validate that a parsed response is a genuine GeoJSON FeatureCollection and
 * not an ArcGIS error body or other malformed shape. Throws on failure so the
 * caller's catch block reports `'error'`. A response the service flags as
 * truncated (`exceededTransferLimit`) is logged, not silently complete.
 */
function assertFeatureCollection(raw: unknown): FeatureCollection {
  if (raw && typeof raw === 'object' && 'error' in raw) {
    const err = (raw as { error?: { code?: number; message?: string } }).error;
    throw new Error(
      `ArcGIS error ${err?.code ?? '(unknown code)'}: ${err?.message ?? 'unknown error'}`
    );
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { type?: string }).type !== 'FeatureCollection' ||
    !Array.isArray((raw as { features?: unknown }).features)
  ) {
    throw new Error('AIANNH response was not a GeoJSON FeatureCollection.');
  }
  return raw as FeatureCollection;
}

/**
 * Whether the service flagged this response as truncated
 * (`exceededTransferLimit`). A truncated body renders (partial data beats
 * none) but reports `degraded` ("live (partial)") and is NEVER admitted to
 * the coverage-envelope cache: a cached envelope asserts "the service
 * answered this whole envelope", which a truncated response cannot claim
 * (R2-trio, the 2026-07-15 planning true-up, D-0.7.0-037).
 */
function isTruncated(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      (raw as { exceededTransferLimit?: boolean }).exceededTransferLimit
  );
}

/**
 * Fetch the AIANNH features for the current viewport and apply them: into the
 * existing source via `setData` when refreshing, or as a fresh source plus
 * layers on first render. Shared by `activate` and the `moveend` refresh. A
 * cache hit applies synchronously with no network call. Failures surface as
 * `'error'`, never thrown.
 */
async function fetchAndApply(map: maplibregl.Map): Promise<void> {
  // Supersede any prior in-flight fetch FIRST, before the cache lookup, so a
  // cache hit also owns the newest request identity: an older network
  // response must never land over a newer cached view (Codex Unit B
  // finding 2, 2026-07-15).
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  const token = ++requestSeq;

  const zoomBucket = resolveZoomBucket(map);
  const cacheKey = buildCacheKey(map, zoomBucket);
  const cached = responseCache.get(cacheKey);
  if (cached && envelopeCovers(cached.envelope, map)) {
    applyFeatureCollection(map, cached.geojson);
    return;
  }

  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  const envelope = buildQueryEnvelope(map);
  let geojson: FeatureCollection;
  let truncated = false;
  try {
    // cache: 'no-store' enforces hard rule 1's session-only scope at the
    // transport level: the upstream sends max-age=0 + ETag (storable,
    // revalidate-on-use), so without this the browser HTTP cache may
    // persist sovereign-boundary responses across page loads
    // (harness/phases/0.7.0/EVIDENCE_HEADERS_2026-07-15.md).
    const resp = await fetchWithBudget(
      buildQueryUrl(envelope, zoomBucket),
      { cache: 'no-store' },
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const raw: unknown = await resp.json();
    geojson = assertFeatureCollection(raw);
    truncated = isTruncated(raw);
  } catch (err) {
    // Aborted or superseded means a newer request owns the view; drop
    // silently per invariant 5.
    if (signal.aborted || token !== requestSeq) return;
    console.warn('[aiannh] Census AIANNH fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a superseded or torn-down request must not render.
  if (signal.aborted || token !== requestSeq) return;

  if (truncated) {
    console.warn(
      '[aiannh] AIANNH response was truncated by the service (exceededTransferLimit); rendering a partial result for this view and reporting live (partial).'
    );
    applyFeatureCollection(map, geojson, { partial: true });
    return;
  }
  cacheResponse(cacheKey, envelope, geojson);
  applyFeatureCollection(map, geojson);
}

/**
 * Apply a validated FeatureCollection to the map: `setData` into the existing
 * source (the refresh path) or create the source and layers (first render).
 * Reports the honest live-zero state when the service returned no features
 * for this view; that is "no features returned", never "empty placeholder"
 * (this layer is never a placeholder; the wording is resolved in Unit C).
 * A `partial: true` application (a truncated response) reports `degraded`
 * ("live (partial)"), never an unqualified `ready`.
 */
function applyFeatureCollection(
  map: maplibregl.Map,
  geojson: FeatureCollection,
  opts?: { partial?: boolean }
): void {
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(geojson);
  } else {
    addSourceAndLayers(map, geojson);
  }
  lastAppliedStatus = opts?.partial
    ? 'degraded'
    : (geojson.features ?? []).length === 0
      ? 'no-data'
      : 'ready';
  if (lastAppliedStatus) reportStatus(lastAppliedStatus);
}

/**
 * Add the source and both style layers. Unlike the pre-umbrella BIA module,
 * the layers are added even for an empty collection: the viewport refresh
 * swaps data into the existing source with `setData`, so a view that starts
 * empty (an ocean view, say) must still have layers ready for the features a
 * later pan brings in.
 */
function addSourceAndLayers(map: maplibregl.Map, geojson: FeatureCollection): void {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'US Census AIANNH',
    // AIANNHNS is the stable Census (GNIS-derived) area identifier; promoting
    // it to the feature id keeps feature-state emphasis attached to the same
    // area across the viewport refresh's setData swaps. Persistence across a
    // toggle-off (which removes the source and its feature state) or a page
    // reload is the selection seam's job, not this module's; the emphasis is
    // reapplied by the next click or search, matching the BIA peer.
    promoteId: 'AIANNHNS'
  });

  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        // A light wash, deliberately below the BIA reservation fill (0.18)
        // in the family hierarchy so the double-draw stays legible: the
        // lighter AIANNH wash underneath, the stronger reservation pair on
        // top (see palette.ts and the E1 constants above).
        'fill-color': AIANNH_FILL_COLOR,
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          FILL_OPACITY_SELECTED,
          FILL_OPACITY_BASE
        ]
      }
    },
    beforeId
  );

  map.addLayer(
    {
      id: OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': AIANNH_OUTLINE_COLOR,
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          OUTLINE_WIDTH_SELECTED,
          OUTLINE_WIDTH_BASE
        ],
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          1,
          0.85
        ]
      }
    },
    beforeId
  );
}

/**
 * Attach the debounced while-active viewport refresh. Guarded so repeated
 * `activate` calls never stack handlers. The handler only schedules; the
 * debounced call re-reads the live map state, and the request-identity token
 * inside `fetchAndApply` keeps bursts coherent.
 */
function attachRefresh(map: maplibregl.Map): void {
  if (moveendHandler) return;
  moveendHandler = () => {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void fetchAndApply(map);
    }, REFRESH_DEBOUNCE_MS);
  };
  map.on('moveend', moveendHandler);
}

/** Remove the refresh handler and cancel any pending debounced refetch. */
function detachRefresh(map: maplibregl.Map): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (moveendHandler) {
    map.off('moveend', moveendHandler);
    moveendHandler = null;
  }
}

/**
 * Fetch the AIANNH areas for the current viewport, add the source and layers,
 * and start the while-active viewport refresh. Idempotent: if the source
 * already exists the call only (re)ensures the refresh handler, so the
 * URL-restore path cannot stack duplicates.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  attachRefresh(map);
  if (map.getSource(SOURCE_ID)) {
    return;
  }
  await fetchAndApply(map);
}

/**
 * Synchronous cancellation seam (the optional LayerModule hook): invoked by
 * the layer controller the moment off intent is recorded, BEFORE the
 * serialized teardown op reaches this module, so an in-flight activation or
 * refresh fetch aborts immediately instead of running out its full network
 * budget behind the op queue (invariant 5; Codex Unit B finding 1,
 * 2026-07-15). Touches no map state; `deactivate` still owns the serialized
 * source and layer removal.
 */
export function cancelActivation(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  // Invalidate any response that already raced past its abort check.
  requestSeq++;
  // If rendered data survives this cancellation (a refresh was cancelled,
  // not an initial activation), restore its honest status so the pill is
  // never stranded at 'loading' when the teardown is later skipped by a
  // rapid re-activation.
  if (lastAppliedStatus !== null) reportStatus(lastAppliedStatus);
}

/**
 * Stop the viewport refresh, abort any in-flight fetch, and remove the fill,
 * outline, and source (layers before source, per MapLibre). Safe to call when
 * never activated.
 */
export function deactivate(map: maplibregl.Map): void {
  detachRefresh(map);
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  // Invalidate any response that already raced past its abort check.
  requestSeq++;
  lastAppliedStatus = null;
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Register the fill layer's click target with the InteractionCoordinator
 * (one response per click; D-0.7.0-058 ruling 5) and wire the hover
 * cursor affordance. Bound once on first activation.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'tribal-lands',
    layerIds: [FILL_LAYER_ID],
    label: (feature) => resolveBoundaryTitle('aiannh', feature.properties ?? null),
    respond: (feature, click) => {
      const props: GeoJsonProperties = feature.properties ?? null;
      return {
        content: buildAiannhPopupHtml(props),
        selection: buildBoundaryContext('aiannh', props, feature.geometry, click.lngLat),
        // An id-less feature clears any prior emphasis (the old
        // emphasizePlace contract) rather than lighting an unknown one.
        emphasis: feature.id === undefined || feature.id === null
          ? []
          : [{ source: SOURCE_ID, id: feature.id }]
      };
    }
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
