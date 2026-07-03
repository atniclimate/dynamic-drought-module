/**
 * Storm Prediction Center (SPC) Fire Weather Outlook, Day 1 (E2).
 *
 * Renders the SPC's categorical fire-weather threat forecast for today:
 * areas where pre-existing fuel dryness combines with forecast wind,
 * relative humidity, and dry lightning to favor fire spread. Categories are
 * Elevated, Critical, and Extreme, carried by the MapServer's integer `dn`
 * field (5, 8, 10) with no string sibling; the palette owns the value-to-
 * label mapping (`SPC_FIREWX_CATEGORIES`).
 *
 * Honest framing (verified source doctrine): this is fire-WEATHER threat,
 * not the National Fire Danger Rating System (NFDRS) fuel-dryness fire
 * danger rating, and not an active-fire product (that is `nifc-fires`). The
 * popup carries that framing verbatim.
 *
 * Source: `URLS.spcFireWeatherOutlookMapServer` layer 1 ("Day 1 Outlook");
 * verified 2026-07-01 (see urls.ts). An empty FeatureCollection is the
 * common good-news case (no elevated fire weather anywhere today) and
 * renders as `'no-data'`, never as an error. Updated up to five times daily.
 *
 * Cancellation (CLAUDE.md section 6 invariant 5): master abort controller
 * superseded on each `activate`, aborted on `deactivate`, fetch through
 * `fetchWithBudget`, late responses dropped.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  SPC_FIREWX_CATEGORIES,
  SPC_FIREWX_DEFAULT_COLOR
} from '../config/palette';
import { buildSpcFireWeatherPopupHtml } from '../ui/popups';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'spc-fire-weather';
const SOURCE_ID = 'spc-fire-weather';
const FILL_LAYER_ID = 'spc-fire-weather-fill';
const OUTLINE_LAYER_ID = 'spc-fire-weather-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/** Day 1 categorical outlook layer ID on the MapServer (4 would be Day 2). */
const DAY1_LAYER_ID = 1;

/**
 * Symbol layer ID used as the `beforeId` anchor so outlook polygons stack
 * below the basemap label glyphs, matching the other polygon overlays.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the outlook query. */
const FETCH_TIMEOUT_MS = 15_000;

type Status = 'loading' | 'ready' | 'error' | 'no-data';

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` so a superseded request can
 * never render into a torn-down layer.
 */
let masterController: AbortController | null = null;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/** Resolve the display label for a `dn` category value. */
function categoryLabel(dn: unknown): string {
  const n = typeof dn === 'number' ? dn : Number(dn);
  const entry = SPC_FIREWX_CATEGORIES.find((c) => c.dn === n);
  // Surface an unknown value honestly rather than guessing a severity.
  return entry ? entry.label : `Category ${String(dn)}`;
}

function buildQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'dn,valid,expire',
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.spcFireWeatherOutlookMapServer}/${DAY1_LAYER_ID}/query?${params.toString()}`;
}

/**
 * Fetch today's outlook and add the source plus fill and outline layers.
 * Idempotent. Empty FeatureCollection renders as `'no-data'` (no elevated
 * fire weather anywhere today; common and legitimate).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  // Supersede any prior in-flight fetch before starting a new one.
  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let geojson: FeatureCollection;
  try {
    const response = await fetchWithBudget(
      buildQueryUrl(),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    geojson = (await response.json()) as FeatureCollection;
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[spc-fire-weather] outlook fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'NOAA SPC'
  });

  if (features.length === 0) {
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  // Color by category via a `match` expression on the integer `dn` field.
  const matchArgs: (number | string)[] = [];
  for (const c of SPC_FIREWX_CATEGORIES) {
    matchArgs.push(c.dn, c.color);
  }
  const colorExpression = [
    'match',
    ['get', 'dn'],
    ...matchArgs,
    SPC_FIREWX_DEFAULT_COLOR
  ] as unknown as maplibregl.ExpressionSpecification;

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': colorExpression,
        'fill-opacity': 0.3
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
        'line-color': colorExpression,
        'line-width': 1.2,
        'line-opacity': 0.9
      }
    },
    beforeId
  );

  reportStatus('ready');
}

/**
 * Abort any in-flight fetch and remove the fill, outline, and source. All
 * guards are defensive so callers can invoke `deactivate` without first
 * verifying activation state.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Wire the click-to-popup handler and hover cursor affordance on the fill
 * layer. Bound once at boot, independent of activation.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const props: GeoJsonProperties = feature.properties ?? null;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildSpcFireWeatherPopupHtml(categoryLabel(props?.dn), props))
      .addTo(map);
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
