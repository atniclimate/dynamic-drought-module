/**
 * Hydrography layer: rivers and canals from the OpenStreetMap (OSM)
 * Overpass Application Programming Interface (API).
 *
 * Direct port of the vanilla `app.js` v0.1.x flow (`loadHydrography`,
 * `fetchOSMWaterways`, `renderWaterways`, `waterwayWeight`, plus the
 * `MAJOR_RIVER_NAMES`, `MAINSTEM_NAMES`, `HYDRO_MIN_ZOOM`,
 * `HYDRO_BBOX_QUANT`, `HYDRO_CACHE` constants) onto MapLibre GL
 * JavaScript. The Leaflet `L.layerGroup` of polylines becomes a single
 * MapLibre GeoJSON source whose `data` is replaced on each successful
 * fetch and a single line layer that draws every way at once.
 *
 * Cancellation contract (the cancellation invariant; preserved verbatim
 * from v0.1.x):
 *
 *   1. A single module-level `currentController: AbortController | null`
 *      governs the "current" Overpass operation. A new fetch supersedes
 *      (aborts) any in-flight predecessor.
 *   2. Each mirror gets its own per-call timeout via `fetchWithBudget`.
 *   3. 350 ms `sleepUnlessAborted` between failed mirror attempts so a
 *      hung connection does not block the cycle.
 *   4. After every `await`, re-check `controller.signal.aborted` and
 *      bail without touching status if true.
 *   5. Final supersede check before rendering: if `controller !==
 *      currentController` the operation has been replaced; drop the
 *      payload on the floor rather than rendering a stale viewport.
 *   6. `deactivate` clears both `currentController` AND any pending
 *      debounce timer (the v0.1.x bug fix: previously the debounce
 *      timer reference was cleared but the timer itself still fired).
 *   7. Below `HYDRO_MIN_ZOOM` (= 7) the layer is dormant (status
 *      `'zoom-in'`) and no Overpass call is issued.
 *
 * Quantized bbox cache. A module-level `Map` keyed by the quantized
 * `[south, west, north, east]` bounding box (joined with commas at the
 * `HYDRO_BBOX_QUANT = 0.25` step) coalesces nearby viewport states into
 * a single network call. A cache hit renders immediately and skips the
 * fetch. Bbox stays in Leaflet `[s, w, n, e]` order to match the cache
 * layout from v0.1.x; `quantizeBbox` lives in `../util/bbox`.
 *
 * Status reporting goes through the LayerRegistry (`registry.setStatus`,
 * via the local `setStatus` helper below).
 */

import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';

import { URLS } from '../config/urls';
import { quantizeBbox } from '../util/bbox';
import { fetchWithBudget, sleepUnlessAborted } from '../util/fetch';
import { registry } from '../state/registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYER_KEY = 'hydrography';
const SOURCE_ID = 'hydrography';
const LAYER_ID = 'hydrography';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

/**
 * Layer ID before which the hydrography line layer should be inserted,
 * when present. Matches the convention used by `ecoregions.ts`: the base
 * style may declare `'first-symbol'` to mark the boundary between data
 * layers and labels. Falls back to appending if no such layer exists.
 */
const BEFORE_LAYER_ID = 'first-symbol';

/** Minimum zoom level at which the Overpass call is issued. */
const HYDRO_MIN_ZOOM = 7;

/** Bounding-box quantization step (degrees) used for the cache key. */
const HYDRO_BBOX_QUANT = 0.25;

/** Per-mirror request timeout, milliseconds. */
const PER_MIRROR_TIMEOUT_MS = 12000;

/** Backoff between failed mirror attempts, milliseconds. */
const BACKOFF_MS = 350;

/** Debounce window for `moveend`-triggered fetches, milliseconds. */
const MOVEEND_DEBOUNCE_MS = 350;

/**
 * Major rivers we want to weight more heavily in the rendering. Names
 * match OSM `name=*` tags on Pacific Northwest (PNW) waterways.
 */
const MAJOR_RIVER_NAMES: ReadonlySet<string> = new Set([
  'Columbia River', 'Snake River', 'Yakima River', 'Willamette River',
  'Deschutes River', 'Skagit River', 'Cowlitz River', 'Lewis River',
  'Klickitat River', 'John Day River', 'Wenatchee River', 'Methow River',
  'Spokane River', 'Okanogan River', 'Crooked River', 'Salmon River',
  'Clearwater River', 'Owyhee River', 'Hood River', 'Sandy River',
  'Pend Oreille River', 'Kootenai River', 'Kootenay River',
  'Chehalis River', 'Nisqually River', 'Puyallup River', 'Stillaguamish River'
]);

/** Mainstem rivers, weighted heaviest of all. */
const MAINSTEM_NAMES: ReadonlySet<string> = new Set([
  'Columbia River', 'Snake River'
]);

type HydroStatus = 'loading' | 'ready' | 'zoom-in' | 'error';

/**
 * Quantized-bbox cache of GeoJSON FeatureCollections keyed by the
 * Leaflet-shaped `[s, w, n, e]` bounding box joined by commas. Module-
 * level so it survives `deactivate` and `activate` cycles within a
 * single page load.
 */
const HYDRO_CACHE = new Map<string, FeatureCollection<LineString>>();

// ---------------------------------------------------------------------------
// Module-level cancellation state
// ---------------------------------------------------------------------------

/**
 * The "current" Overpass operation. A new fetch aborts this controller
 * before issuing its own request; `deactivate` aborts and clears it.
 * Late-arriving responses for a superseded controller are dropped via
 * the final supersede check inside `fetchOSMWaterways`.
 */
let currentController: AbortController | null = null;

/**
 * Pending debounce timer for the `moveend` handler. Cleared AND nulled
 * by `deactivate`; clearing without nulling was the v0.1.x bug fix.
 */
let moveendDebounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Reference to the bound `moveend` handler so `deactivate` can detach
 * it. Stored at the module level because a fresh closure is captured
 * per `activate` call.
 */
let moveendHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// activate / deactivate
// ---------------------------------------------------------------------------

/**
 * Add an empty GeoJSON source and the line layer for hydrography, wire a
 * debounced `moveend` handler that calls `fetchOSMWaterways`, and fire
 * an initial fetch for the current viewport. Idempotent: re-activating
 * an already-active layer leaves the existing source and layer in place
 * but still issues a fresh fetch for the current viewport.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  setStatus('loading');

  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: emptyFeatureCollection()
    });
  }

  if (!map.getLayer(LAYER_ID)) {
    const beforeId = map.getLayer(BEFORE_LAYER_ID) ? BEFORE_LAYER_ID : undefined;
    map.addLayer(
      {
        id: LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#1f78b4',
          // Per-feature weight is precomputed into `properties._weight`
          // by `featureFromWay`, so the paint expression is trivial.
          'line-width': ['get', '_weight'],
          'line-opacity': 0.92
        }
      },
      beforeId
    );
  }

  // Wire the debounced moveend handler. The handler closes over `map`
  // so subsequent fetches use whatever bounds the user has panned to.
  // (River names under the cursor are surfaced by the shared hover
  // inspector, src/ui/hover-inspector.ts, not by a per-river tooltip.)
  // Guarded like the addSource/addLayer calls above: a double activation
  // without an intervening deactivate (the sidebar serializes operations,
  // but this module must not rely on its caller) would otherwise overwrite
  // the reference and orphan the first listener forever.
  if (!moveendHandler) {
    moveendHandler = (): void => {
      if (moveendDebounce) clearTimeout(moveendDebounce);
      moveendDebounce = setTimeout(() => {
        moveendDebounce = null;
        void runFetchForCurrentViewport(map);
      }, MOVEEND_DEBOUNCE_MS);
    };
    map.on('moveend', moveendHandler);
  }

  // Initial fetch fires immediately, no debounce.
  await runFetchForCurrentViewport(map);
}

/**
 * Symmetric tear-down for `activate`: clear the debounce timer (both
 * `clearTimeout` AND null the reference; v0.1.x bug fix), abort the
 * in-flight controller, detach the `moveend` listener, and remove the
 * line layer plus source from the map. Safe to call when the layer has
 * not been activated.
 */
export function deactivate(map: maplibregl.Map): void {
  // Clear the debounce timer and null the reference. Both steps matter:
  // a stale, fired timer that has not yet been GC'd would otherwise be
  // visible to a new `activate` call as a non-null reference.
  if (moveendDebounce) {
    clearTimeout(moveendDebounce);
    moveendDebounce = null;
  }

  // Abort any in-flight Overpass operation.
  if (currentController) {
    currentController.abort();
    currentController = null;
  }

  // Detach the moveend listener so the next activate cycle does not
  // accumulate handlers.
  if (moveendHandler) {
    map.off('moveend', moveendHandler);
    moveendHandler = null;
  }

  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

// ---------------------------------------------------------------------------
// fetchOSMWaterways (a frozen named export)
// ---------------------------------------------------------------------------

/**
 * Fetch waterways from the OSM Overpass API for the supplied bounds and
 * return them as a GeoJSON FeatureCollection of LineStrings. Exported
 * because the orchestrator may want to drive a fetch directly outside
 * the moveend loop (for example, a post-region-change refresh).
 *
 * Each LineString carries `properties.name` (OSM `name` tag, possibly
 * empty), `properties.waterway` ('river' or 'canal'), and
 * `properties._weight` (the precomputed render weight for the line
 * layer's `line-width` paint). The caller is responsible for handing the
 * collection to the GeoJSON source via `setData`.
 *
 * Mirror cycling. Tries `URLS.overpassMirrors` in order, with a 12-second
 * per-call timeout via `fetchWithBudget` and a 350 ms backoff between
 * failures (`sleepUnlessAborted`, so layer-off short-circuits the wait).
 * On HTTP non-OK or network error, advances to the next mirror; if the
 * abort signal fires at any point, returns an empty collection.
 *
 * Returns an empty FeatureCollection rather than throwing on abort or
 * full mirror failure so the caller does not need a try/catch around
 * each invocation. Status is the caller's responsibility; this function
 * only fetches and parses.
 */
export async function fetchOSMWaterways(
  _map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  signal: AbortSignal
): Promise<FeatureCollection<LineString>> {
  // Bbox stays in Leaflet `[s, w, n, e]` order to match the cache
  // layout from v0.1.x; `quantizeBbox` operates on the same order.
  const bbox = quantizeBbox(
    [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()],
    HYDRO_BBOX_QUANT
  );

  const cacheKey = bbox.join(',');
  const cached = HYDRO_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Overpass Query Language (Overpass QL): rivers plus canals only.
  // Streams would flood the renderer at these zoom levels. `out geom`
  // returns each way's lat/lon coordinate array inline.
  const [s, w, n, e] = bbox;
  const query = `
    [out:json][timeout:25];
    (
      way["waterway"="river"](${s},${w},${n},${e});
      way["waterway"="canal"](${s},${w},${n},${e});
    );
    out geom tags;
  `.trim();

  let payload: OverpassPayload | null = null;
  let lastErr: unknown = null;

  // TODO(pmtiles): replace live Overpass mirror cycling with a static
  // PMTiles bundle of clipped USGS NHD hydrography.
  const mirrors = URLS.overpassMirrors;
  for (let i = 0; i < mirrors.length; i++) {
    if (signal.aborted) return emptyFeatureCollection();
    const endpoint = mirrors[i];
    try {
      const resp = await fetchWithBudget(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'
          },
          body: 'data=' + encodeURIComponent(query)
        },
        signal,
        PER_MIRROR_TIMEOUT_MS
      );
      if (signal.aborted) return emptyFeatureCollection();

      if (!resp.ok) {
        lastErr = new Error(`Overpass ${endpoint}: HTTP ${resp.status}`);
        if (i < mirrors.length - 1) {
          await sleepUnlessAborted(BACKOFF_MS, signal);
        }
        continue;
      }
      payload = (await resp.json()) as OverpassPayload;
      if (signal.aborted) return emptyFeatureCollection();
      break;
    } catch (err) {
      // User-cancel or supersede: bail entirely without touching status.
      if (signal.aborted) return emptyFeatureCollection();
      lastErr = err;
      if (i < mirrors.length - 1) {
        await sleepUnlessAborted(BACKOFF_MS, signal);
      }
    }
  }

  if (!payload) {
    console.warn('All Overpass mirrors failed.', lastErr);
    return emptyFeatureCollection();
  }

  const features: Feature<LineString>[] = [];
  const elements = Array.isArray(payload.elements) ? payload.elements : [];
  for (const el of elements) {
    const feature = featureFromWay(el);
    if (feature) features.push(feature);
  }

  const collection: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features
  };
  HYDRO_CACHE.set(cacheKey, collection);
  return collection;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The fetch driver invoked by both `activate` (initial) and the
 * debounced `moveend` handler. Owns the cancellation contract: aborts
 * and replaces `currentController`, runs the dormant-layer short
 * circuit below `HYDRO_MIN_ZOOM`, and performs the final supersede
 * check before pushing data into the GeoJSON source.
 */
async function runFetchForCurrentViewport(map: maplibregl.Map): Promise<void> {
  const zoom = map.getZoom();
  if (zoom < HYDRO_MIN_ZOOM) {
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    setSourceData(map, emptyFeatureCollection());
    setStatus('zoom-in');
    return;
  }

  // Supersede any in-flight Overpass operation.
  if (currentController) currentController.abort();
  const controller = new AbortController();
  currentController = controller;

  setStatus('loading');

  let collection: FeatureCollection<LineString>;
  try {
    collection = await fetchOSMWaterways(map, map.getBounds(), controller.signal);
  } catch (err) {
    // `fetchOSMWaterways` is designed to not throw on abort or mirror
    // failure, but a surprise from the runtime should still respect the
    // supersede contract.
    if (controller.signal.aborted) return;
    if (controller !== currentController) return;
    console.warn('[hydrography] unexpected fetch error.', err);
    setStatus('error');
    return;
  }

  // After every `await`, re-check `controller.signal.aborted` and bail
  // without touching status.
  if (controller.signal.aborted) return;

  // Final supersede check: if a newer fetch replaced `currentController`
  // mid-flight, drop this payload on the floor rather than rendering a
  // stale viewport.
  if (controller !== currentController) return;

  // A truly empty collection from a non-cancelled run means every mirror
  // failed; surface as the canonical 'error' state ("unavailable" in the
  // sidebar). Conversely a cache hit may legitimately return zero
  // features for an empty patch of the world; we cannot distinguish here
  // without more state, so empty maps to 'ready'. The mirror-failure
  // path above logged a warning; this branch handles only the
  // cache-hit-with-zero-features case.
  if (collection.features.length === 0 && !HYDRO_CACHE.has(cacheKeyForBounds(map.getBounds()))) {
    setStatus('error');
    return;
  }

  setSourceData(map, collection);
  setStatus('ready');
}

/**
 * Build the cache key string for a given bounds object. Used by the
 * post-fetch error-vs-empty disambiguation in `runFetchForCurrentViewport`.
 */
function cacheKeyForBounds(bounds: maplibregl.LngLatBounds): string {
  const bbox = quantizeBbox(
    [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()],
    HYDRO_BBOX_QUANT
  );
  return bbox.join(',');
}

/**
 * Convert a single Overpass `way` element to a GeoJSON LineString
 * Feature. Returns `null` for non-way elements, ways with fewer than
 * two coordinates, or any other malformed input.
 *
 * The OSM `geometry` array carries objects with `lat`/`lon` keys (note
 * the OSM ordering is latitude first, longitude second). GeoJSON
 * coordinate order is `[lng, lat]`, so the conversion swaps the pair.
 *
 * The `_weight` property is precomputed here so the line layer's
 * `line-width` paint can read it via `['get', '_weight']`.
 */
function featureFromWay(el: OverpassElement): Feature<LineString> | null {
  if (el.type !== 'way') return null;
  if (!Array.isArray(el.geometry) || el.geometry.length < 2) return null;

  const coords: [number, number][] = [];
  for (const g of el.geometry) {
    if (typeof g.lat !== 'number' || typeof g.lon !== 'number') continue;
    coords.push([g.lon, g.lat]);
  }
  if (coords.length < 2) return null;

  const tags = el.tags ?? {};
  const name = typeof tags.name === 'string' ? tags.name : '';
  const waterway = typeof tags.waterway === 'string' ? tags.waterway : 'river';
  const weight = waterwayWeight(name, waterway);

  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: coords
    },
    properties: {
      name,
      waterway,
      _weight: weight
    }
  };
}

/**
 * Pick the render weight (line-width pixels) for a waterway. Mainstem
 * rivers (Columbia and Snake) draw heaviest; the curated PNW major-river
 * set is next; canals are thin; anything else uses the default body
 * width.
 */
function waterwayWeight(name: string, waterway: string): number {
  if (MAINSTEM_NAMES.has(name)) return 3.0;
  if (MAJOR_RIVER_NAMES.has(name)) return 2.2;
  if (waterway === 'canal') return 1.0;
  return 1.4;
}

/**
 * Replace the GeoJSON source's data with the supplied collection, if
 * the source is currently on the map. A `deactivate` call between the
 * fetch and the render would have removed the source, in which case
 * we silently skip; the next `activate` will issue a fresh fetch.
 */
function setSourceData(
  map: maplibregl.Map,
  data: FeatureCollection<LineString>
): void {
  const source = map.getSource(SOURCE_ID);
  if (!source) return;
  (source as maplibregl.GeoJSONSource).setData(data);
}

/** Build a fresh empty FeatureCollection of LineStrings. */
function emptyFeatureCollection(): FeatureCollection<LineString> {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Report the layer's load status to the LayerRegistry. The sidebar renders
 * the per-layer status pill from the registry's status-change event. Called
 * from both activation and the moveend fetch driver (for example to surface
 * 'zoom-in' when the user zooms out below the Overpass threshold).
 */
function setStatus(status: HydroStatus): void {
  registry.setStatus(LAYER_KEY, status);
}

// ---------------------------------------------------------------------------
// Overpass response shape
// ---------------------------------------------------------------------------

/**
 * Minimal structural typing of the Overpass JSON response. Only the
 * fields this module reads are typed; anything else is ignored.
 */
interface OverpassPayload {
  elements?: OverpassElement[];
}

interface OverpassElement {
  type?: string;
  geometry?: { lat?: number; lon?: number }[];
  tags?: { name?: string; waterway?: string };
}
