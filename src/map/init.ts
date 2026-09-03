import * as maplibregl from 'maplibre-gl';
// Vite's `?worker&url` form: the worker and the shared chunk it imports
// (`maplibre-gl-shared.mjs`) are bundled into ONE emitted asset and this
// import resolves to that asset's URL. A plain `?url` would copy
// `maplibre-gl-worker.mjs` alone without following its import, and the
// shared chunk would 404 on a static host. `vite.config.ts` sets
// `base: './'`, so the emitted URL stays relative and works both at a
// domain root and at the `/dynamic-drought-module/` project subpath.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import { buildBaseStyle } from './style';
import { BasemapSwitcherControl } from './basemap-switcher';
import { MAP_MIN_ZOOM } from '../config/regions';
import { watchDesktopMapSeat } from '../ui/map-control-seat';

/**
 * Register the PMTiles protocol with MapLibre exactly once, so any source
 * declared with a `pmtiles://` URL (the ecoregion vector bundle, and the
 * Phase D landscape bundles to come) resolves through HTTP Range Requests
 * against the static archive. PMTiles is an open, single-file tile format
 * and a sanctioned data path for this project; the protocol handler is
 * client-side only and adds no backend. Guarded because `addProtocol` throws
 * if the same scheme is registered twice (a hot-reload hazard in dev).
 */
let pmtilesRegistered = false;
function registerPmtilesProtocol(): void {
  if (pmtilesRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  pmtilesRegistered = true;
}

/**
 * Point MapLibre at its bundled worker, exactly once, before any map is
 * constructed.
 *
 * MapLibre 6 is ESM-only and resolves its worker from `import.meta.url`,
 * which does not reliably point at the worker file inside a bundler's
 * module graph, so every bundled consumer owes one `setWorkerUrl()` call
 * (v5-to-v6 migration guide). This is a runtime registration, not a build
 * option, so it belongs here beside `addProtocol` rather than in
 * `vite.config.ts`. Guarded like the protocol registration so a dev
 * hot-reload cannot re-enter it.
 */
let workerUrlRegistered = false;
function registerWorkerUrl(): void {
  if (workerUrlRegistered) return;
  maplibregl.setWorkerUrl(maplibreWorkerUrl);
  workerUrlRegistered = true;
}

/**
 * Default initial view. The Pacific Northwest (PNW) center sits over the
 * Cascades; the same point as the vanilla Leaflet baseline's `[47, -121]`
 * but expressed in MapLibre's `[longitude, latitude]` order.
 */
const DEFAULT_CENTER: [number, number] = [-121, 47];
const DEFAULT_ZOOM = 7;
// U4a: the zoom floor moved to src/config/regions.ts (MAP_MIN_ZOOM) so the
// whole-US fit invariant is testable in Node; see the rationale there.
const DEFAULT_MIN_ZOOM = MAP_MIN_ZOOM;
const DEFAULT_MAX_ZOOM = 14;

/**
 * Camera pitch ceiling, degrees (FIRE-12). MapLibre's default ceiling is 60,
 * which is exactly `FIRE3D_PITCH_DEGREES` (src/config/fire3d-presentation.ts),
 * so the 3D scene used to open pinned at the maximum and a user could not tilt
 * further to read relief. 85 is MapLibre's own upper bound. This raises only
 * the ceiling: the flat map still opens at pitch 0, the 3D mode still eases to
 * its own ruled 60, and leaving 3D still restores the pitch the user had
 * before. Nothing in `src/` or `tests/` reads a 60-degree ceiling.
 */
const DEFAULT_MAX_PITCH = 85;

/**
 * Maximum width in CSS pixels of each scale control. The paired imperial and
 * metric bars keep both common measurement systems visible at once.
 */
const SCALE_MAX_WIDTH_PX = 160;

/**
 * Create and return the MapLibre GL JavaScript map instance.
 *
 * The caller (`src/main.ts`) is responsible for waiting on `map.on('load')`
 * before activating layers, fitting region bounds, or wiring popups. This
 * function deliberately does no further wiring so that initialization
 * stays a single, side-effect-light call.
 *
 * Open-data invariant: no proprietary tile providers are configured. The
 * base style uses a subdued OpenStreetMap base (see `buildBaseStyle()`);
 * recent NOAA GeoColor is the default satellite context.
 */
export function createMap(containerId: string): maplibregl.Map {
  registerPmtilesProtocol();
  registerWorkerUrl();

  // atni-geobase: map-initialization seam. A 3D geospatial baseline (the
  // ATNI-GeoBase T0 terrain layer) attaches HERE and at the terrain-source
  // seam in src/map/style.ts, with no other DDM surface involved: enabling
  // 3D is `map.setPitch(..)` plus `map.setTerrain({ source: <raster-dem> })`
  // after this constructor returns. The lightest honest option is MapLibre's
  // native terrain over a LOCAL raster-dem source (no cloud terrain
  // dependency), which is also the GeoBase Light Engine's own render path,
  // so the seam and GeoBase converge on one stack.
  //
  // The options are built as a local first because ONE of them has to carry
  // an explicit `undefined` (see `zoomLevelsToOverscale` below). MapLibre 6
  // resolves options as `{ ...defaults, ...options }`, so the KEY must be
  // present for the default to be overridden, while `exactOptionalPropertyTypes`
  // forbids writing `undefined` into an optional `number` field. The widened
  // local plus one narrow cast at the constructor is the smallest honest way
  // to say that; nothing else about the options is loosened.
  const options: Omit<maplibregl.MapOptions, 'zoomLevelsToOverscale'> & {
    readonly zoomLevelsToOverscale: number | undefined;
  } = {
    container: containerId,
    style: buildBaseStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    minZoom: DEFAULT_MIN_ZOOM,
    maxZoom: DEFAULT_MAX_ZOOM,
    maxPitch: DEFAULT_MAX_PITCH,
    // Restore MapLibre 5's query behavior (v5-to-v6 migration guide's own
    // escape hatch). Version 6 defaults `zoomLevelsToOverscale` to 4, which
    // changes WHICH features come back from the 13 `queryRenderedFeatures`
    // call sites in `src/` at a given pixel: 7 point-or-box queries that
    // arbitrate clicks, hover, and popup identity, and 5 viewport-wide
    // queries that drive the displayed counts in the conditions strip. With
    // `undefined` the renderer upgrade changes the renderer and nothing
    // else. Adopting the new default is a separate, visible change with its
    // own verification, not a side effect of the version bump.
    zoomLevelsToOverscale: undefined,
    // The explicit control below is the single attribution surface; without
    // this flag the constructor adds its own default control and the two
    // stack as duplicate bars in the corner.
    attributionControl: false
  };
  const map = new maplibregl.Map(options as maplibregl.MapOptions);

  // The license credits (owner direction, 2026-08-31, superseding the
  // 2026-08-19 two-circle corner): no MapLibre attribution control in any
  // shell. Every source still declares its attribution string at addSource
  // time, and the map-information disclosure (the round question-mark
  // button, src/ui/map-information.ts) renders those live strings as its
  // credits line, one tap away at every viewport size, embeds included.
  map.addControl(
    new maplibregl.ScaleControl({
      unit: 'imperial',
      maxWidth: SCALE_MAX_WIDTH_PX
    })
  );
  map.addControl(
    new maplibregl.ScaleControl({
      unit: 'metric',
      maxWidth: SCALE_MAX_WIDTH_PX
    })
  );
  // The basemap switcher (U4d): recent NOAA context is one tap away from the
  // standard base. Present in embeds too; `basemap=` is durable
  // URL state and an embedding site may pin it in its iframe src.
  // BOTTOM-right is MapLibre's seat and stays the home for embeds and the
  // phone shell (whose CSS lifts this same control into the thumb zone
  // without duplicating its store, URL, or lazy Satellite behavior).
  map.addControl(new BasemapSwitcherControl(), 'bottom-right');

  // On the desktop shell the same control moves into the app's top-right
  // column beneath Reset (owner direction, 2026-08-19), which is where the
  // E2 ruling already said the three map buttons belong as one family. The
  // node moves; its listeners, aria-pressed state, and store subscription
  // ride along.
  seatBasemapSwitcherOnDesktop(map);

  return map;
}

/**
 * Move the satellite control between MapLibre's bottom-right corner and the
 * app's top-right control column as the presentation changes. Returns
 * silently when either seat is missing, so a host page that trims the
 * overlay markup simply keeps MapLibre's own placement.
 */
function seatBasemapSwitcherOnDesktop(map: maplibregl.Map): void {
  const node = map
    .getContainer()
    .querySelector<HTMLElement>('.basemap-switcher-control');
  const host = document.getElementById('basemap-switcher-overlay-host');
  const corner = map
    .getContainer()
    .querySelector<HTMLElement>('.maplibregl-ctrl-bottom-right');
  if (!node || !host || !corner) return;
  watchDesktopMapSeat({
    node,
    host,
    home: corner,
    placeHome: () => {
      if (node.parentElement !== corner) corner.appendChild(node);
    }
  });
}
