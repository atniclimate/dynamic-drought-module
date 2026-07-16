/**
 * USFS Royce Tribal land cessions layer: the LIVE Treaty / Ceded Territories
 * source (D-0.7.0-034, resolving the D-0.7.0-032 Treaty gap).
 *
 * Renders the digitized Royce (1896-1897) cession polygons from the US Forest
 * Service Enterprise Data Warehouse, the standard national ceded-territories
 * dataset. The bundled empty `treaty-areas.geojson` placeholder (the `treaty`
 * layer key) remains the deployer's own-data slot; the two coexist exactly
 * like the `aiannh` / `tribal` pair.
 *
 * Stewardship (CLAUDE.md section 2; the T0 catalog harmonization rules):
 * Royce lines were drawn at roughly 1:2,000,000 on 19th-century paper. Every
 * surfacing carries the "generalized legal references, not surveyed
 * boundaries" disclaimer (`buildTreatyCessionPopupHtml`), overlapping
 * cessions are kept SEPARATE (never dissolved or unioned; confirmed live that
 * cessions genuinely overlap), and the present-day Tribe name is shown
 * verbatim from the federal source, never remapped to a guessed name
 * (D-0.7.0-026 safety doctrine). Rendered as #740058 fills with high,
 * per-feature VARYING transparency since E2 (D-0.7.0-058 ruling 4): the
 * dashed hollow outline retired, and overlapping cessions now read as depth
 * through their stacked translucent fills. The layer also left the visible
 * catalog (uiHidden in src/config/layers.ts) while staying reachable via
 * layers= URLs and the Unit I related-cessions click path.
 *
 * NON-REDISTRIBUTION GUARD (CLAUDE.md hard rule 1): every response is
 * transient (in-memory session cache and the MapLibre source only); never
 * committed, never emitted by the default build, never written to disk,
 * never copied into a test fixture.
 *
 * Source: `URLS.usfsRoyceCessions` (verified 2026-07-15; full receipt in
 * urls.ts). LOAD-BEARING: the service is an ESRI JOIN, so GeoJSON property
 * keys arrive fully table-qualified
 * (`edw.s_usa.BdyPol_TribalCededLandsTable.presdaytrb`); reads go through
 * `readTableQualifiedField`, and `outFields=*` is used because a guessed
 * bare field name returns HTTP 200 with zero features, silently.
 *
 * Lifecycle: a peer of `aiannh.ts` and `bia-reservations.ts` under the
 * Tribal Nations umbrella; the same viewport-clipped envelope query,
 * zoom-bucketed generalization, session cache with coverage-checked
 * envelopes, master abort + per-call timeout + late-drop, request-identity
 * token, debounced `moveend` refresh, and `cancelActivation` seam. See
 * aiannh.ts for the full rationale of each guard (Codex Unit B loop,
 * C:\dev\_reviews\ddm\2026-07-15_unit-B-codex*.md).
 */

import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

import { URLS } from '../config/urls';
import { TREATY_CESSION_FILL_COLOR } from '../config/palette';
import { CESSNUM_PROPERTY, matchCessionFeatures } from '../impact/cession-match';
import type { CessionMatchQuery } from '../impact/cession-match';
import { buildTreatyCessionPopupHtml, readTableQualifiedField } from '../ui/popups';
import { attachImpactTrigger } from '../ui/impact-panel';
import { buildBoundaryContext } from '../impact/context';
import { emphasizePlace } from '../state/place-emphasis';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'treaty-cessions';
const SOURCE_ID = 'treaty-cessions';
const FILL_LAYER_ID = 'treaty-cessions-fill';
const OUTLINE_LAYER_ID = 'treaty-cessions-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/**
 * The per-feature fill-opacity band (E2, D-0.7.0-058 ruling 4): HIGH
 * transparency throughout, VARYING by feature so overlapping cessions sum
 * into visible depth instead of one flat wash. Deterministic from the
 * cession number (below), so a refresh or a re-fetch never reshuffles a
 * cession's transparency.
 */
const FILL_OPACITY_MIN = 0.1;
const FILL_OPACITY_MAX = 0.26;
const FILL_OPACITY_STEPS = 7;

/** Per-call network budget for the cessions query. */
const FETCH_TIMEOUT_MS = 15_000;

/** Overscan margin, as a fraction of the viewport on each side (see aiannh.ts). */
const OVERSCAN_FACTOR = 0.25;

/** Cache-key bounds precision in decimal degrees (see aiannh.ts). */
const CACHE_KEY_PRECISION = 1;

/** Distinct views kept in the response cache before the oldest is evicted. */
const CACHE_MAX_ENTRIES = 24;

/** Debounce for the while-active viewport refresh (see aiannh.ts). */
const REFRESH_DEBOUNCE_MS = 400;

/**
 * Geometry generalization tolerance in screen pixels (see aiannh.ts). The
 * Royce source is inherently coarse (1:2,000,000), so half a pixel of
 * display tolerance loses nothing real.
 */
const OFFSET_PIXEL_TOLERANCE = 0.5;

/** Decimal places requested for coordinates (`geometryPrecision`). */
const GEOMETRY_PRECISION = 5;

// CESSNUM_PROPERTY (the table-qualified cession number, promoted to the
// feature id so emphasis survives the refresh's setData swaps) lives in
// src/impact/cession-match.ts since Unit I, shared with the matcher so the
// two literals can never drift.

type Status = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';

/** Master cancellation controller for the in-flight fetch (see aiannh.ts). */
let masterController: AbortController | null = null;

/** Request-identity token (see aiannh.ts). */
let requestSeq = 0;

/** The attached `moveend` refresh handler while the layer is active. */
let moveendHandler: (() => void) | null = null;

/** Pending debounce timer for the viewport refresh. */
let refreshTimer: number | null = null;

/** Honest status of currently rendered data, for cancelAction restore (see aiannh.ts). */
let lastAppliedStatus: Extract<Status, 'ready' | 'no-data' | 'degraded'> | null = null;

/** One cached response: the COVERAGE envelope plus the collection (see aiannh.ts). */
interface CachedResponse {
  readonly envelope: readonly [number, number, number, number];
  readonly geojson: FeatureCollection;
}

/** Session-scoped response cache; browser memory only (hard rule 1 guard). */
const responseCache = new Map<string, CachedResponse>();

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

/** Integer zoom bucket shared by the cache key and the generalization tolerance. */
function resolveZoomBucket(map: maplibregl.Map): number {
  return Math.floor(map.getZoom());
}

/** Bucketed cache key; a hit must also pass `envelopeCovers` (see aiannh.ts). */
function buildCacheKey(map: maplibregl.Map, zoomBucket: number): string {
  const b = map.getBounds();
  const bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    .map((n) => n.toFixed(CACHE_KEY_PRECISION))
    .join(',');
  return `z${zoomBucket}:${bounds}`;
}

/** Inverse of the five-decimal URL serialization grid (see aiannh.ts). */
const ENVELOPE_QUANTUM = 1e5;

/** The overscanned query envelope, quantized OUTWARD to the URL grid. */
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

/** Whether a cached coverage envelope fully contains the current view. */
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

/** Shrink a query envelope one grid quantum inward for caching (see aiannh.ts). */
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

/** Degrees per CSS pixel at the zoom bucket, scaled by the pixel tolerance. */
function resolveMaxAllowableOffset(zoomBucket: number): number {
  const degreesPerPixel = 360 / (512 * Math.pow(2, zoomBucket));
  return degreesPerPixel * OFFSET_PIXEL_TOLERANCE;
}

/**
 * Build the GeoJSON query URL against the cession layer, clipped to the
 * given overscanned envelope. `outFields=*` is deliberate and load-bearing:
 * the joined service silently returns zero features for a guessed bare field
 * name (urls.ts receipt), and the table-qualified names are long enough that
 * the wildcard is also the robust choice.
 */
function buildQueryUrl(
  envelope: readonly [number, number, number, number],
  zoomBucket: number,
  opts?: { returnGeometry?: boolean }
): string {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: envelope.map((n) => n.toFixed(5)).join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: opts?.returnGeometry === false ? 'false' : 'true',
    geometryPrecision: String(GEOMETRY_PRECISION),
    maxAllowableOffset: resolveMaxAllowableOffset(zoomBucket).toFixed(6),
    f: 'geojson'
  });
  return `${URLS.usfsRoyceCessions}/query?${params.toString()}`;
}

/** Validate the response shape; throw so the caller reports `'error'`. */
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
    throw new Error('Royce cessions response was not a GeoJSON FeatureCollection.');
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
 * Resolve the display title for a cession feature: the Royce map name, then
 * the cession number, then a generic label. Shared by the popup path and the
 * boundary context.
 */
function pickCessionTitle(props: GeoJsonProperties): string {
  const mapname = readTableQualifiedField(props, 'mapname');
  if (mapname) return mapname;
  const cessnum = readTableQualifiedField(props, 'cessnum');
  return cessnum ? `Royce cession ${cessnum}` : 'Tribal land cession';
}

/**
 * Deterministic per-feature fill opacity from the cession number: a small
 * string hash bucketed into FILL_OPACITY_STEPS levels across the
 * [FILL_OPACITY_MIN, FILL_OPACITY_MAX] band. The cession number is stable
 * across fetches, so a cession keeps its transparency as the viewport
 * refresh swaps data in and out of view.
 */
function cessionFillOpacity(cessnum: string | null): number {
  const key = cessnum ?? '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const step = hash % FILL_OPACITY_STEPS;
  return (
    FILL_OPACITY_MIN +
    (step * (FILL_OPACITY_MAX - FILL_OPACITY_MIN)) / (FILL_OPACITY_STEPS - 1)
  );
}

/**
 * Precompute the per-feature fill opacity into `_fillOpacity` (the treaty.ts
 * `_color` pattern; MapLibre paint expressions cannot call JavaScript). E2
 * (D-0.7.0-058 ruling 4): the differentiation channel is VARYING high
 * transparency over the one #740058 fill, replacing the retired per-Treaty
 * hue spread. Features are rebuilt, never mutated in place.
 */
function decorate(geojson: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry, GeoJsonProperties>[] = Array.isArray(geojson.features)
    ? geojson.features
    : [];
  return {
    type: 'FeatureCollection',
    features: features.map((feature) => {
      const props: GeoJsonProperties = { ...(feature.properties ?? {}) };
      props._fillOpacity = cessionFillOpacity(readTableQualifiedField(props, 'cessnum'));
      return { ...feature, properties: props };
    })
  };
}

/**
 * Fetch the cessions for the current viewport and apply them (setData on
 * refresh, source + layer on first render). Supersedes the prior request
 * BEFORE the cache lookup; see aiannh.ts for the race rationale.
 */
async function fetchAndApply(map: maplibregl.Map): Promise<void> {
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
    // transport level: the upstream sends max-age=0 + public + ETag
    // (storable, revalidate-on-use), so without this the browser HTTP
    // cache may persist sovereign-boundary responses across page loads
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
    if (signal.aborted || token !== requestSeq) return;
    console.warn('[treaty-cessions] Royce cessions fetch failed.', err);
    reportStatus('error');
    return;
  }

  if (signal.aborted || token !== requestSeq) return;

  if (truncated) {
    console.warn(
      '[treaty-cessions] response truncated by the service (exceededTransferLimit); rendering a partial result for this view and reporting live (partial).'
    );
    applyFeatureCollection(map, geojson, { partial: true });
    return;
  }
  cacheResponse(cacheKey, envelope, geojson);
  applyFeatureCollection(map, geojson);
}

/** Apply a validated collection: setData or first-render source + layer. */
function applyFeatureCollection(
  map: maplibregl.Map,
  geojson: FeatureCollection,
  opts?: { partial?: boolean }
): void {
  const decorated = decorate(geojson);
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(decorated);
  } else {
    addSourceAndLayers(map, decorated);
  }
  lastAppliedFeatures = decorated.features;
  refreshRelatedEmphasis(map);
  lastAppliedStatus = opts?.partial
    ? 'degraded'
    : (geojson.features ?? []).length === 0
      ? 'no-data'
      : 'ready';
  reportStatus(lastAppliedStatus);
}

// =============================================================================
// Related-cession emphasis (Unit I, D-0.7.0-038 decision 2)
// =============================================================================

/**
 * The active related-cession match query (the safe candidate names for the
 * last clicked Tribal land area), or null when no click drives an emphasis.
 * The pure matcher re-runs against every applied collection, so related
 * cessions light up as they enter view and a superseded query's emphasis
 * never lingers. Cleared only by supersession (a new click, or an explicit
 * null): toggles and emphasis are user-journey state, not selection state
 * (design note, docs/design/UNIT_I_RELATED_CESSIONS_2026-07-15.md).
 */
let relatedQuery: CessionMatchQuery | null = null;

/** Feature ids currently carrying the `related` feature-state. */
let relatedIds = new Set<string | number>();

/** The last applied (decorated) feature array, for matcher re-runs. */
let lastAppliedFeatures: ReadonlyArray<Feature<Geometry, GeoJsonProperties>> = [];

/**
 * Set (or clear) the related-match query and re-apply the emphasis against
 * the currently rendered data. Called by src/impact/related-cessions.ts
 * BEFORE the layer activation it requests, so the first applied collection
 * already carries the emphasis.
 */
export function setRelatedCessionQuery(
  map: maplibregl.Map,
  query: CessionMatchQuery | null
): void {
  relatedQuery = query;
  refreshRelatedEmphasis(map);
}

/** Re-run the matcher over the rendered features; move the feature-state. */
function refreshRelatedEmphasis(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) {
    relatedIds = new Set();
    return;
  }
  const result = relatedQuery
    ? matchCessionFeatures(relatedQuery, lastAppliedFeatures)
    : null;
  const next = new Set<string | number>(result?.state === 'matched' ? result.ids : []);
  for (const id of relatedIds) {
    if (next.has(id)) continue;
    try {
      map.setFeatureState({ source: SOURCE_ID, id }, { related: false });
    } catch {
      // The feature left the clipped source data; nothing to clear.
    }
  }
  for (const id of next) {
    try {
      map.setFeatureState({ source: SOURCE_ID, id }, { related: true });
    } catch {
      // Not in the current source data; the next apply re-runs the matcher.
    }
  }
  relatedIds = next;
}

/** One probe response: the (geometry-free) features plus the honesty flag. */
export interface CessionProbeResult {
  readonly features: ReadonlyArray<Feature<Geometry, GeoJsonProperties>>;
  readonly truncated: boolean;
}

/** Coarse fixed zoom bucket for probe queries: geometry is not returned, so
 * the offset parameter is inert; any stable value keeps the URL cacheable. */
const PROBE_ZOOM_BUCKET = 5;

/**
 * Probe the Royce service for cessions intersecting one envelope (the
 * clicked feature's bounding box), WITHOUT touching the map: no source, no
 * layer, no registry status. Properties only (`returnGeometry=false`), so a
 * no-match answer costs a small payload. Same transport doctrine as the
 * layer fetch: `cache: 'no-store'` (R1; a sovereign host never enters
 * browser storage), the shared timeout budget, caller-owned abort.
 */
export async function probeCessions(
  envelope: readonly [number, number, number, number],
  signal: AbortSignal
): Promise<CessionProbeResult> {
  const resp = await fetchWithBudget(
    buildQueryUrl(envelope, PROBE_ZOOM_BUCKET, { returnGeometry: false }),
    { cache: 'no-store' },
    signal,
    FETCH_TIMEOUT_MS
  );
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const raw: unknown = await resp.json();
  const geojson = assertFeatureCollection(raw);
  return {
    features: (geojson.features ?? []) as ReadonlyArray<
      Feature<Geometry, GeoJsonProperties>
    >,
    truncated: isTruncated(raw)
  };
}

/**
 * Add the source, the depth fill, and the solid outline (E2, D-0.7.0-058
 * ruling 4: the dashed hollow style retired; #740058 fills with high,
 * per-feature varying transparency carry the read, overlaps summing into
 * depth). Added even for an empty collection so a later refresh can
 * populate the existing source. Appended without a beforeId, matching the
 * bundled treaty.ts; `reassertLabelOrder` keeps labels on top. The outline
 * stays because it is the click target `bindPopups` wires and the U3h /
 * Unit I emphasis channel (`selected` / `related` feature-states), both
 * unchanged here.
 */
function addSourceAndLayers(map: maplibregl.Map, geojson: FeatureCollection): void {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'USFS Royce cessions',
    promoteId: CESSNUM_PROPERTY
  });

  map.addLayer({
    id: FILL_LAYER_ID,
    type: 'fill',
    source: SOURCE_ID,
    paint: {
      'fill-color': TREATY_CESSION_FILL_COLOR,
      // The per-feature `_fillOpacity` from decorate(); the coalesce
      // fall-through is defensive (every decorated feature carries one).
      'fill-opacity': ['coalesce', ['get', '_fillOpacity'], FILL_OPACITY_MIN]
    }
  });

  map.addLayer({
    id: OUTLINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: {
      'line-color': TREATY_CESSION_FILL_COLOR,
      // The selected cession (U3h) and the click-related cessions (Unit I,
      // `related` feature-state) read through a heavier, fully opaque line.
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        3.2,
        ['boolean', ['feature-state', 'related'], false],
        3.2,
        2
      ],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        1,
        ['boolean', ['feature-state', 'related'], false],
        1,
        0.95
      ]
    }
  });
}

/** Attach the debounced while-active viewport refresh (see aiannh.ts). */
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
 * Fetch the cessions for the current viewport, add the source and layer, and
 * start the while-active viewport refresh. Idempotent (see aiannh.ts).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  attachRefresh(map);
  if (map.getSource(SOURCE_ID)) {
    return;
  }
  await fetchAndApply(map);
}

/**
 * Synchronous cancellation seam (the optional LayerModule hook); see
 * aiannh.ts for the full rationale. Touches no map state.
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
  requestSeq++;
  if (lastAppliedStatus !== null) reportStatus(lastAppliedStatus);
}

/**
 * Stop the viewport refresh, abort any in-flight fetch, and remove the
 * outline, fill, and source. Safe to call when never activated.
 */
export function deactivate(map: maplibregl.Map): void {
  detachRefresh(map);
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  requestSeq++;
  lastAppliedStatus = null;
  // The rendered data and its feature-states go with the source; the related
  // match QUERY survives (a manual re-activation re-lights the same Tribe's
  // cessions until a new click supersedes it).
  relatedIds = new Set();
  lastAppliedFeatures = [];
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Wire the click-to-popup handler and hover cursor affordance on the outline
 * layer. Bound once at boot, independent of activation. The boundary context
 * reuses the `treaty` kind with an explicit feature title (the Unit A model:
 * the kind label "Historical Treaty area" is honest for cessions, and the
 * popup carries the source-specific disclaimer).
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', OUTLINE_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    emphasizePlace(map, SOURCE_ID, feature.id);
    const props: GeoJsonProperties = feature.properties ?? null;
    const title = pickCessionTitle(props);
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildTreatyCessionPopupHtml(props))
      .addTo(map);
    attachImpactTrigger(
      popup,
      buildBoundaryContext('treaty', props, feature.geometry, e.lngLat, title)
    );
  });

  map.on('mouseenter', OUTLINE_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', OUTLINE_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
