/**
 * Telemetry markers layer (port of vanilla `app.js` `renderTelemetryMarkers`,
 * with the v0.1.1 popup race-fix preserved).
 *
 * Each station in `TELEMETRY_STATIONS` becomes a `maplibregl.Marker` with a
 * small color-coded dot. Clicking a marker opens a `maplibregl.Popup` whose
 * static skeleton (title, agency, description, links) is rendered immediately
 * and whose live data slot (United States Geological Survey (USGS)
 * Instantaneous Values (IV) for `usgsSite` stations, an honest "not available
 * in-browser" message for Natural Resources Conservation Service (NRCS)
 * Air-Water Database (AWDB) Snow Telemetry (SNOTEL) stations) is hydrated
 * asynchronously.
 *
 * Critical port behavior preserved from v0.1.1:
 *   - Per-marker AbortController stored externally via `WeakMap` (MapLibre's
 *     `Marker` does not support arbitrary custom properties as cleanly as
 *     Leaflet's marker did).
 *   - The popup `close` event aborts the in-flight USGS fetch so a re-open
 *     within ~8 seconds does not race two fetches into a re-created slot.
 *   - `hydrateTelemetryPopupData(...)` and the internal USGS fetch thread the
 *     signal end-to-end; both check `signal.aborted` before writing into the
 *     slot.
 *   - Every interpolated value in the popup is escaped via `escapeHtml`; only
 *     `https://` URLs are rendered as anchors.
 *
 * Coordinates note: the `TelemetryStation.coords` tuple is `[latitude,
 * longitude]` to match the bounding-box convention used elsewhere in the
 * baseline. MapLibre expects `[longitude, latitude]`. The conversion happens
 * here at the boundary, not in the config table.
 *
 * Status reporting is `console.info` for now; M7 wires it through the
 * LayerRegistry alongside the other layer modules.
 */

import maplibregl from 'maplibre-gl';

import type { TelemetryFreshness, TelemetryStation } from '../types/station';
import {
  STATIC_TELEMETRY_STATION_REGISTRY,
  discoverStationsForViewport,
  mergeTelemetryStations,
  stationNetworkByKey
} from '../config/station-registry';
import type {
  PrimaryParameterCategory,
  StationRegistryEntry,
  ViewportBounds
} from '../types/station-network';
import {
  buildTelemetryPopupSkeleton,
  hydrateTelemetryPopupData
} from '../ui/popups';
import { registry } from '../state/registry';
import { prefersReducedMotion } from '../util/motion';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Active markers, in insertion order. `deactivate` walks this list to remove
 * markers from the map and aborts any pending hydrate fetches en route. We
 * keep it as a parallel structure to `markersByStationId` so flyToStation
 * can do an O(1) lookup without touching internal MapLibre state.
 */
const activeMarkers: maplibregl.Marker[] = [];
const markersByStationId = new Map<string, maplibregl.Marker>();
const stationByMarker = new WeakMap<maplibregl.Marker, TelemetryStation>();

/**
 * Per-marker AbortController. Stored externally (rather than as a custom
 * property on the marker, the way Leaflet's `marker._telemetryAbort` did) so
 * we do not type-pollute the upstream `maplibregl.Marker` interface and so
 * garbage collection of stale entries follows the marker's lifetime.
 */
const abortControllers = new WeakMap<maplibregl.Marker, AbortController>();

const LAYER_KEY = 'telemetry';
const MOVEEND_DEBOUNCE_MS = 350;
const DISCOVERED_STATION_RENDER_CAP = 50;
const EARTH_RADIUS_METERS = 6_371_000;
const CAP_NOTE_ID = 'telemetry-discovery-note';
// H2 (0.6.2, D-0.7.0-004): a compact count chip in the shared bottom dock;
// the full explanation lives in the sidebar Water & Snow panel. The old
// full-sentence banner permanently covered the time bar on the default view.
const CAP_NOTE_TEXT = 'Nearest {cap} of {total} stations shown';

type TelemetryStatus = 'loading' | 'ready' | 'error' | 'no-data' | 'zoom-in';

interface TelemetryMarkerView {
  readonly station: TelemetryStation;
  readonly freshness: TelemetryFreshness;
  readonly primaryParameterCategory: PrimaryParameterCategory;
  readonly networkLabel: string;
}

let currentDiscoveryController: AbortController | null = null;
let moveendDebounce: ReturnType<typeof setTimeout> | null = null;
let moveendHandler: (() => void) | null = null;

function reportStatus(state: TelemetryStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

// ---------------------------------------------------------------------------
// activate / deactivate / bindPopups
// ---------------------------------------------------------------------------

/**
 * Add a `maplibregl.Marker` for every station in `TELEMETRY_STATIONS`. Each
 * marker carries a `divIcon`-style HTML element rendered by the CSS rules
 * already shipped in `src/styles/app.css` (`.telemetry-marker` /
 * `.telemetry-marker-inner`).
 *
 * Idempotent: a second call while markers are still active is a no-op so the
 * registry can flip visibility without re-creating DOM nodes. Visibility
 * flipping for the markers themselves is currently a deactivate / activate
 * cycle; if M7's LayerRegistry needs cheaper visibility toggling we can move
 * each marker's `getElement()` to `display:none` instead.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (activeMarkers.length > 0) {
    // Already activated; treat as a successful re-add per the registry
    // contract.
    reportStatus('ready');
    return;
  }

  reportStatus('loading');

  ensureMoveendHandler(map);
  await runDiscoveryForCurrentViewport(map);
}

function renderStations(map: maplibregl.Map, views: readonly TelemetryMarkerView[]): void {
  clearMarkers();

  for (const view of views) {
    const { station } = view;
    const el = document.createElement('div');
    el.className = 'telemetry-marker';
    el.dataset.telemetryStationId = station.id;
    el.dataset.telemetryFreshness = view.freshness;
    el.dataset.telemetryCategory = view.primaryParameterCategory;
    const accessibleLabel = markerAccessibleLabel(view);
    el.title = accessibleLabel;
    el.setAttribute('aria-label', accessibleLabel);

    const inner = document.createElement('div');
    inner.className = 'telemetry-marker-inner';
    // station.color is a fixed palette value from the config; not user
    // input. Set via DOM property so the browser does the value
    // sanitization rather than us interpolating into an HTML string.
    inner.style.setProperty('--telemetry-marker-color', station.color);
    inner.style.background = station.color;
    el.appendChild(inner);

    // The element needs an explicit pixel size; the CSS uses
    // width/height: 100% on `.telemetry-marker-inner` so the inner div
    // fills whatever the wrapping marker element is.
    el.style.width = '16px';
    el.style.height = '16px';

    // TelemetryStation.coords is [lat, lng]; MapLibre wants [lng, lat].
    const [lat, lng] = station.coords;

    const popup = new maplibregl.Popup({
      maxWidth: '320px',
      closeButton: true,
      closeOnClick: true
    });

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([lng, lat])
      .setPopup(popup)
      .addTo(map);

    stationByMarker.set(marker, station);
    markersByStationId.set(station.id, marker);
    activeMarkers.push(marker);
  }

  bindPopups(map);
}

/**
 * Remove every active marker, abort any pending hydrate fetch, and clear the
 * tracking structures. Safe to call when never activated. Idempotent.
 *
 * The `map` parameter is reserved for future symmetry with the other layer
 * modules (which call `map.removeLayer` / `map.removeSource`); markers detach
 * via `Marker.remove()` so we do not need it today.
 */
export function deactivate(map: maplibregl.Map): void {
  if (moveendDebounce) {
    clearTimeout(moveendDebounce);
    moveendDebounce = null;
  }
  if (currentDiscoveryController) {
    currentDiscoveryController.abort();
    currentDiscoveryController = null;
  }
  if (moveendHandler) {
    map.off('moveend', moveendHandler);
    moveendHandler = null;
  }
  hideCapNote();
  clearMarkers();
}

function clearMarkers(): void {
  for (const marker of activeMarkers) {
    const controller = abortControllers.get(marker);
    if (controller) {
      controller.abort();
      abortControllers.delete(marker);
    }
    marker.remove();
  }
  activeMarkers.length = 0;
  markersByStationId.clear();
}

/**
 * Wire the per-popup open / close handlers that drive live data hydration.
 *
 * Called once at the end of `activate` (so each batch of fresh markers gets
 * its handlers in the same pass). Exported so a future caller could rebind
 * after replacing markers in place; today the only call site is `activate`.
 *
 * On `open`:
 *   1. Abort any prior controller for this marker (defensive; handles the
 *      "user opened, closed, reopened within ~8s" race the v0.1.1 review
 *      flagged).
 *   2. Create a fresh `AbortController` and stash it in the WeakMap.
 *   3. Set the popup HTML to the skeleton.
 *   4. Resolve the popup's DOM element and call `hydrateTelemetryPopupData`
 *      with the fresh signal.
 *
 * On `close`:
 *   1. Abort and clear the controller so any in-flight USGS fetch can no
 *      longer write into a slot that is about to be detached from the DOM.
 */
export function bindPopups(_map: maplibregl.Map): void {
  for (const marker of activeMarkers) {
    const station = stationByMarker.get(marker);
    if (!station) continue;
    const popup = marker.getPopup();
    if (!popup) continue;

    popup.on('open', () => {
      // Abort any prior in-flight fetch from a popup that the user opened
      // and dismissed quickly.
      const prior = abortControllers.get(marker);
      if (prior) prior.abort();

      const controller = new AbortController();
      abortControllers.set(marker, controller);

      popup.setHTML(buildTelemetryPopupSkeleton(station));

      // `getElement()` returns the popup's outer DOM container once the
      // popup is added to the map (which `marker.setPopup` + open guarantee).
      const container = popup.getElement();
      if (!container) return;
      void hydrateTelemetryPopupData(station, container, controller.signal);
    });

    popup.on('close', () => {
      const controller = abortControllers.get(marker);
      if (controller) {
        controller.abort();
        abortControllers.delete(marker);
      }
    });
  }
}

function ensureMoveendHandler(map: maplibregl.Map): void {
  if (moveendHandler) return;
  moveendHandler = (): void => {
    if (moveendDebounce) clearTimeout(moveendDebounce);
    moveendDebounce = setTimeout(() => {
      moveendDebounce = null;
      void runDiscoveryForCurrentViewport(map);
    }, MOVEEND_DEBOUNCE_MS);
  };
  map.on('moveend', moveendHandler);
}

async function runDiscoveryForCurrentViewport(map: maplibregl.Map): Promise<void> {
  if (currentDiscoveryController) currentDiscoveryController.abort();
  const controller = new AbortController();
  currentDiscoveryController = controller;
  reportStatus('loading');

  const curatedEntries = curatedTelemetryEntries();
  try {
    const result = await discoverStationsForViewport({
      bounds: viewportBounds(map),
      center: viewportCenter(map),
      signal: controller.signal
    });
    if (controller.signal.aborted || controller !== currentDiscoveryController) return;

    if (result.status === 'zoom-in') {
      const merged = mergeTelemetryStations(
        curatedEntries.map((entry) => entry.station),
        result.records
      );
      const capped = capDiscoveredStations(merged, viewportCenter(map));
      renderStations(map, capped.entries.map(markerViewForEntry));
      updateCapNote(map, capped.totalDiscovered);
      reportStatus('zoom-in');
      return;
    }

    const merged = mergeTelemetryStations(
      curatedEntries.map((entry) => entry.station),
      result.records
    );
    const capped = capDiscoveredStations(merged, viewportCenter(map));
    renderStations(map, capped.entries.map(markerViewForEntry));
    updateCapNote(map, capped.totalDiscovered);
    reportStatus(capped.entries.length > 0 ? 'ready' : 'no-data');
  } catch (err) {
    if (controller.signal.aborted || controller !== currentDiscoveryController) return;
    console.warn('[telemetry] station discovery failed.', err);
    renderStations(map, curatedEntries.map(markerViewForEntry));
    hideCapNote();
    reportStatus('error');
  }
}

function capDiscoveredStations(
  entries: readonly StationRegistryEntry[],
  center: readonly [number, number]
): { readonly entries: readonly StationRegistryEntry[]; readonly totalDiscovered: number } {
  const curated = entries.filter((entry) => entry.isCuratedSeed);
  const discovered = entries.filter((entry) => !entry.isCuratedSeed);
  const cappedDiscovered = discovered
    .map((entry) => ({
      entry,
      distance: distanceMeters(center, entry.station.coords)
    }))
    .sort((left, right) => {
      const byDistance = left.distance - right.distance;
      if (byDistance !== 0) return byDistance;
      return left.entry.station.id.localeCompare(right.entry.station.id);
    })
    .slice(0, DISCOVERED_STATION_RENDER_CAP)
    .map((item) => item.entry);

  return {
    entries: [...curated, ...cappedDiscovered],
    totalDiscovered: discovered.length
  };
}

function updateCapNote(map: maplibregl.Map, totalDiscovered: number): void {
  if (totalDiscovered <= DISCOVERED_STATION_RENDER_CAP) {
    hideCapNote();
    return;
  }
  const note = ensureCapNote(map);
  note.textContent = CAP_NOTE_TEXT.replace(
    '{cap}',
    String(DISCOVERED_STATION_RENDER_CAP)
  ).replace('{total}', totalDiscovered.toLocaleString('en-US'));
  note.hidden = false;
}

function ensureCapNote(map: maplibregl.Map): HTMLDivElement {
  const existing = document.getElementById(CAP_NOTE_ID);
  if (existing instanceof HTMLDivElement) return existing;
  const note = document.createElement('div');
  note.id = CAP_NOTE_ID;
  note.className = 'telemetry-discovery-note';
  note.hidden = true;
  // The shared bottom dock stacks notices above the time bar so they can
  // never overlap; fall back to the map container outside the app shell
  // (unit harnesses, future embeds without the dock).
  const dock = document.getElementById('map-notices');
  (dock ?? map.getContainer()).appendChild(note);
  return note;
}

function hideCapNote(): void {
  const note = document.getElementById(CAP_NOTE_ID);
  if (note) note.hidden = true;
}

function viewportBounds(map: maplibregl.Map): ViewportBounds {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth()
  };
}

function viewportCenter(map: maplibregl.Map): readonly [number, number] {
  const center = map.getCenter();
  return [center.lat, center.lng];
}

function curatedTelemetryEntries(): readonly StationRegistryEntry[] {
  return STATIC_TELEMETRY_STATION_REGISTRY;
}

function markerViewForEntry(entry: StationRegistryEntry): TelemetryMarkerView {
  return {
    station: entry.station,
    freshness: entry.values[0]?.freshness ?? 'unknown',
    primaryParameterCategory: entry.primaryParameterCategory,
    networkLabel: networkLabelForEntry(entry)
  };
}

function networkLabelForEntry(entry: StationRegistryEntry): string {
  if (entry.networks.length === 0) return entry.station.agency;
  return entry.networks.map((network) => stationNetworkByKey(network).label).join(', ');
}

function markerAccessibleLabel(view: TelemetryMarkerView): string {
  return `${view.station.name}. ${freshnessLabel(view.freshness)} telemetry from ${view.networkLabel}. Primary parameter: ${categoryLabel(view.primaryParameterCategory)}.`;
}

function freshnessLabel(freshness: TelemetryFreshness): string {
  switch (freshness) {
    case 'fresh':
      return 'Fresh';
    case 'stale':
      return 'Stale';
    case 'unavailable':
      return 'Unavailable';
    case 'unknown':
      return 'Unknown condition';
  }
}

function categoryLabel(category: PrimaryParameterCategory): string {
  return category.replace(/-/g, ' ');
}

function distanceMeters(
  a: readonly [number, number],
  b: readonly [number, number]
): number {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const rLat1 = radians(lat1);
  const rLat2 = radians(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// ---------------------------------------------------------------------------
// flyToStation (sidebar telemetry list integration; M8)
// ---------------------------------------------------------------------------

/**
 * Center the map on a station and open its popup. Called by the sidebar
 * telemetry list (M8) when a list item is clicked.
 *
 * The popup is opened on `moveend` rather than after a fixed `setTimeout`
 * because the v0.1.x review flagged the timeout approach as fragile (slow
 * machines or short fly-to durations could open the popup before the map
 * finished moving, causing autoPan to over-correct). MapLibre's `moveend`
 * fires once the camera has settled, regardless of duration.
 *
 * Uses `map.once` so a queued open does not survive a subsequent
 * `flyToStation` call to a different station.
 *
 * No-op if `stationId` is not in the active marker set.
 */
export function flyToStation(map: maplibregl.Map, stationId: string): void {
  const marker = markersByStationId.get(stationId);
  if (!marker) return;

  const lngLat = marker.getLngLat();
  const targetZoom = Math.max(map.getZoom(), 9);

  // Jump instead of flying for reduced-motion users (WCAG 2.3.3, #7).
  map.flyTo({
    center: [lngLat.lng, lngLat.lat],
    zoom: targetZoom,
    speed: 1.2,
    ...(prefersReducedMotion() ? { animate: false } : {})
  });

  map.once('moveend', () => {
    // Re-check that the marker still exists; a deactivate could have run
    // mid-flight (for example, the user toggled the layer off while the
    // animation was running).
    if (!markersByStationId.has(stationId)) return;
    marker.togglePopup();
  });
}
