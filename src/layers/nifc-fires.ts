/**
 * National Interagency Fire Center (NIFC) current mapped fire perimeters.
 *
 * Source: Wildland Fire Interagency Geospatial Services (WFIGS) "Current
 * Interagency Fire Perimeters" feature service, hosted on the NIFC Open
 * Data Hub as an Environmental Systems Research Institute (ESRI)
 * Representational State Transfer (REST) FeatureServer. Refreshed
 * approximately every five minutes from the upstream WFIGS database.
 *
 * Endpoint choice. The NIFC Open Data Hub publishes several WFIGS
 * perimeter products:
 *   - WFIGS_Interagency_Perimeters            (cumulative, all years)
 *   - WFIGS_Interagency_Perimeters_YearToDate (current calendar year)
 *   - WFIGS_Interagency_Perimeters_Current    (currently active fires)
 *   - WFIGS_Daily_Perimeters_Public           (daily snapshot)
 *   - WFIGS_Interagency_Perimeters_Certified  (post-incident, finalized)
 * The `_Current` view supplies the agency's current mapped perimeter product;
 * its incident categories still require the Wildfire, Prescribed fire, and
 * other or unclassified presentation split below.
 *
 * Verification (2026-05-09):
 *   GET <URLS.nifcFires>/query?where=1%3D1&outFields=*&f=geojson
 *     - HTTP 200
 *     - Content-Type: application/json; charset=utf-8
 *     - Access-Control-Allow-Origin: *
 *     - Body: GeoJSON FeatureCollection of polygons with WFIGS
 *       attribute schema (`poly_*` for geometry-derived fields,
 *       `attr_*` for incident metadata such as
 *       `attr_IncidentName`, `attr_IncidentTypeCategory`,
 *       `attr_IncidentSize`, `attr_FireDiscoveryDateTime`,
 *       `attr_POOState`).
 *
 * Query scope (FE-16, 2026-08-28). The shipped national query with
 * `outFields=*` and full-precision geometry measured 42.75 MB in 41.6 s for
 * 243 perimeters against this layer's 15 s budget, so the layer aborted and
 * read `unavailable` on every boot. The query now names the attributes the
 * layer, popup, map key, and conditions strip read (NIFC_OUT_FIELDS,
 * schema-checked; a wrong name is an HTTP 400) and asks the service for
 * display generalization (`maxAllowableOffset` 0.0005 degree,
 * `geometryPrecision` 5): 1.83 MB in 4.5 s on the same day. The
 * generalization changes the drawn edge, so NIFC_GENERALIZATION_NOTE is
 * carried by the legend, the popup, and the map key.
 *
 * Viewport scope (DDM-P1-T06, 2026-09-12). The query is now ALSO clipped to
 * an overscanned envelope of the current view, copying aiannh.ts's pattern:
 * a request carries `geometry`/`geometryType=esriGeometryEnvelope`/`inSR`/
 * `spatialRel`, the response's envelope (shrunk inward one grid quantum) is
 * cached, an ordinary pan inside it reuses the cache with no request, and a
 * `moveend` that leaves it re-queries. `where` stays `1=1`; only the spatial
 * filter narrows the scan. Status honesty follows the coverage, not the
 * fetch: leaving the covered envelope reports `loading` until the new
 * response lands (never `no-data` on the strength of the old one), `no-data`
 * is reported only when a response covering the current view is empty, and
 * a re-query that fails keeps the last covering collection's honest status
 * if it still covers the view, else reports `error`. Measured 2026-09-12:
 * the national scan was 1,653,142 bytes for 194 perimeters; the default
 * Washington view's overscanned envelope was 561,186 bytes for 58
 * perimeters (see tests/nifc-query-scope.spec.ts and the task's closing
 * figures for the exact requests).
 *
 * Render. WFIGS perimeters are polygons. Wildfire and incident-complex
 * records use a restrained orange pulse, Prescribed fire uses a neutral
 * treatment, and other or unclassified records receive a neutral outline.
 * No perimeter age is inferred from the service refresh cadence.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  NIFC_GENERALIZATION_NOTE,
  NIFC_GEOMETRY_PRECISION,
  NIFC_INCIDENT_TYPE_PROPERTY,
  NIFC_INCIDENT_PRESENTATION,
  NIFC_MAX_ALLOWABLE_OFFSET_DEG,
  NIFC_OUT_FIELDS,
  WILDFIRE_PULSE_DURATION_MS,
  buildNifcFillPaint,
  buildNifcIncidentFilter,
  buildNifcLinePaint,
  classifyNifcIncidentType,
  interpolateWildfirePulseColor,
  nifcIncidentTypeLabel,
  parseArcGisPolygonFeatureCollection
} from '../config/wildfire-presentation';
import { mapRendererClass, type RendererClass } from '../map/gl-capability';
import { registerClickTarget } from '../map/interaction-coordinator';
import type { IssuedModel, IssuerSwatch, PopupClock, PopupDetail, RecordBlock, RecordSize } from '../ui/popup-frame';
import { fetchJsonWithBudget } from '../util/fetch';
import { prefersReducedMotion } from '../util/motion';
import { dateTok } from '../util/text-tokens';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';
import {
  clearTimeBar,
  getTimeBarSpec,
  onTimeBarSpecChange,
  setTimeBar,
  timeBarOwner
} from '../ui/time-bar';
import { readFireContext, type FireContext } from '../impact/fire-context';

const LAYER_KEY = 'nifc-fires';
const SOURCE_ID = 'nifc-fires';
const FILL_LAYER_ID = 'nifc-fires-fill';
const OUTLINE_LAYER_ID = 'nifc-fires-outline';
const PRESCRIBED_FILL_LAYER_ID = 'nifc-prescribed-fill';
const PRESCRIBED_OUTLINE_LAYER_ID = 'nifc-prescribed-outline';
const OTHER_OUTLINE_LAYER_ID = 'nifc-other-outline';

/**
 * The only MapLibre paint properties animated by the wildfire pulse.
 *
 * The last six are the DR-064 perimeter ribbon's fade slabs, which exist
 * only while the desktop 3D Fire mode is active (mirrored literals from
 * src/layers/nifc-perimeter-ribbon.ts, kept in step by the fire3d spec).
 * Listing them here rather than wiring a second animation owner is what
 * keeps the ribbon in PHASE with the flat outline: one clock, one color,
 * one reduced-motion rule. The controller paints only the targets whose
 * layers are in the style (a cached list, re-read when the ribbon's source
 * comes or goes and whenever a commit finds a cached layer gone), so on a
 * flat map these six are simply absent, and the two 2D targets guarantee
 * the controller always finds work while the layer is on.
 */
export const WILDFIRE_PULSE_PAINT_TARGETS = [
  { layerId: FILL_LAYER_ID, paintProperty: 'fill-color' },
  { layerId: OUTLINE_LAYER_ID, paintProperty: 'line-color' },
  { layerId: 'nifc-perimeter-ribbon-0', paintProperty: 'fill-extrusion-color' },
  { layerId: 'nifc-perimeter-ribbon-1', paintProperty: 'fill-extrusion-color' },
  { layerId: 'nifc-perimeter-ribbon-2', paintProperty: 'fill-extrusion-color' },
  { layerId: 'nifc-perimeter-ribbon-3', paintProperty: 'fill-extrusion-color' },
  { layerId: 'nifc-perimeter-ribbon-4', paintProperty: 'fill-extrusion-color' },
  { layerId: 'nifc-perimeter-ribbon-5', paintProperty: 'fill-extrusion-color' }
] as const;

type WildfirePulsePaintTarget = (typeof WILDFIRE_PULSE_PAINT_TARGETS)[number];

/**
 * The ribbon's derived source (mirrored literal from
 * src/layers/nifc-perimeter-ribbon.ts, lazy-chunk independence). The ribbon
 * adds this source and its six slabs in one synchronous step and removes
 * them the same way, so a `sourcedata` event for it is the moment the
 * pulse's cached target list goes stale.
 */
const PERIMETER_RIBBON_SOURCE_ID = 'nifc-perimeter-ribbon';

/** Flat map: about 17 paint commits per second, requestAnimationFrame owns timing (decision A keeps it). */
export const WILDFIRE_PULSE_PAINT_INTERVAL_MS = 60;
/** Decision A (owner, 2026-09-11): 4 commits per second while 3D terrain is on the map, where each commit forces a full terrain redraw (measured 2026-09-11, S28). */
export const WILDFIRE_PULSE_TERRAIN_PAINT_INTERVAL_MS = 250;
/** Decision A: 2 per second on terrain with a known software renderer, where 60 ms queued pitch-60 frames and a marker readback then blocked the main thread 43 to 62 s (measured 2026-09-11, S28). */
export const WILDFIRE_PULSE_SOFTWARE_TERRAIN_PAINT_INTERVAL_MS = 500;

/**
 * The pulse's paint-commit interval for the current scene (decision A,
 * docs/design/fire3d-entry.md). Pure, for the Node spec. The cadence only
 * decides how OFTEN paint is committed; the colour committed is always a
 * function of elapsed time alone, so a cadence change is never a pause or a
 * restart. An `unknown` renderer is treated as hardware, never as software.
 */
export function wildfirePulsePaintIntervalMs(scene: {
  readonly terrainPresent: boolean;
  readonly rendererClass: RendererClass;
}): number {
  if (!scene.terrainPresent) return WILDFIRE_PULSE_PAINT_INTERVAL_MS;
  return scene.rendererClass === 'software'
    ? WILDFIRE_PULSE_SOFTWARE_TERRAIN_PAINT_INTERVAL_MS
    : WILDFIRE_PULSE_TERRAIN_PAINT_INTERVAL_MS;
}

/** True when the map carries 3D terrain right now; false for a map double without the method. */
function mapHasTerrain(map: maplibregl.Map): boolean {
  return typeof map.getTerrain === 'function' && map.getTerrain() !== null;
}

/**
 * One layer-level animation owner. Every WF/CX feature shares these two
 * filtered MapLibre layers, so no feature-level timer or DOM animation is
 * needed. Visibility and layer-existence guards avoid background/stale work.
 */
class WildfirePulseController {
  private frameId: number | null = null;
  private originMs: number | null = null;
  private lastPaintAtMs = Number.NEGATIVE_INFINITY;
  private stopped = false;
  /**
   * The paint targets whose layers were in the style at the last read, or
   * null to read again before the next commit (decision A). A commit
   * confirms only these; the absent slabs are not probed again until the
   * ribbon's source changes.
   */
  private presentTargets: readonly WildfirePulsePaintTarget[] | null = null;

  constructor(private readonly map: maplibregl.Map) {}

  start(): void {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    // `styledata` is NOT the refresh signal: MapLibre emits it after every
    // style change, the pulse's own paint commits included (Style.update
    // fires `data` whenever `_changed`, and setPaintProperty sets it), so
    // it would re-read the list on every commit. The ribbon's source is the
    // only thing that adds targets while the pulse runs.
    if (typeof this.map.on === 'function') {
      this.map.on('sourcedata', this.onSourceData);
    }
    this.scheduleFrame();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (typeof this.map.off === 'function') {
      this.map.off('sourcedata', this.onSourceData);
    }
    this.cancelFrame();
  }

  private readonly onSourceData = (event: maplibregl.MapSourceDataEvent): void => {
    if (event.sourceId === PERIMETER_RIBBON_SOURCE_ID) this.presentTargets = null;
  };

  private readonly onVisibilityChange = (): void => {
    if (this.stopped) return;
    if (document.hidden) {
      this.cancelFrame();
      return;
    }
    this.scheduleFrame();
  };

  private readonly paintFrame = (timestampMs: number): void => {
    this.frameId = null;
    if (this.stopped || document.hidden) return;

    // Begin at the canonical static midpoint, then ease toward the hot end.
    // The origin is set once and never moved, so the colour is a function
    // of elapsed time alone and a cadence change cannot shift the phase.
    this.originMs ??= timestampMs - WILDFIRE_PULSE_DURATION_MS / 4;
    if (timestampMs - this.lastPaintAtMs >= this.paintIntervalMs()) {
      const color = interpolateWildfirePulseColor(timestampMs - this.originMs);
      if (!this.commitPaint(color)) {
        this.stop();
        return;
      }
      this.lastPaintAtMs = timestampMs;
    }
    this.scheduleFrame();
  };

  /** Decision A's cadence for the scene as it is at this frame. */
  private paintIntervalMs(): number {
    const terrainPresent = mapHasTerrain(this.map);
    return wildfirePulsePaintIntervalMs({
      terrainPresent,
      // The renderer is asked only once terrain is up, and only once per map.
      rendererClass: terrainPresent ? mapRendererClass(this.map) : 'unknown'
    });
  }

  /** Paint every present target; false when none is left. */
  private commitPaint(color: string): boolean {
    let targets = this.presentTargets;
    if (
      targets === null ||
      targets.some((target) => !this.map.getLayer(target.layerId))
    ) {
      targets = this.readPresentTargets();
    }
    for (const target of targets) {
      this.map.setPaintProperty(target.layerId, target.paintProperty, color);
    }
    return targets.length > 0;
  }

  private readPresentTargets(): readonly WildfirePulsePaintTarget[] {
    const present = WILDFIRE_PULSE_PAINT_TARGETS.filter((target) =>
      Boolean(this.map.getLayer(target.layerId))
    );
    this.presentTargets = present;
    return present;
  }

  private scheduleFrame(): void {
    if (this.stopped || document.hidden || this.frameId !== null) return;
    this.frameId = window.requestAnimationFrame(this.paintFrame);
  }

  private cancelFrame(): void {
    if (this.frameId === null) return;
    window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }
}

let wildfirePulseController: WildfirePulseController | null = null;

function stopWildfirePulse(): void {
  wildfirePulseController?.stop();
  wildfirePulseController = null;
}

function startWildfirePulse(map: maplibregl.Map): void {
  stopWildfirePulse();
  if (
    prefersReducedMotion() ||
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof window.requestAnimationFrame !== 'function' ||
    typeof window.cancelAnimationFrame !== 'function'
  ) {
    return;
  }
  wildfirePulseController = new WildfirePulseController(map);
  wildfirePulseController.start();
}

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [
  FILL_LAYER_ID,
  OUTLINE_LAYER_ID,
  PRESCRIBED_FILL_LAYER_ID,
  PRESCRIBED_OUTLINE_LAYER_ID,
  OTHER_OUTLINE_LAYER_ID
] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor when inserting fill and
 * outline layers. Matches the convention from `usdm.ts`, `ecoregions.ts`,
 * and `tribal.ts` so polygon overlays stack consistently below the
 * basemap label glyphs.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the WFIGS perimeters query. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` or re-query so a superseded
 * request can never render into a torn-down layer (the cancellation
 * invariant); DDM-P1-T06 extends this same controller to the viewport
 * re-query, not only the initial activation.
 */
let masterController: AbortController | null = null;

type NifcStatus = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';

function reportStatus(state: NifcStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

// ---------------------------------------------------------------------------
// Viewport scope (DDM-P1-T06): the overscanned envelope, the coverage cache,
// and the while-active re-query. Copies aiannh.ts's precedent (its module
// docblock and buildQueryEnvelope/envelopeCovers/toCoverageEnvelope), sized
// down to a single cached response since this layer does not zoom-bucket its
// generalization the way AIANNH's does.
// ---------------------------------------------------------------------------

/** `[west, south, east, north]`, EPSG:4326. */
type QueryEnvelope = readonly [number, number, number, number];

/**
 * Overscan margin applied to the query envelope, as a fraction of the
 * viewport's width and height on each side (aiannh.ts's OVERSCAN_FACTOR),
 * so small pans render correctly at their edges and are more likely to hit
 * the coverage cache.
 */
const OVERSCAN_FACTOR = 0.25;

/**
 * Inverse of the five-decimal precision the query URL serializes envelope
 * coordinates at (aiannh.ts's ENVELOPE_QUANTUM): the envelope is quantized
 * outward to this grid so the cached coverage envelope and the envelope
 * actually sent to the service are the same numbers.
 */
const ENVELOPE_QUANTUM = 1e5;

/** Debounce for the while-active viewport refresh (aiannh.ts's precedent). */
const REFRESH_DEBOUNCE_MS = 400;

/** The overscanned query envelope for the current viewport (aiannh.ts's buildQueryEnvelope). */
function buildQueryEnvelope(map: maplibregl.Map): QueryEnvelope {
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

/**
 * The current view's query envelope, or `null` for a map double without
 * `getBounds` (a direct unit-test call on a bare fake map, the same
 * allowance `mapHasTerrain` makes for `getTerrain`). A `null` envelope falls
 * back to the pre-DDM-P1-T06 national `where=1=1` scan with no spatial
 * filter and is never cached, so those callers see unchanged behavior.
 */
function resolveQueryEnvelope(map: maplibregl.Map): QueryEnvelope | null {
  return typeof map.getBounds === 'function' ? buildQueryEnvelope(map) : null;
}

/** Whether a cached query envelope fully contains the current visible view (aiannh.ts's envelopeCovers). */
function envelopeCovers(envelope: QueryEnvelope, map: maplibregl.Map): boolean {
  const b = map.getBounds();
  return (
    envelope[0] <= b.getWest() &&
    envelope[1] <= b.getSouth() &&
    envelope[2] >= b.getEast() &&
    envelope[3] >= b.getNorth()
  );
}

/** Shrink a query envelope inward by one grid quantum for the coverage cache (aiannh.ts's toCoverageEnvelope). */
function toCoverageEnvelope(envelope: QueryEnvelope): QueryEnvelope {
  const q = 1 / ENVELOPE_QUANTUM;
  return [envelope[0] + q, envelope[1] + q, envelope[2] - q, envelope[3] - q];
}

/**
 * One cached response: the validated collection plus the COVERAGE envelope.
 * A cache hit is conditional on `envelopeCovers` containing the current
 * visible view (design clause 3); an ordinary pan inside the envelope reuses
 * this and a view that leaves it re-queries. Unlike aiannh.ts's per-viewport
 * map, this layer keeps only the most recent response: the acceptance
 * clause is about honest status across a re-query, not about serving many
 * distinct regions from memory at once.
 */
interface CachedResponse {
  readonly envelope: QueryEnvelope;
  readonly geojson: FeatureCollection;
  readonly truncated: boolean;
}
let cache: CachedResponse | null = null;

/** Request-identity token; a response is dropped if the module moved on, belt to the abort signal's braces. */
let requestSeq = 0;

/** The attached `moveend` refresh handler while the layer is active. */
let moveendHandler: (() => void) | null = null;

/** Pending debounce timer for the viewport refresh. */
let refreshTimer: number | null = null;

/**
 * The status last applied for genuinely rendered data (`ready`, `degraded`,
 * or `no-data`), so a re-query that fails can restore the honest status of
 * whatever is still on the map (design clause 4) instead of stranding the
 * pill at `loading` or overclaiming `error` over data that is still good for
 * this view. Mirrors aiannh.ts's `lastAppliedStatus`.
 */
let lastAppliedStatus: Extract<NifcStatus, 'ready' | 'degraded' | 'no-data'> | null = null;

/**
 * The layer's most recently loaded collection and the envelope it covers,
 * read-only (DDM-P1-T06). DDM-P14-T07's first reader: the minimap's
 * per-region wildfire counts apply their declared `attr_ActiveFireCandidate`
 * predicate client-side against this collection instead of issuing their
 * own service query. A `null` envelope means the collection came from the
 * unscoped national fallback (`resolveQueryEnvelope` found no `getBounds`)
 * and therefore covers every view. Returns `null` before any successful load.
 * `truncated` travels with the collection (S30D block 1): a reader that
 * states an absence or a count checks it on the same snapshot, never the
 * layer status read before an await, which a refresh can change in between.
 */
let lastLoaded: {
  readonly collection: FeatureCollection;
  readonly envelope: QueryEnvelope | null;
  readonly fetchedAt: number;
  readonly truncated: boolean;
} | null = null;

export function loadedNifcCollection(): {
  readonly collection: FeatureCollection;
  readonly envelope: QueryEnvelope | null;
  readonly fetchedAt: number;
  readonly truncated: boolean;
} | null {
  return lastLoaded;
}

// ---------------------------------------------------------------------------
// The time statement (DDM-P8-T02)
// ---------------------------------------------------------------------------

/** True while the perimeters source is on the map (set by activate, cleared
 * by deactivate), so the vacancy listener below can never install a stamp
 * for a layer that is off. */
let timeBarEligible = false;
/** Disposer for the vacancy subscription; armed on activate. */
let unsubscribeTimeBar: (() => void) | null = null;
let freshnessState: 'current' | 'stale' | 'loading' | 'unavailable' = 'loading';
let freshnessTimer: ReturnType<typeof setTimeout> | null = null;
const CURRENT_CHECK_WINDOW_MS = 5 * 60 * 1000;

/**
 * The perimeter stamp, the Wildfire screen's time statement at the current
 * horizon (acceptance clause 4: the product is undated). WFIGS publishes
 * its current perimeters as one rolling set with no product-level valid
 * time: the service is checked about every five minutes and each perimeter
 * carries its own discovery date, which the popup states. The stamp says
 * exactly that. It does not print the retrieval clock as if it were a
 * product date, and it infers no perimeter age from the refresh cadence
 * (the module header's rule).
 *
 * OWNERSHIP. This is an event layer, not a condition surface, and the
 * wildfire cluster's current recipe has no surface at all (perimeters plus
 * smoke over the basemap), so nothing else would speak for the map's time
 * there. A surface still outranks it: the stamp installs only while no
 * surface owns the bar, and re-installs when a surface vacates it (the
 * horizon flip back from the SPC Day 1 outlook to the current recipe).
 */
function installPerimeterTimeBar(): void {
  if (!timeBarEligible) return;
  const owner = timeBarOwner();
  if (owner !== null && owner !== LAYER_KEY) return;
  setTimeBar(LAYER_KEY, {
    ariaLabel: 'NIFC mapped fire perimeters time statement',
    stamp: {
      horizon: 'current',
      headline: 'Current perimeters · no single valid time',
      detail:
        'NIFC WFIGS current interagency perimeters · the service states no product date and each perimeter carries its own discovery date.' +
        // M12 repair (found-015, R5 a): the browser-check date reads through
        // `dateTok` (month-name form) instead of `toLocaleString`'s locale-
        // and numeric-format date, the same token the time door's own dates
        // use.
        (lastLoaded ? ` Last successful browser check: ${dateTok(lastLoaded.fetchedAt)}. The current indicator describes this feed check, not the age of every perimeter.` : ''),
      register: 'observed',
      freshness: {
        state: freshnessState,
        checkedAt: lastLoaded ? new Date(lastLoaded.fetchedAt).toISOString() : null
      }
    }
  });
}

function armTimeBar(): void {
  timeBarEligible = true;
  if (!unsubscribeTimeBar) {
    unsubscribeTimeBar = onTimeBarSpecChange(() => {
      // A surface cleared the bar while these perimeters are still on the
      // map: the time statement falls back to the perimeters.
      if (timeBarEligible && getTimeBarSpec() === null) installPerimeterTimeBar();
    });
  }
  installPerimeterTimeBar();
}

function disarmTimeBar(): void {
  if (freshnessTimer !== null) clearTimeout(freshnessTimer);
  freshnessTimer = null;
  freshnessState = 'loading';
  timeBarEligible = false;
  if (unsubscribeTimeBar) {
    unsubscribeTimeBar();
    unsubscribeTimeBar = null;
  }
  clearTimeBar(LAYER_KEY);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Build the GeoJSON query URL. `where=1=1` still names no attribute filter
 * (every active perimeter within the spatial filter below matches), `outSR`
 * pins EPSG:4326 so MapLibre receives lon/lat regardless of a server default
 * change, and the field list plus the generalization parameters keep the
 * response inside the 15 s budget (see the module header and
 * NIFC_OUT_FIELDS). A non-null `envelope` (DDM-P1-T06) adds the ESRI
 * envelope spatial filter that scopes the scan to the current view; `null`
 * (a map double with no `getBounds`) keeps the pre-DDM-P1-T06 national scan.
 */
function buildQueryUrl(envelope: QueryEnvelope | null): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: NIFC_OUT_FIELDS.join(','),
    outSR: '4326',
    geometryPrecision: String(NIFC_GEOMETRY_PRECISION),
    maxAllowableOffset: String(NIFC_MAX_ALLOWABLE_OFFSET_DEG),
    f: 'geojson'
  });
  if (envelope) {
    params.set('geometry', envelope.map((n) => n.toFixed(5)).join(','));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  return `${URLS.nifcFires}/query?${params.toString()}`;
}

/**
 * Add the five fill/outline style layers, once. Unlike the pre-DDM-P1-T06
 * layer, these are added even for a zero-feature response: the while-active
 * viewport refresh swaps data into the EXISTING source with `setData`, so a
 * view that starts empty (no fires in the default Washington view, say)
 * must still have layers ready for the perimeters a later pan brings in
 * (aiannh.ts's addSourceAndLayers carries the same reasoning).
 */
function ensureLayersAdded(map: maplibregl.Map): void {
  if (map.getLayer(FILL_LAYER_ID)) return;
  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('wildfire'),
      paint: buildNifcFillPaint('wildfire')
    },
    beforeId
  );

  map.addLayer(
    {
      id: OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('wildfire'),
      paint: buildNifcLinePaint('wildfire')
    },
    beforeId
  );

  map.addLayer(
    {
      id: PRESCRIBED_FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('prescribed'),
      paint: buildNifcFillPaint('prescribed')
    },
    beforeId
  );

  map.addLayer(
    {
      id: PRESCRIBED_OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('prescribed'),
      paint: buildNifcLinePaint('prescribed')
    },
    beforeId
  );

  map.addLayer(
    {
      id: OTHER_OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('other'),
      paint: buildNifcLinePaint('other')
    },
    beforeId
  );
}

/**
 * Apply a validated FeatureCollection to the map: `setData` into the
 * existing source (a cache hit or a re-query) or add the source and layers
 * (first render). Empty features report `'no-data'` rather than an error
 * since "no active fires in this view" is a legitimate (if rare) result;
 * `truncated` reports `'degraded'` ("live (partial)") regardless of count.
 * Starts or stops the wildfire pulse per the CURRENT batch, since a
 * re-query can gain or lose every wildfire perimeter the prior one had.
 */
function applyFeatureCollection(
  map: maplibregl.Map,
  geojson: FeatureCollection,
  opts: { truncated?: boolean } = {}
): void {
  const features = geojson.features ?? [];
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(geojson);
  } else {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: geojson,
      attribution: 'NIFC WFIGS'
    });
    // The source is on the map from here on, perimeters or none: the time
    // statement stands for both (an empty current set is still the product).
    armTimeBar();
  }

  ensureLayersAdded(map);

  const hasWildfirePerimeter = features.some(
    (feature) =>
      classifyNifcIncidentType(
        feature.properties?.[NIFC_INCIDENT_TYPE_PROPERTY]
      ) === 'wildfire'
  );
  if (hasWildfirePerimeter) {
    startWildfirePulse(map);
  } else {
    stopWildfirePulse();
  }

  if (features.length > 0) {
    showLegend(LAYER_KEY, {
      order: LEGEND_ORDER.event + 1,
      render: (body) =>
        renderSwatchLegend(
          body,
          'Mapped fire perimeters',
          [
            {
              color: NIFC_INCIDENT_PRESENTATION.wildfire.lineColor,
              label: NIFC_INCIDENT_PRESENTATION.wildfire.legendLabel
            },
            {
              color: NIFC_INCIDENT_PRESENTATION.prescribed.lineColor,
              label: NIFC_INCIDENT_PRESENTATION.prescribed.legendLabel
            },
            {
              color: NIFC_INCIDENT_PRESENTATION.other.lineColor,
              label: NIFC_INCIDENT_PRESENTATION.other.legendLabel
            }
          ],
          `NIFC WFIGS current interagency mapped perimeters. ${NIFC_GENERALIZATION_NOTE} Service cadence does not establish individual perimeter age. Not for evacuation, parcel, or tactical decisions; open NIFC for the source record.`
        )
    });
  }

  if (opts.truncated) {
    console.warn(
      '[nifc-fires] WFIGS response reached the ArcGIS transfer limit; rendering available perimeters as live (partial).'
    );
  }

  lastAppliedStatus = opts.truncated ? 'degraded' : features.length === 0 ? 'no-data' : 'ready';
  reportStatus(lastAppliedStatus);
}

/**
 * Fetch the WFIGS perimeters for the current viewport envelope and apply
 * them, or reuse the coverage cache with no network call (design clause 3).
 * Shared by `activate` and the `moveend` refresh. A cache hit or a request
 * failure over a still-covering cache never reports `'no-data'` on the
 * strength of a response that never answered for this view (design clauses
 * 1, 2, and 4).
 */
async function fetchAndApply(map: maplibregl.Map): Promise<void> {
  // Supersede any prior in-flight fetch FIRST, before the cache lookup, so a
  // cache hit also owns the newest request identity: an older network
  // response must never land over a newer cached view (aiannh.ts:427-436's
  // Codex Unit B finding 2, 2026-07-15; the same race resurfaced here in
  // DDM-P1-T06 director review, 2026-09-12: a far jump's in-flight fetch
  // could otherwise land after a pan back inside the still-cached prior
  // envelope was already served from cache, painting the far view's data
  // and status over the near one and replacing `cache`/`lastLoaded` with
  // it; proven red then green by
  // tests/nifc-query-scope.spec.ts's "a pan back inside the still-cached
  // envelope..." case).
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  const token = ++requestSeq;

  const envelope = resolveQueryEnvelope(map);

  if (envelope && cache && envelopeCovers(cache.envelope, map) &&
    lastLoaded && Date.now() - lastLoaded.fetchedAt < CURRENT_CHECK_WINDOW_MS) {
    freshnessState = 'current';
    applyFeatureCollection(map, cache.geojson, { truncated: cache.truncated });
    return;
  }

  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');
  freshnessState = 'loading';
  armTimeBar();

  let geojson: FeatureCollection;
  let truncated = false;
  try {
    const parsed = parseArcGisPolygonFeatureCollection(
      await fetchJsonWithBudget(
        buildQueryUrl(envelope),
        null,
        signal,
        FETCH_TIMEOUT_MS
      ),
      'NIFC WFIGS'
    );
    geojson = parsed.collection;
    truncated = parsed.truncated;
  } catch (err) {
    // Aborted or superseded means a newer request owns the view; drop it
    // silently per invariant 5.
    if (signal.aborted || token !== requestSeq) return;
    console.warn('[nifc-fires] WFIGS perimeters fetch failed.', err);
    freshnessState = lastLoaded ? 'stale' : 'unavailable';
    installPerimeterTimeBar();
    if (envelope && cache && envelopeCovers(cache.envelope, map)) {
      // The last covering collection is still honest for this view (design
      // clause 4): restore its status rather than stranding the pill at
      // 'loading' or overclaiming 'error' over data that is still good.
      if (lastAppliedStatus) reportStatus(lastAppliedStatus);
    } else {
      reportStatus('error');
    }
    return;
  }

  // A late response to a superseded or torn-down request must not render.
  if (signal.aborted || token !== requestSeq) return;

  const coverageEnvelope = envelope ? toCoverageEnvelope(envelope) : null;
  cache = coverageEnvelope ? { envelope: coverageEnvelope, geojson, truncated } : null;
  lastLoaded = { collection: geojson, envelope: coverageEnvelope, fetchedAt: Date.now(), truncated };
  freshnessState = 'current';
  if (freshnessTimer !== null) clearTimeout(freshnessTimer);
  freshnessTimer = setTimeout(() => {
    freshnessTimer = null;
    freshnessState = 'stale';
    installPerimeterTimeBar();
  }, CURRENT_CHECK_WINDOW_MS);
  applyFeatureCollection(map, geojson, { truncated });
  installPerimeterTimeBar();
}

/**
 * Attach the debounced while-active viewport refresh (DDM-P1-T06,
 * aiannh.ts's precedent). Guarded so repeated `activate` calls never stack
 * handlers, and so a map double without `on` (a direct unit-test call) is
 * left exactly as it behaved before this task (the same allowance
 * `WildfirePulseController` makes for `map.on`/`map.off`).
 */
function attachRefresh(map: maplibregl.Map): void {
  if (moveendHandler || typeof map.on !== 'function') return;
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
    if (typeof map.off === 'function') map.off('moveend', moveendHandler);
    moveendHandler = null;
  }
}

/**
 * Fetch the NIFC fires for the current viewport envelope, add the source
 * and layers, and start the while-active viewport refresh (DDM-P1-T06).
 * Idempotent: if the source already exists the call only (re)ensures the
 * refresh handler, so the URL-restore path cannot stack duplicates.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  attachRefresh(map);
  if (map.getSource(SOURCE_ID)) {
    return;
  }
  await fetchAndApply(map);
}

/**
 * Synchronous cancellation seam: aborts any in-flight fetch immediately, the
 * moment off intent is recorded, before the serialized teardown op reaches
 * this module (the cancellation invariant). Map state (sources/layers)
 * remains `deactivate`'s job; this hook can be followed by a rapid on
 * intent that skips queued map teardown, so stopping animation here without
 * a matching resume hook would strand an otherwise active layer, which is
 * why that teardown stays in `deactivate`.
 */
export function cancelActivation(): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  // Invalidate any response that already raced past its abort check.
  requestSeq++;
}

export function deactivate(map: maplibregl.Map): void {
  stopWildfirePulse();
  detachRefresh(map);
  cancelActivation();
  cache = null;
  lastLoaded = null;
  lastAppliedStatus = null;
  disarmTimeBar();
  for (const id of [
    OTHER_OUTLINE_LAYER_ID,
    PRESCRIBED_OUTLINE_LAYER_ID,
    PRESCRIBED_FILL_LAYER_ID,
    OUTLINE_LAYER_ID,
    FILL_LAYER_ID
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
  hideLegend(LAYER_KEY);
}

/**
 * Resolve the most useful incident name from the WFIGS attribute schema.
 * `attr_IncidentName` is canonical, `poly_IncidentName` is the geometry
 * source's name (sometimes more specific), and `IncidentName` and
 * `incidentName` are legacy field names that the scoped query no longer
 * requests (kept for stub fixtures and older responses). Returns a neutral mapped-perimeter label if every candidate
 * is blank.
 */
function pickIncidentName(props: GeoJsonProperties): string {
  const p = props ?? {};
  // Fall through on blank strings, not only on null/undefined: the IRWIN
  // record (`attr_*`) and the perimeter collector (`poly_*`) can disagree,
  // and a present-but-empty `attr_IncidentName` must not mask a real name
  // in `poly_IncidentName`.
  for (const candidate of [p.attr_IncidentName, p.poly_IncidentName, p.IncidentName, p.incidentName]) {
    if (candidate === null || candidate === undefined) continue;
    const s = String(candidate).trim();
    if (s !== '') return s;
  }
  return 'Mapped Fire Perimeter';
}

/** The frame's explanation for issuer time text DDM does not parse (PF1; the M25 builders' wording). */
const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';

/** Hectares per acre (grouping-contract.md section 4, "Conversion shown"). */
const HECTARES_PER_ACRE = 0.40468564224;

/** A finite number from a WFIGS numeric field, or null for a missing, blank or non-numeric value. */
function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(num) ? num : null;
}

/** Whole units, thousands-separated (sub-acre precision exceeds typical perimeter accuracy). */
function wholeUnits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * A WFIGS size field in its issuer unit (acres) first, with the "about"
 * hectare conversion rounded to whole units (grouping-contract.md 12.1 slot
 * 3), under the field's own name; null when the field carries no size.
 */
function sizeRow(label: string, value: unknown): RecordSize | null {
  const acres = finiteNumber(value);
  if (acres === null) return null;
  return { label, text: `${wholeUnits(acres)} acres (about ${wholeUnits(acres * HECTARES_PER_ACRE)} ha)` };
}

/**
 * The discovery time as the WFIGS date field states it: epoch milliseconds
 * read as a UTC instant (the zone named; the old popup cut it to its UTC
 * date). A missing, blank or non-text, non-numeric value is absent (null);
 * other text is shown as supplied, never silently dropped (PF1).
 */
function discoveredClock(value: unknown): PopupClock | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const ms = finiteNumber(value);
  if (ms !== null && new Date(ms).getUTCFullYear() >= 1000) {
    return { kind: 'point', meaning: 'discovered', label: 'Discovered', at: { precision: 'instant', at: ms, zone: 'UTC' } };
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return { kind: 'point', meaning: 'discovered', label: 'Discovered', at: { precision: 'supplied', text: String(value), explanation: SUPPLIED_TIME_EXPLANATION } };
}

/** The class the map draws the perimeter as (DDM-UI-006), with its own swatch. */
function classSwatch(value: unknown): IssuerSwatch {
  const cls = classifyNifcIncidentType(value);
  const color =
    cls === 'wildfire'
      ? NIFC_INCIDENT_PRESENTATION.wildfire.fillColor
      : cls === 'prescribed'
        ? NIFC_INCIDENT_PRESENTATION.prescribed.fillColor
        : NIFC_INCIDENT_PRESENTATION.other.lineColor;
  return { table: 'NIFC_INCIDENT_PRESENTATION', classKey: cls, color };
}

/** The record's text field, trimmed, or null when missing or blank. */
function textField(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * The record key (grouping-contract.md section 4): the UniqueFireIdentifier
 * trimmed and uppercased; else the IRWIN id, braces removed and lowercased,
 * as `nifc:irwin:<guid>`. A record that carries neither (a stub) has no
 * key across responses: names and OBJECTIDs are never keys (item 3 and
 * section 5.1), so the stub is keyed on its feature id inside this one
 * response (section 4's "key plus OBJECTID within one response") under a
 * prefix that says it is unkeyed, `nifc:unkeyed:<id>`, or `nifc:unkeyed`
 * when the response gives the feature no id. Section 5.2's
 * `nifc:geom:<hash>` is the grouping read's key over its generalized
 * coordinates; a clicked feature carries only its tile-clipped rendering.
 */
function recordKey(ufi: string | null, irwin: string | null, featureId: string | number | undefined): string {
  if (ufi !== null) return `nifc:${ufi.toUpperCase()}`;
  if (irwin !== null) return `nifc:irwin:${irwin.replace(/[{}]/g, '').toLowerCase()}`;
  const id = typeof featureId === 'number' ? (Number.isFinite(featureId) ? String(featureId) : '') : (featureId ?? '').trim();
  return id === '' ? 'nifc:unkeyed' : `nifc:unkeyed:${id}`;
}

/**
 * The mapped NIFC perimeter's popup model (S30D D1 M26a; DDM-P11-T04;
 * interface-chrome-popups-text.md 3.4 and 3.5 row 7): an event head (the
 * incident name, the issuer, the class the map draws with its swatch, the
 * discovery time, NIFC Open Data), then ONE record block (grouping-contract
 * 12.1) that names each size field, the fire-in-context rows with their own
 * issuer and clock, and the existing notes. No status word is printed: the
 * NIFC status wording waits on its ddm-cite verdict (D1.md:429), and the
 * popup printed none before. `featureId` is the clicked feature's id inside
 * its response, read only to key a record with no identifier (`recordKey`).
 */
export function buildNifcPopupModel(
  props: GeoJsonProperties,
  context: FireContext,
  retrievedAt: number | null,
  featureId?: string | number
): IssuedModel {
  const p = props ?? {};
  const incidentName = pickIncidentName(p);
  const ufi = textField(p.attr_UniqueFireIdentifier);
  const irwin = textField(p.attr_IrwinID);
  const stateRaw = p.attr_POOState;
  // POOState arrives as `US-XX`; trim the prefix for readable display.
  const state =
    typeof stateRaw === 'string' && stateRaw.startsWith('US-') ? stateRaw.slice(3) : textField(stateRaw) ?? '';

  const discovered = discoveredClock(p.attr_FireDiscoveryDateTime);
  // The layer's last successful browser check (the time bar's own words),
  // in the viewer's zone, named.
  const retrieved: PopupClock | null =
    retrievedAt === null
      ? null
      : {
          kind: 'point',
          meaning: 'retrieved',
          label: 'Last successful browser check',
          at: { precision: 'instant', at: retrievedAt, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
        };
  const present = [discovered, retrieved].filter((c): c is PopupClock => c !== null);
  const [firstPresent, ...laterPresent] = present;
  const recordClocks: readonly [PopupClock, ...PopupClock[]] =
    firstPresent === undefined ? [{ kind: 'not-stated', label: 'Discovered', reason: 'unavailable' }] : [firstPresent, ...laterPresent];

  const record: RecordBlock = {
    key: recordKey(ufi, irwin, featureId),
    issuer: 'nifc',
    identifier: ufi ?? incidentName,
    ...(ufi === null ? {} : { name: incidentName }),
    sizes: [sizeRow('Reported size', p.attr_IncidentSize), sizeRow('Mapped perimeter area', p.poly_GISAcres)].filter(
      (row): row is RecordSize => row !== null
    ),
    clocks: recordClocks,
    links: []
  };

  const details: PopupDetail[] = [];
  if (state !== '') details.push({ kind: 'row', label: 'State', text: state });
  details.push(...context.details);

  return {
    kind: 'event',
    title: incidentName,
    issuer: { role: 'issued-by', name: 'NIFC WFIGS (United States)', productKey: 'nifc-fires' },
    value: [{ text: nifcIncidentTypeLabel(p.attr_IncidentTypeCategory), swatch: classSwatch(p.attr_IncidentTypeCategory) }],
    // The head keeps the first present clock (the discovery time where the
    // record states one); the record block carries every clock.
    clocks: [recordClocks[0]],
    conditions: [context.drought],
    details,
    records: [record],
    source: { link: { label: 'NIFC Open Data', href: 'https://data-nifc.opendata.arcgis.com/' } },
    moreLinks: [{ label: 'InciWeb', href: 'https://inciweb.wildfire.gov/' }],
    qualifications: [
      'Perimeter sourced from the National Interagency Fire Center (NIFC) Wildland Fire Interagency Geospatial Services (WFIGS) feed. The service is checked for updates approximately every five minutes during active operations; individual perimeter age can differ.',
      NIFC_GENERALIZATION_NOTE,
      'Strategic context only, not tactical fire operations, evacuation, or parcel decisions.',
      context.note
    ]
  };
}

/**
 * Register the perimeter fill's click target with the
 * InteractionCoordinator (one response per click; D-0.7.0-058 ruling 5).
 * Cursor affordance switches to pointer on hover so users see that
 * perimeters are interactive.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [FILL_LAYER_ID, PRESCRIBED_FILL_LAYER_ID, OTHER_OUTLINE_LAYER_ID],
    label: (feature) => pickIncidentName(feature.properties ?? {}),
    // B1 fire-in-context: the incident metadata, then a composed read of the
    // drought class beneath the clicked point and the nearest telemetry
    // stations. The context rows compose existing surfaces only; they do not
    // compute a fire outlook or combine the sources into a risk class.
    respond: (feature, click, m) => ({
      model: buildNifcPopupModel(
        feature.properties ?? {},
        readFireContext(m, click.point, click.lngLat),
        lastLoaded?.fetchedAt ?? null,
        // The feature's id inside this response (ArcGIS writes OBJECTID):
        // the stub record's response-scoped key, never a cross-response one.
        feature.id
      )
    })
  });

  for (const id of [FILL_LAYER_ID, PRESCRIBED_FILL_LAYER_ID, OTHER_OUTLINE_LAYER_ID]) {
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}
