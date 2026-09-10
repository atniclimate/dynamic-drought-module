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
 * Status reporting goes through the LayerRegistry (`registry.setStatus`)
 * alongside the other layer modules.
 */

import * as maplibregl from 'maplibre-gl';

import { adoptExternalResponse } from '../map/interaction-coordinator';
import type { TelemetryFreshness, TelemetryStation } from '../types/station';
import {
  STATIC_TELEMETRY_STATION_REGISTRY,
  STATION_MARKER_LEGEND,
  discoverStationsForViewport,
  mergeTelemetryStations,
  stationNetworkByKey,
  type RawsWindStationFields
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
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
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

type TelemetryStatus = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data' | 'zoom-in';

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

/**
 * Contribute the station marker key to the unified legend (0.7.0 H4,
 * D-0.7.0-007: "marker colors enter the legend registry"; no on-canvas
 * color goes unlabeled). The seven discovered-network colors are the
 * systematic encoding; curated featured stations keep their own colors, so
 * one muted note covers them rather than a per-station swatch dump.
 */
function showStationLegend(): void {
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.stations,
    render(body: HTMLElement): void {
      renderSwatchLegend(
        body,
        'Monitoring stations',
        STATION_MARKER_LEGEND,
        // DDM-P9-T06 fix F6 (opus-read.md), NEW bounded grant for this one
        // sentence only: the wind symbol had no legend entry anywhere. Not
        // added to `STATION_MARKER_LEGEND` itself (that table is a color
        // swatch list; a wind-direction convention does not fit its shape,
        // per the fix brief). "NIFC RAWS" and "the direction from which the
        // air is moving" are the issuer's own words (science verdict item 3,
        // NWCG PMS 426-3 / the FeatureServer's own field description); the
        // rest states a DDM display convention, not an issuer definition.
        'Featured stations keep their own marker colors; open a marker for its source. An arrow on a NIFC RAWS marker is that station\'s served wind: it points into the wind (the direction from which the air is moving), its length scales with the served speed, and the marker\'s popup carries the values and observation time.'
      );
    }
  });
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

    // DDM-P9-T06: a RAWS station's served wind rides on `station` itself
    // (src/config/station-registry.ts's `RawsWindStationFields`, cast on
    // both ends since `TelemetryStation` in types/station.ts is not owned
    // by this task). Every other network's station simply never carries
    // these properties, so this is a no-op for them: no glyph, no
    // interpolation, nothing drawn off a station's own point.
    //
    // `glyphEligibleWind` (below) is the ONE eligibility gate: a null,
    // missing, or unparseable field of ANY of the three (speed string,
    // direction string, numeric direction) means no glyph, per the
    // acceptance's "Station reported none" clause and fix F3 (opus-read.md:
    // an unparseable served direction, for example "VRB" or "calm", must
    // never fall back to an invented due-north rotation).
    const glyphWind = glyphEligibleWind(readRawsWindFields(station));

    // Fix F4 (opus-read.md): `buildRawsWindGlyph`'s own SVG carries
    // `pointer-events: none` (a hover target would intercept clicks meant
    // for the marker), so its `<title>` can never actually receive a hover
    // and show a tooltip; the browser resolves the hover to THIS element,
    // `.telemetry-marker`, whose `title` attribute is the one the acceptance's
    // "carrying the observation time in its title" clause needs. Appended,
    // not replaced, so the marker's base identity sentence is never lost.
    el.title = glyphWind
      ? `${accessibleLabel} ${buildRawsWindAccessibleName(glyphWind)}`
      : accessibleLabel;
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

    if (glyphWind) {
      // overflow stays visible on `.telemetry-marker` (no CSS rule says
      // otherwise), so an absolutely-positioned child sized past the
      // marker's own 16px box still renders in full; no src/styles/app.css
      // edit needed (that grant does not exist for this task).
      el.appendChild(buildRawsWindGlyph(glyphWind, station.color));
    }

    // TelemetryStation.coords is [lat, lng]; MapLibre wants [lng, lat].
    const [lat, lng] = station.coords;

    // U-UX-FIX-1 DEF-4 (triage 2026-07-24): a fixed 320px card can hang
    // past a narrow phone viewport with the close control off-screen.
    // The responsive cap keeps the card inside sub-344px viewports
    // natively; src/ui/popup-viewport.ts clamps the remaining anchor
    // geometry (a marker mid-viewport whose card extends past an edge).
    const popup = new maplibregl.Popup({
      maxWidth: 'min(320px, calc(100vw - 24px))',
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
  showStationLegend();
}

/**
 * DDM-P9-T06: read the served wind fields off a discovered RAWS station's
 * own identity object. `undefined` on `windSpeedServed` means the property
 * was never set at all (every non-RAWS station, and RAWS stations rendered
 * from the curated seed table rather than live discovery); `null` means a
 * RAWS station whose discovery response affirmatively reported no wind
 * speed. Only the latter is a RAWS station with nothing to draw; the
 * caller treats both the same way (no glyph), but the distinction matters
 * for anyone extending this later: never draw a glyph for a station this
 * function returns `null` for, and never invent a value for one it returns
 * a `RawsWindStationFields` for with a `null` field.
 */
function readRawsWindFields(station: TelemetryStation): RawsWindStationFields | null {
  const widened = station as TelemetryStation & Partial<RawsWindStationFields>;
  if (widened.windSpeedServed === undefined) return null;
  return {
    windSpeedServed: widened.windSpeedServed,
    windDirectionServed: widened.windDirectionServed ?? null,
    windDirectionDeg: widened.windDirectionDeg ?? null,
    windObservedAtIso: widened.windObservedAtIso ?? null
  };
}

/**
 * The narrowed, definitely-non-null shape a glyph (and its shared accessible
 * name) may be built from. `glyphEligibleWind` below is the ONLY place that
 * decides eligibility; `buildRawsWindGlyph` and `buildRawsWindAccessibleName`
 * both take this type as their parameter so neither one can re-check (or
 * mis-check) what the caller already guaranteed (opus-read.md F12: the
 * former inner `if` in `buildRawsWindGlyph` was dead code because its only
 * caller already enforced the same condition; removed, not duplicated).
 */
interface RawsWindGlyphFields {
  readonly windSpeedServed: string;
  readonly windDirectionServed: string;
  readonly windDirectionDeg: number;
  readonly windObservedAtIso: string | null;
}

/**
 * DDM-P9-T06 fix F3 (opus-read.md): the single eligibility gate for the wind
 * symbol. A glyph exists ONLY when the discovery response served a speed
 * string, a direction string, AND a numeric direction: `windDirectionDeg` is
 * `null` whenever `windDirectionServed` has no leading numeric token (for
 * example the issuer's own "calm" or "VRB"), and drawing a rotated arrow in
 * that case would silently invent a due-north reading the issuer never
 * served. The popup's own wind row (src/ui/popups.ts `rawsWindText`) still
 * renders the served strings verbatim regardless of what this function
 * returns; only the marker's visual glyph and its title/accessible-name
 * sentence are gated here.
 */
function glyphEligibleWind(wind: RawsWindStationFields | null): RawsWindGlyphFields | null {
  if (
    wind === null ||
    wind.windSpeedServed === null ||
    wind.windDirectionServed === null ||
    wind.windDirectionDeg === null
  ) {
    return null;
  }
  return {
    windSpeedServed: wind.windSpeedServed,
    windDirectionServed: wind.windDirectionServed,
    windDirectionDeg: wind.windDirectionDeg,
    windObservedAtIso: wind.windObservedAtIso
  };
}

/**
 * The observation time in the same "As of" style the RAWS popup already
 * uses (src/ui/popups.ts `renderRawsRows`), so the two never disagree about
 * how a timestamp reads. `null` reads "an unknown time" rather than
 * omitting the clause the acceptance requires.
 */
function formatRawsObservedTime(observedAtIso: string | null): string {
  if (!observedAtIso) return 'an unknown time';
  const observed = new Date(observedAtIso);
  return Number.isNaN(observed.getTime()) ? observedAtIso : observed.toLocaleString();
}

/**
 * The one accessible-name sentence for a station's sustained wind, shared by
 * the marker's own `title` tooltip (fix F4: the SVG glyph's
 * `pointer-events: none` means ITS `<title>` never receives a hover, so
 * `renderStations` appends this same sentence to the parent
 * `.telemetry-marker` element's `title` instead) and the glyph's own
 * `aria-label` / `<title>` below, so a mouse hover and a screen reader read
 * the identical served sentence rather than two independently-worded claims
 * about the same reading.
 */
function buildRawsWindAccessibleName(wind: RawsWindGlyphFields): string {
  const observed = formatRawsObservedTime(wind.windObservedAtIso);
  return `Wind ${wind.windSpeedServed} from ${wind.windDirectionServed} (NIFC RAWS), observed ${observed}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// DDM-P9-T06 fix F5 and F10 (opus-read.md): the glyph's drawn size and shape
// are a stated DDM display convention, never an issuer-defined unit or
// threshold. `WIND_GLYPH_DOT_RADIUS_PX` matches the 16px network-color dot's
// own radius (`el.style.width/height = '16px'` above) so the shaft always
// starts just outside the dot regardless of the served speed, keeping the
// dot fully visible under the glyph (fix F10). The shaft then grows linearly
// from `WIND_GLYPH_SHAFT_MIN_PX` at `WIND_GLYPH_SHAFT_MIN_MPH` (5 mph) or
// slower up to `WIND_GLYPH_SHAFT_MAX_PX` at `WIND_GLYPH_SHAFT_MAX_MPH`
// (35 mph) or faster, clamped at both ends; the arrowhead is a fixed size at
// the shaft's outer end. None of these numbers are read from, or shown as, a
// served value: the served strings themselves are what the accessible name,
// the title, and the popup always display.
const WIND_GLYPH_DOT_RADIUS_PX = 8;
const WIND_GLYPH_SHAFT_MIN_PX = 6;
const WIND_GLYPH_SHAFT_MAX_PX = 22;
const WIND_GLYPH_SHAFT_MIN_MPH = 5;
const WIND_GLYPH_SHAFT_MAX_MPH = 35;
const WIND_GLYPH_ARROWHEAD_LENGTH_PX = 8;
const WIND_GLYPH_ARROWHEAD_HALF_WIDTH_PX = 5;
const WIND_GLYPH_STROKE_WIDTH_PX = 1.5;
// Padding so the arrowhead's white contrast stroke never clips against the
// SVG's own edge.
const WIND_GLYPH_PAD_PX = 2;

/**
 * The served speed's leading numeric token, for example 5 out of "5 mph".
 * Mirrors `parseLeadingNumber` in src/config/station-registry.ts (a private,
 * unexported helper; that file's non-doc-comment lines are not owned by this
 * round), duplicated rather than imported for that reason. Never invents a
 * value: a string with no numeric token (the issuer's own "calm" or similar)
 * returns `null`, and the caller draws no directional shape for it, the same
 * way it already does for a parsed speed of exactly 0.
 */
function parseServedWindSpeedMph(served: string): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec(served);
  return match ? Number(match[0]) : null;
}

function clampWindSpeedForShaft(speedMph: number): number {
  return Math.min(Math.max(speedMph, WIND_GLYPH_SHAFT_MIN_MPH), WIND_GLYPH_SHAFT_MAX_MPH);
}

function windGlyphShaftLengthPx(speedMph: number): number {
  const clamped = clampWindSpeedForShaft(speedMph);
  const t =
    (clamped - WIND_GLYPH_SHAFT_MIN_MPH) / (WIND_GLYPH_SHAFT_MAX_MPH - WIND_GLYPH_SHAFT_MIN_MPH);
  return WIND_GLYPH_SHAFT_MIN_PX + t * (WIND_GLYPH_SHAFT_MAX_PX - WIND_GLYPH_SHAFT_MIN_PX);
}

/**
 * The sustained-wind symbol: an inline-styled SVG child of the marker
 * element (no CSS class whose appearance depends on src/styles/app.css;
 * that grant does not exist for this task). The caller (`renderStations`,
 * via `glyphEligibleWind`) is the only gate on when this is built at all; a
 * missing or unparseable field never reaches here (fix F12: no inner
 * re-check, no dead branch).
 *
 * Rotation convention, stated here and in the glyph's own accessible name:
 * `WindDirDegrees` is the direction the wind is blowing FROM, in degrees
 * clockwise from true north (NWCG PMS 426-3, verified against the NIFC
 * PublicView_RAWS FeatureServer's own field description). The glyph is a
 * wind-vane arrowhead that points INTO the wind, so rotating an
 * upward-pointing (north-pointing) shaft clockwise by exactly the served
 * number of degrees draws it correctly with no sign inversion and no
 * re-derivation of the served value.
 *
 * `color` is `station.color`, the SAME network color the unified legend
 * already keys on (fix F10: the glyph no longer carries its own hardcoded
 * dark fill). Measured for the RAWS network color specifically (DDM-P9-T06
 * report, WCAG 2.1 non-text contrast, 3:1 minimum): `#ef4444` (raws) against
 * a white basemap area is 3.76:1 (relative luminance 0.2291 vs 1.0), so the
 * network color passes and is used directly, with a white 1px contrast
 * stroke; a live satellite or terrain basemap varies pixel to pixel, so this
 * is a representative check against the lightest plausible background, not
 * an exhaustive one.
 */
function buildRawsWindGlyph(wind: RawsWindGlyphFields, color: string): SVGSVGElement {
  const accessibleName = buildRawsWindAccessibleName(wind);
  const parsedSpeedMph = parseServedWindSpeedMph(wind.windSpeedServed);
  // Fix F5 (opus-read.md, including its "0 mph with a direction" caveat): a
  // parsed speed of 0, or a speed string with no numeric token at all, draws
  // no directional shape. A calm or unparseable reading has nothing honest
  // to point; the accessible name, the marker's title, and the popup's own
  // wind row still carry the served strings verbatim regardless.
  const drawArrow = parsedSpeedMph !== null && parsedSpeedMph > 0;
  const shaftLength = drawArrow ? windGlyphShaftLengthPx(parsedSpeedMph) : 0;
  const halfSize =
    WIND_GLYPH_DOT_RADIUS_PX +
    shaftLength +
    (drawArrow ? WIND_GLYPH_ARROWHEAD_LENGTH_PX : 0) +
    WIND_GLYPH_PAD_PX;
  const size = halfSize * 2;

  const svg = document.createElementNS(SVG_NS, 'svg') as unknown as SVGSVGElement;
  // A viewBox centered on (0, 0) so the drawn shape's own coordinates are
  // measured from the marker's center, matching the `translate(-50%, -50%)`
  // positioning below with no separate offset math.
  svg.setAttribute('viewBox', `${-halfSize} ${-halfSize} ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('data-telemetry-wind-glyph', 'true');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', accessibleName);
  svg.setAttribute('focusable', 'false');
  svg.style.position = 'absolute';
  svg.style.left = '50%';
  svg.style.top = '50%';
  svg.style.pointerEvents = 'none';
  svg.style.transform = `translate(-50%, -50%) rotate(${wind.windDirectionDeg}deg)`;

  // An SVG `<title>` is the element's native tooltip-on-hover text, but
  // `pointer-events: none` above means this element is never itself the
  // hover target (the browser resolves the hover to the parent
  // `.telemetry-marker`, whose own `title` attribute carries this same
  // sentence; see `renderStations`). The SVG `<title>` still records the
  // accessible sentence directly in the DOM for anything that reads it there.
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = accessibleName;
  svg.appendChild(title);

  if (drawArrow) {
    // Fix F10: the shaft starts exactly `WIND_GLYPH_DOT_RADIUS_PX` from
    // center, the SAME radius as the network-color dot underneath, so the
    // glyph's stroke never overlaps the dot at any served speed; the
    // arrowhead sits further out still, at the shaft's far end.
    const shaftStart = WIND_GLYPH_DOT_RADIUS_PX;
    const shaftEnd = shaftStart + shaftLength;
    const tipY = shaftEnd + WIND_GLYPH_ARROWHEAD_LENGTH_PX;

    const shaft = document.createElementNS(SVG_NS, 'line');
    shaft.setAttribute('x1', '0');
    shaft.setAttribute('y1', String(-shaftStart));
    shaft.setAttribute('x2', '0');
    shaft.setAttribute('y2', String(-shaftEnd));
    shaft.setAttribute('stroke', color);
    shaft.setAttribute('stroke-width', String(WIND_GLYPH_STROKE_WIDTH_PX));
    shaft.setAttribute('stroke-linecap', 'round');
    svg.appendChild(shaft);

    const arrow = document.createElementNS(SVG_NS, 'path');
    arrow.setAttribute(
      'd',
      `M0 ${-tipY} L${WIND_GLYPH_ARROWHEAD_HALF_WIDTH_PX} ${-shaftEnd} L${-WIND_GLYPH_ARROWHEAD_HALF_WIDTH_PX} ${-shaftEnd} Z`
    );
    arrow.setAttribute('fill', color);
    arrow.setAttribute('stroke', '#ffffff');
    arrow.setAttribute('stroke-width', '1');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
  }

  return svg;
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
  hideLegend(LAYER_KEY);
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
      // One response per click (D-0.7.0-058 ruling 5): a station marker
      // is a DOM element, so its popup opens through MapLibre's marker
      // click observer (or Enter/Space on the element), invisible to
      // the InteractionCoordinator's rendered-feature arbitration. The
      // station is the table's top point-event, so the marker popup
      // WINS: adopting it dismisses any coordinator response committed
      // for the same click and occupies the single response slot.
      adoptExternalResponse(popup);

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
      // The viewport is wider than the discovery area cap (D-0.7.0-007):
      // no discovery ran. The curated seeds still render so the layer is
      // not empty, and the pill reads "zoom in to load" honestly. No cap
      // note at region zoom, per the ruling.
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
    // Honest aggregate status (0.7.0 H4): any source failure reads
    // "live (partial)" instead of an unqualified "live". This includes the
    // every-source-failed case, because the curated seed markers are
    // genuinely live (they hydrate on click) and the layer must stay
    // active per the stay-on contract; a terminal 'error' here would make
    // the activation controller treat a data failure as structural and
    // scrub the layer, unchecking it and clearing the seeds it just
    // rendered (layer-controller.ts, the critical-review #2 guard;
    // adversarial-review finding, 2026-07-10). 'error' remains the catch
    // branch below, where discovery itself threw.
    if (result.failedSources.length > 0) {
      reportStatus('degraded');
    } else {
      reportStatus(capped.entries.length > 0 ? 'ready' : 'no-data');
    }
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
