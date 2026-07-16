/**
 * Bureau of Indian Affairs (BIA) reservation-boundary layer.
 *
 * Renders the American Indian and Alaska Native Land Area Representation
 * (AIAN-LAR): the authoritative federal depiction of reservation and trust
 * land extent for federally recognized Tribes. Unlike the bundled
 * `tribal-lands.geojson` placeholder (the deployer's own-data slot, empty by
 * default per CLAUDE.md hard rule 1), this layer is fetched live from the BIA
 * FeatureServer. Live consumption of an authoritative public federal source
 * commits no sovereign polygons to the repository, exactly like the United
 * States Drought Monitor and National Interagency Fire Center layers; see the
 * `ddm-tribal-boundary-mapping` skill for the stewardship reconciliation. The
 * two coexist: one is fetched-and-live, one is bundled-and-empty.
 *
 * Stewardship: the boundary is a representation for general spatial reference,
 * not a definitive depiction of Tribal jurisdiction. The mandatory caveat
 * lives in `buildBiaReservationPopupHtml` (src/ui/popups.ts).
 *
 * Source: `URLS.biaLarFeatureServer` (verified 2026-05-30; see urls.ts).
 *
 * Clipping: the national dataset is large, so the query is clipped to the
 * current map viewport (overscanned by OVERSCAN_FACTOR on each side) with an
 * Environmental Systems Research Institute (ESRI) spatial envelope rather
 * than fetching the full national FeatureCollection. The region selection
 * drives the viewport, so toggling this layer on after selecting a region
 * pulls only that region's boundaries.
 *
 * Caching: successful responses are kept in an in-memory, session-scoped
 * cache (`responseCache`) keyed by a bucketed bounds string coarser than the
 * query envelope (`buildCacheKey`), so a deactivate then re-activate against
 * substantially the same view renders instantly with no network call. A real
 * region change still misses the cache and fetches fresh.
 * The cache is never committed anywhere and adds nothing to the repository;
 * it is a browser-session optimization, not a data-bundling change (CLAUDE.md
 * hard rule 1 is unaffected; see
 * `docs/ddm-tribal-geography-tier-assessment-2026-07-15.md`).
 *
 * Viewport refresh (the Tribal Nations umbrella build; formerly finding 3 of
 * `C:\dev\_reviews\ddm\2026-07-15_tribal-boundary-live-fetch-review.md`):
 * while active, a debounced `moveend` handler refetches the current view and
 * swaps the data into the EXISTING source with `setData` (never a second
 * source), guarded by a request-identity token plus the master abort signal
 * so a stale response never renders over a newer one. The handler is removed
 * on `deactivate`. `aiannh.ts` carries the same lifecycle so the two live
 * Tribal-geography layers behave as peers under the umbrella.
 *
 * Response validation: `assertFeatureCollection` rejects an ArcGIS
 * error-shaped body or a non-FeatureCollection payload before it can be
 * rendered, so a malformed or service-error response reports `'error'`
 * through the existing catch block rather than rendering garbage or
 * throwing past it. A response flagged `exceededTransferLimit` by the
 * service is logged, not silently treated as complete.
 *
 * Cancellation (CLAUDE.md section 6 invariant 5): the fetch goes through
 * `fetchWithBudget` with a per-call timeout and a master abort signal that
 * fires on `deactivate` or on a superseding `activate`. A late response to a
 * superseded or torn-down activation is dropped, not rendered. A cache hit
 * renders synchronously and never touches the abort signal.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  RESERVATION_FILL_COLOR,
  RESERVATION_OUTLINE_COLOR
} from '../config/palette';
import { buildBiaReservationPopupHtml } from '../ui/popups';
import { attachImpactTrigger } from '../ui/impact-panel';
import { buildBoundaryContext } from '../impact/context';
import { hydrateRelatedCessions } from '../impact/related-cessions';
import { emphasizePlace } from '../state/place-emphasis';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'bia-reservations';
const SOURCE_ID = 'bia-reservations';
const FILL_LAYER_ID = 'bia-reservations-fill';
const OUTLINE_LAYER_ID = 'bia-reservations-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor so the boundary stacks below
 * the basemap label glyphs, matching every other reference-polygon module. If
 * the active style does not declare `first-symbol`, MapLibre appends at the top
 * of the layer list, which is an acceptable fallback.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the AIAN-LAR query. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Overscan margin applied to the query envelope, as a fraction of the
 * viewport's width and height on each side. Fetching a bit beyond the
 * visible viewport lets small pans render correctly at their edges instead
 * of clipping at the exact prior bounds, and increases the odds a minor pan
 * still hits the response cache below.
 */
const OVERSCAN_FACTOR = 0.25;

/**
 * Cache-key bounds precision, in decimal degrees, coarser than the five
 * decimal places used for the actual query envelope (roughly 11 km at PNW
 * latitudes). Chosen so ordinary pans and re-toggles of the same region
 * reuse a cached response while a real region change still misses it.
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
 * E1 composition targets (D-0.7.0-041 part 2, review E1.3; D-0.7.0-043
 * part 4): starting values for the stewardship visual review at unit
 * close. The reservation fill calms from 0.26 to 0.18 with a 1.1 px
 * outline, still the STRONGER of the two present-day Tribal-geography
 * layers (the AIANNH wash in aiannh.ts sits at 0.12 with a 0.9 px
 * outline). With both layers now in the one magenta family
 * (src/config/palette.ts), outline weight and fill strength are the honest
 * non-color channel that keeps the two representations distinguishable.
 * The selected boosts stay.
 */
const FILL_OPACITY_BASE = 0.18;
const FILL_OPACITY_SELECTED = 0.5;
const OUTLINE_WIDTH_BASE = 1.1;
const OUTLINE_WIDTH_SELECTED = 2.6;

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
 * Session-scoped response cache, keyed by `buildCacheKey`. Module-level so
 * it outlives individual activate/deactivate cycles; cleared only on page
 * reload. Never written to disk or the repository; see the Caching
 * paragraph in the module docblock above.
 */
const responseCache = new Map<string, CachedResponse>();

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Bucketed cache key for the current viewport (see CACHE_KEY_PRECISION). No
 * zoom component: this query has no zoom-keyed generalization parameter, so
 * one response serves every zoom of the same bounds. The key is a fast-path
 * bucket only; a hit must ALSO pass the `envelopeCovers` coverage check.
 */
function buildCacheKey(map: maplibregl.Map): string {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    .map((n) => n.toFixed(CACHE_KEY_PRECISION))
    .join(',');
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
 * Build the GeoJSON query URL, clipped to the given overscanned envelope.
 * The envelope is `xmin,ymin,xmax,ymax` in the `inSR` (WGS 84 longitude /
 * latitude). `outFields` is limited to the five fields the popup and the
 * impact briefing read, to keep the payload small.
 */
function buildQueryUrl(envelope: readonly [number, number, number, number]): string {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: envelope.map((n) => n.toFixed(5)).join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'LARID,LARNAME,CLASSIFICATION,GISACRES,REGION',
    returnGeometry: 'true',
    f: 'geojson'
  });
  return `${URLS.biaLarFeatureServer}/query?${params.toString()}`;
}

/**
 * Validate that a parsed response is a genuine GeoJSON FeatureCollection and
 * not an ArcGIS error body or other malformed shape. Throws on failure so the
 * caller's existing catch block reports `'error'`, matching every other
 * failure path in this module. A response the service flags as truncated
 * (`exceededTransferLimit`) is logged, not silently treated as complete;
 * full pagination is a larger change than this validation pass covers.
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
    throw new Error('AIAN-LAR response was not a GeoJSON FeatureCollection.');
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
 * Fetch the AIAN-LAR for the current viewport and apply it: into the existing
 * source via `setData` when refreshing, or as a fresh source plus layers on
 * first render. Shared by `activate` and the `moveend` refresh. A cache hit
 * applies synchronously with no network call (see the Caching paragraph in
 * the module docblock). Network failures surface as `'error'` rather than
 * throwing, matching the other layer modules.
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

  const cacheKey = buildCacheKey(map);
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
    // transport level: the upstream sends max-age=0 + public + ETag
    // (storable, revalidate-on-use), so without this the browser HTTP
    // cache may persist sovereign-boundary responses across page loads
    // (harness/phases/0.7.0/EVIDENCE_HEADERS_2026-07-15.md).
    const resp = await fetchWithBudget(
      buildQueryUrl(envelope),
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
    console.warn('[bia-reservations] AIAN-LAR fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a superseded or torn-down request must not render.
  if (signal.aborted || token !== requestSeq) return;

  if (truncated) {
    console.warn(
      '[bia-reservations] response truncated by the service (exceededTransferLimit); rendering a partial result for this view and reporting live (partial).'
    );
    applyFeatureCollection(map, geojson, { partial: true });
    return;
  }
  cacheResponse(cacheKey, envelope, geojson);
  applyFeatureCollection(map, geojson);
}

/**
 * Apply a validated FeatureCollection, from cache or a fresh fetch: `setData`
 * into the existing source (the refresh path) or create the source and layers
 * (first render). A zero-feature response reports the honest live-zero state:
 * a valid, non-error response with no intersecting features reflects what
 * BIA AIAN-LAR returns for this query, not a verified absence of Tribal
 * presence (AIAN-LAR does not cover most Oklahoma Tribal Statistical Areas or
 * landless Tribes; confirmed 2026-07-15, see
 * docs/ddm-tribal-geography-tier-assessment-2026-07-15.md).
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
  reportStatus(lastAppliedStatus);
}

/**
 * Add the source and both style layers. The layers are added even for an
 * empty collection: the viewport refresh swaps data into the existing source
 * with `setData`, so a view that starts empty (Oklahoma, where AIAN-LAR
 * returns zero features) must still have layers ready for the features a
 * later pan brings in.
 */
function addSourceAndLayers(map: maplibregl.Map, geojson: FeatureCollection): void {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'BIA AIAN-LAR',
    // LARID is the stable federal land-area id, so the U3 search can emphasize
    // a land area it located by LARNAME without a click (U3h). promoteId lifts
    // it to the feature id feature-state and the click handler both key on.
    promoteId: 'LARID'
  });

  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        // The visible reservation surface of record (D-0.7.0-019, calmed by
        // E1): the stronger fill of the magenta pair, still light enough
        // that the basemap and the drought surface stay legible underneath.
        // The selected land area (U3h) lifts higher so it stays legible
        // under an open briefing. See the E1 constants above.
        'fill-color': RESERVATION_FILL_COLOR,
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
        'line-color': RESERVATION_OUTLINE_COLOR,
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
          0.9
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
 * Fetch the AIAN-LAR for the current viewport, add the source and layers, and
 * start the while-active viewport refresh. Idempotent: if the source already
 * exists the call only (re)ensures the refresh handler, so the URL-restore
 * path cannot stack duplicates.
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
 * outline, and source. Layers are removed before the source (removing a
 * source with attached layers raises a MapLibre error). Safe to call when
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
 * Wire the click-to-popup handler and the hover cursor affordance on the fill
 * layer. Bound once at boot (per the boot-time `bindPopups` loop), independent
 * of activation; MapLibre tolerates a handler bound to a not-yet-existing layer
 * ID and the handler short-circuits cleanly when no feature is hit.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    emphasizePlace(map, SOURCE_ID, feature.id);
    const props: GeoJsonProperties = feature.properties ?? null;
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildBiaReservationPopupHtml(props))
      .addTo(map);
    attachImpactTrigger(
      popup,
      buildBoundaryContext('bia-reservation', props, feature.geometry, e.lngLat)
    );
    // Unit I (D-0.7.0-038): surface this Tribe's related Royce cessions,
    // with the honest no-match state, in the popup's cession slot.
    hydrateRelatedCessions(map, popup, 'bia-reservation', props, feature.geometry);
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
