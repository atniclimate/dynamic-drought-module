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

import { TELEMETRY_STATIONS } from '../config/telemetry';
import type { TelemetryStation } from '../types/station';
import {
  buildTelemetryPopupSkeleton,
  hydrateTelemetryPopupData
} from '../ui/popups';

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

type TelemetryStatus = 'loading' | 'ready' | 'error';

function reportStatus(state: TelemetryStatus): void {
  // Placeholder until M7 wires the LayerRegistry; matches the convention
  // used by the other layer modules.
  console.info('[telemetry]', state);
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

  for (const station of TELEMETRY_STATIONS) {
    const el = document.createElement('div');
    el.className = 'telemetry-marker';

    const inner = document.createElement('div');
    inner.className = 'telemetry-marker-inner';
    // station.color is a fixed palette value from the config; not user
    // input. Set via DOM property so the browser does the value
    // sanitization rather than us interpolating into an HTML string.
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
  reportStatus('ready');
}

/**
 * Remove every active marker, abort any pending hydrate fetch, and clear the
 * tracking structures. Safe to call when never activated. Idempotent.
 *
 * The `map` parameter is reserved for future symmetry with the other layer
 * modules (which call `map.removeLayer` / `map.removeSource`); markers detach
 * via `Marker.remove()` so we do not need it today.
 */
export function deactivate(_map: maplibregl.Map): void {
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

  map.flyTo({
    center: [lngLat.lng, lngLat.lat],
    zoom: targetZoom,
    speed: 1.2
  });

  map.once('moveend', () => {
    // Re-check that the marker still exists; a deactivate could have run
    // mid-flight (for example, the user toggled the layer off while the
    // animation was running).
    if (!markersByStationId.has(stationId)) return;
    marker.togglePopup();
  });
}
