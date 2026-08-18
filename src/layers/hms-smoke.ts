/**
 * NOAA Hazard Mapping System (HMS) satellite smoke plumes (0.4.0 B3).
 *
 * Analyst-drawn smoke plume polygons from GOES-East/GOES-West imagery, with a
 * three-class Density attribute (Light, Medium, Heavy). This is the
 * heat-and-smoke half of the coupled-hazards read: where the fire perimeters
 * (nifc-fires) show the burning land, this layer shows where the smoke
 * actually is, which is what most people experience of a fire season.
 *
 * Endpoint: URLS.noaaHmsSmokeFeatureServer (verified 2026-07-06; wildcard
 * CORS; see the stamp for the load-bearing caveats). The Start/End_ fields
 * are Julian "YYYYDDD HHMM" STRINGS, not ISO dates; this module computes the
 * current UTC Julian day for the recency filter and parses the strings for
 * popup display. The query filters to today-or-yesterday (UTC) so a plume
 * drawn just before midnight does not vanish at the day boundary; the feed
 * itself holds only a short rolling window (observed: a single day).
 *
 * Structure mirrors nifc-fires.ts (the closest sibling): master abort
 * controller, honest no-data on an empty result, a borderless fill below
 * the label glyphs, a legend registration, and a click popup.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  HMS_DENSITY_PRESENTATION,
  HMS_OVERVIEW_QUALIFICATION,
  buildHmsSmokeFillPaint,
  parseArcGisPolygonFeatureCollection,
  resolveHmsDensityPresentation
} from '../config/wildfire-presentation';
import { registerClickTarget } from '../map/interaction-coordinator';
import { escapeHtml } from '../util/escape';
import { fetchJsonWithBudget } from '../util/fetch';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';

const LAYER_KEY = 'hms-smoke';
const SOURCE_ID = 'hms-smoke';
const FILL_LAYER_ID = 'hms-smoke-fill';
const LEGACY_OUTLINE_LAYER_ID = 'hms-smoke-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID] as const;

/** Insert below the basemap label glyphs, matching the polygon-overlay convention. */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the HMS query. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` so a superseded request can
 * never render into a torn-down layer (the cancellation invariant).
 */
let masterController: AbortController | null = null;

type HmsStatus = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';

function reportStatus(state: HmsStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/** The UTC Julian day string YYYYDDD for a date (the HMS Start prefix form). */
function julianDayUtc(date: Date): string {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000) + 1;
  return `${date.getUTCFullYear()}${String(dayOfYear).padStart(3, '0')}`;
}

/** Parse an HMS "YYYYDDD HHMM" string into a short human label ("Jul 6, 12:00 UTC"). */
function formatHmsTime(value: unknown): string {
  if (typeof value !== 'string') return '';
  const m = /^(\d{4})(\d{3})\s+(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const [, year, doy, hh, mm] = m;
  const date = new Date(Date.UTC(Number(year), 0, Number(doy), Number(hh), Number(mm)));
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${hh}:${mm} UTC`;
}

/**
 * Build the recency-filtered GeoJSON query: plumes whose Start falls on the
 * current or previous UTC Julian day (the LIKE-prefix filter was verified to
 * genuinely discriminate; see the urls.ts stamp).
 */
function buildQueryUrl(): string {
  const now = new Date();
  const today = julianDayUtc(now);
  const yesterday = julianDayUtc(new Date(now.getTime() - 86_400_000));
  const params = new URLSearchParams({
    where: `Start LIKE '${today}%' OR Start LIKE '${yesterday}%'`,
    outFields: 'Satellite,Start,End_,Density',
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.noaaHmsSmokeFeatureServer}/query?${params.toString()}`;
}

/**
 * Add the HMS smoke source plus its borderless fill. Idempotent; an empty
 * result is `'no-data'` (no smoke drawn in the two-day query window is a
 * real, good answer).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let geojson: FeatureCollection;
  let truncated = false;
  try {
    const parsed = parseArcGisPolygonFeatureCollection(
      await fetchJsonWithBudget(
        buildQueryUrl(),
        null,
        signal,
        FETCH_TIMEOUT_MS
      ),
      'NOAA HMS smoke'
    );
    geojson = parsed.collection;
    truncated = parsed.truncated;
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[hms-smoke] HMS smoke fetch failed.', err);
    reportStatus('error');
    return;
  }

  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'NOAA OSPO Hazard Mapping System'
  });

  if (features.length === 0) {
    reportStatus(truncated ? 'degraded' : 'no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: buildHmsSmokeFillPaint()
    },
    beforeId
  );

  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event + 2,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Satellite smoke plumes',
        [
          {
            color: HMS_DENSITY_PRESENTATION.Light.color,
            label: HMS_DENSITY_PRESENTATION.Light.legendLabel
          },
          {
            color: HMS_DENSITY_PRESENTATION.Medium.color,
            label: HMS_DENSITY_PRESENTATION.Medium.legendLabel
          },
          {
            color: HMS_DENSITY_PRESENTATION.Heavy.color,
            label: HMS_DENSITY_PRESENTATION.Heavy.legendLabel
          },
          {
            color: HMS_DENSITY_PRESENTATION.Unknown.color,
            label: HMS_DENSITY_PRESENTATION.Unknown.legendLabel
          }
        ],
        HMS_OVERVIEW_QUALIFICATION
      )
  });
  if (truncated) {
    console.warn(
      '[hms-smoke] HMS response reached the ArcGIS transfer limit; rendering available plumes as live (partial).'
    );
  }
  reportStatus(truncated ? 'degraded' : 'ready');
}

/**
 * Abort any in-flight fetch and remove the fill and source. All
 * guards defensive; symmetric with `activate`.
 */
export function cancelActivation(): void {
  masterController?.abort();
}

export function deactivate(map: maplibregl.Map): void {
  cancelActivation();
  masterController = null;
  // Remove the retired outline defensively during a hot module replacement.
  if (map.getLayer(LEGACY_OUTLINE_LAYER_ID)) map.removeLayer(LEGACY_OUTLINE_LAYER_ID);
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LAYER_KEY);
}

function buildHmsPopupHtml(props: GeoJsonProperties): string {
  const density = resolveHmsDensityPresentation(props?.['Density']);
  const satellite = typeof props?.['Satellite'] === 'string' ? props['Satellite'] : '';
  const start = formatHmsTime(props?.['Start']);
  const end = formatHmsTime(props?.['End_']);

  return `
    <div class="popup-title">${escapeHtml(density.popupLabel)}</div>
    <div class="popup-agency">NOAA Hazard Mapping System</div>
    ${satellite ? `<div class="popup-treaty-meta">Detected by: ${escapeHtml(satellite)}</div>` : ''}
    ${start ? `<div class="popup-treaty-meta">Observed: ${escapeHtml(start)}${end ? ` to ${escapeHtml(end)}` : ''}</div>` : ''}
    <div class="popup-description">Analyst-drawn smoke plume from GOES satellite imagery. Density classes describe apparent smoke thickness (Light, Medium, Heavy), not ground-level air quality; check local air quality observations for exposure decisions.</div>
    <div class="popup-description">Strategic context only, not tactical fire operations or evacuation guidance.</div>
    <div class="popup-links">
      <a href="https://www.ospo.noaa.gov/products/land/hms.html" target="_blank" rel="noopener">NOAA OSPO Hazard Mapping System</a>
    </div>
  `;
}

/**
 * Register the smoke fill's click target with the InteractionCoordinator
 * (one response per click; D-0.7.0-058 ruling 5), matching the
 * nifc-fires interaction pattern.
 */
export function bindPopups(map: maplibregl.Map): void {
  // A smoke plume can span states, so despite the LAYER_DEFS 'event'
  // role it behaves as a blanketing contextual surface at click time;
  // ranking it 'point-event' would make every boundary under a plume
  // unreachable except through the disclosure. The table names
  // perimeters and alerts as direct targets, not plumes. RATIFIED
  // condition-surface (maintainer, 2026-07-18; the 2026-07-17
  // adversarial finding 4 proposal accepted).
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [FILL_LAYER_ID],
    label: (feature) => {
      return resolveHmsDensityPresentation(
        feature.properties?.['Density']
      ).popupLabel;
    },
    respond: (feature) => ({
      content: buildHmsPopupHtml(feature.properties ?? {})
    })
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
