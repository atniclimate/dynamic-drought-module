/**
 * Bureau of Indian Affairs (BIA) reservation-boundary layer.
 *
 * Renders the American Indian and Alaska Native Land Area Representation
 * (AIAN-LAR): the authoritative federal depiction of reservation and trust
 * land extent for federally recognized Tribes. Unlike the bundled
 * `tribal-lands.geojson` placeholder (the deployer's own-data slot, empty by
 * default per CLAUDE.md hard rule 1), this layer is fetched live from the BIA
 * FeatureServer. Live consumption of an authoritative public federal source
 * commits no sovereign polygons to the repository, exactly like the United
 * States Drought Monitor and National Interagency Fire Center layers; see the
 * `ddm-tribal-boundary-mapping` skill for the stewardship reconciliation. The
 * two coexist: one is fetched-and-live, one is bundled-and-empty.
 *
 * Stewardship: the boundary is a representation for general spatial reference,
 * not a definitive depiction of Tribal jurisdiction. The mandatory caveat
 * lives in `buildBiaReservationPopupHtml` (src/ui/popups.ts).
 *
 * Source: `URLS.biaLarFeatureServer` (verified 2026-05-30; see urls.ts).
 *
 * Clipping: the national dataset is large, so the query is clipped to the
 * current map viewport with an Environmental Systems Research Institute (ESRI)
 * spatial envelope rather than fetching the full national FeatureCollection.
 * The region selection drives the viewport, so toggling this layer on after
 * selecting a region pulls only that region's boundaries. A deactivate then
 * re-activate refetches against the then-current viewport, which keeps the
 * layer correct after a region change without a refetch-on-pan subscription.
 *
 * Cancellation (CLAUDE.md section 6 invariant 5): the fetch goes through
 * `fetchWithBudget` with a per-call timeout and a master abort signal that
 * fires on `deactivate` or on a superseding `activate`. A late response to a
 * superseded or torn-down activation is dropped, not rendered.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  RESERVATION_FILL_COLOR,
  RESERVATION_OUTLINE_COLOR
} from '../config/palette';
import { buildBiaReservationPopupHtml } from '../ui/popups';
import { attachImpactTrigger } from '../ui/impact-panel';
import { buildBoundaryContext } from '../impact/context';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'bia-reservations';
const SOURCE_ID = 'bia-reservations';
const FILL_LAYER_ID = 'bia-reservations-fill';
const OUTLINE_LAYER_ID = 'bia-reservations-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor so the boundary stacks below
 * the basemap label glyphs, matching every other reference-polygon module. If
 * the active style does not declare `first-symbol`, MapLibre appends at the top
 * of the layer list, which is an acceptable fallback.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the AIAN-LAR query. */
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

/**
 * Build the GeoJSON query URL, clipped to the current viewport with an ESRI
 * envelope. The envelope is `xmin,ymin,xmax,ymax` in the `inSR` (WGS 84
 * longitude / latitude). `outFields` is limited to the five fields the popup
 * and the impact briefing read, to keep the payload small.
 */
function buildQueryUrl(map: maplibregl.Map): string {
  const b = map.getBounds();
  const envelope = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    .map((n) => n.toFixed(5))
    .join(',');
  const params = new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'LARID,LARNAME,CLASSIFICATION,GISACRES,REGION',
    returnGeometry: 'true',
    f: 'geojson'
  });
  return `${URLS.biaLarFeatureServer}/query?${params.toString()}`;
}

/**
 * Fetch the AIAN-LAR for the current viewport and add the source plus fill and
 * outline layers. Idempotent: if the source already exists the call is a no-op
 * so the URL-restore path cannot stack duplicates. Network failures surface as
 * `'error'` rather than throwing, matching the other layer modules.
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
    const resp = await fetchWithBudget(
      buildQueryUrl(map),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    geojson = (await resp.json()) as FeatureCollection;
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[bia-reservations] AIAN-LAR fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'BIA AIAN-LAR'
  });

  if (features.length === 0) {
    // No reservation lands intersect the current view; not an error.
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': RESERVATION_FILL_COLOR,
        'fill-opacity': 0.18
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
        'line-color': RESERVATION_OUTLINE_COLOR,
        'line-width': 1.2,
        'line-opacity': 0.9
      }
    },
    beforeId
  );

  reportStatus('ready');
}

/**
 * Abort any in-flight fetch and remove the fill, outline, and source. Layers
 * are removed before the source (removing a source with attached layers raises
 * a MapLibre error). Safe to call when never activated.
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
 * Wire the click-to-popup handler and the hover cursor affordance on the fill
 * layer. Bound once at boot (per the boot-time `bindPopups` loop), independent
 * of activation; MapLibre tolerates a handler bound to a not-yet-existing layer
 * ID and the handler short-circuits cleanly when no feature is hit.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const props: GeoJsonProperties = feature.properties ?? null;
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildBiaReservationPopupHtml(props))
      .addTo(map);
    attachImpactTrigger(
      popup,
      buildBoundaryContext('bia-reservation', props, feature.geometry, e.lngLat)
    );
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
