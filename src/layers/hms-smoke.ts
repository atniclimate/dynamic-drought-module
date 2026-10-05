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

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  HMS_DENSITY_PRESENTATION,
  HMS_OVERVIEW_QUALIFICATION,
  buildHmsSmokeFillPaint,
  parseArcGisPolygonFeatureCollection,
  resolveHmsDensityClass,
  resolveHmsDensityPresentation
} from '../config/wildfire-presentation';
import { registerClickTarget } from '../map/interaction-coordinator';
import type { ClockAbsent, ClockValue, IssuedModel, PopupClock } from '../ui/popup-frame';
import type { LayerActivation } from '../config/layers';
import { fetchJsonWithBudget, linkAbort } from '../util/fetch';
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

/**
 * The controller-owned activation signal (DDM-P1-T02): handed in by
 * `activate` and linked to `masterController`, so the layer controller's
 * abort on deactivate or supersession reaches a held query at once. Null
 * when activated without the seam, where `cancelActivation` alone applies.
 */
let activationSignal: AbortSignal | null = null;

/**
 * Request-identity token, the same belt-and-braces the boundary layers wear:
 * each query takes `++requestSeq` at fetch start and a response whose token
 * is no longer current renders nothing, even one that raced past the abort.
 */
let requestSeq = 0;

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

/** The frame's explanation for issuer time text DDM does not parse (PF1). */
const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';

/**
 * Read an HMS "YYYYDDD HHMM" string as a UTC instant (PF1), the year at
 * least 1000 (Date.UTC reads years 0 to 99 as 1900 to 1999), the day of
 * year checked against that year (1 to 365, or 366 in a leap year) and the
 * time against 0000 to 2359. A missing, null or blank value, or one that is
 * neither text nor a finite number, is absent; any other value is shown as
 * the issuer supplied it, never silently dropped.
 */
function readHmsTime(value: unknown): ClockValue | ClockAbsent {
  const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (raw === null || raw.trim() === '') {
    return { precision: 'absent', reason: 'unavailable' };
  }
  const m = /^(\d{4})(\d{3})\s+(\d{2})(\d{2})$/.exec(raw.trim());
  const supplied: ClockValue = { precision: 'supplied', text: raw, explanation: SUPPLIED_TIME_EXPLANATION };
  if (!m) return supplied;
  const [year, doy, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (year < 1000) return supplied;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (doy < 1 || doy > (leap ? 366 : 365) || hh > 23 || mm > 59) return supplied;
  return { precision: 'instant', at: Date.UTC(year, 0, doy, hh, mm), zone: 'UTC' };
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
export async function activate(
  map: maplibregl.Map,
  activation?: LayerActivation
): Promise<void> {
  activationSignal = activation?.signal ?? null;
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  const unlink = linkAbort(masterController, activationSignal);
  const token = ++requestSeq;

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
    unlink();
    if (signal.aborted || token !== requestSeq) {
      console.debug(`[hms-smoke] request ${token} dropped: aborted or superseded before it settled`);
      return;
    }
    console.warn('[hms-smoke] HMS smoke fetch failed.', err);
    reportStatus('error');
    return;
  }

  unlink();
  // A late response to a superseded or torn-down request must not render.
  if (signal.aborted || token !== requestSeq) {
    console.debug(`[hms-smoke] request ${token} dropped: a late response after intent changed`);
    return;
  }

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
  // Invalidate any response that already raced past its abort check.
  requestSeq++;
}

export function deactivate(map: maplibregl.Map): void {
  cancelActivation();
  masterController = null;
  activationSignal = null;
  // Remove the retired outline defensively during a hot module replacement.
  if (map.getLayer(LEGACY_OUTLINE_LAYER_ID)) map.removeLayer(LEGACY_OUTLINE_LAYER_ID);
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LAYER_KEY);
}

/**
 * The smoke plume's popup model (D1 M25; the frame's surface head): the
 * density class on its single hue (unknown stays unclassified), the
 * observed window at UTC instants, the detecting satellite as a row.
 */
export function buildHmsPopupModel(props: GeoJsonProperties): IssuedModel {
  const densityClass = resolveHmsDensityClass(props?.['Density']);
  const density = HMS_DENSITY_PRESENTATION[densityClass];
  const satellite = typeof props?.['Satellite'] === 'string' ? props['Satellite'] : '';
  const start = readHmsTime(props?.['Start']);
  const end = readHmsTime(props?.['End_']);
  const observed: PopupClock =
    start.precision === 'absent' && end.precision === 'absent'
      ? { kind: 'not-stated', label: 'Observed', reason: 'unavailable' }
      : { kind: 'window', meaning: 'observed', from: { label: 'Observed', at: start }, until: { label: 'to', at: end } };

  return {
    kind: 'surface',
    title: 'HMS smoke analysis',
    issuer: { role: 'issued-by', name: 'NOAA NESDIS Office of Satellite and Product Operations', productKey: 'hms-smoke' },
    value: [
      {
        text: density.popupLabel,
        swatch: { table: 'HMS_DENSITY_PRESENTATION', classKey: densityClass, color: density.color }
      }
    ],
    clocks: [observed],
    details: satellite.trim() === '' ? [] : [{ kind: 'row', label: 'Detected by', text: satellite }],
    source: { link: { label: 'NOAA OSPO Hazard Mapping System', href: 'https://www.ospo.noaa.gov/products/land/hms.html' } },
    qualifications: [
      'Analyst-drawn smoke plume from GOES satellite imagery. Density classes describe apparent smoke thickness (Light, Medium, Heavy), not ground-level air quality; check local air quality observations for exposure decisions.',
      'Strategic context only, not tactical fire operations or evacuation guidance.'
    ]
  };
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
      model: buildHmsPopupModel(feature.properties ?? {})
    })
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
