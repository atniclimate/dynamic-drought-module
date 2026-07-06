/**
 * Sea surface temperature (SST) anomaly layer (0.4.0 B2 slice 2).
 *
 * The ENSO ocean surface: NASA Global Imagery Browse Services (GIBS) GHRSST
 * Level 4 MUR daily SST anomaly, rendered as raster tiles so a user can SEE
 * the El Nino / Southern Oscillation (ENSO) warm or cool tongue along the
 * equatorial Pacific and connect it to the drought, heat, and fire reads on
 * land. Registered as an exclusive condition surface (one surface at a time),
 * so it can never stack into clutter with USDM, HeatRisk, or WHP.
 *
 * Two pedagogical touches make the surface teach rather than decorate:
 *   - The Nino 3.4 box (170W-120W, 5S-5N), drawn dashed with a label: this is
 *     the region the ENSO index in the sidebar driver line actually measures,
 *     the bridge between the picture and the number.
 *   - A one-shot toast when the current view does not include the equatorial
 *     Pacific, telling the user to zoom out (in a PNW framing the layer shows
 *     only coastal water and teaches nothing).
 *
 * Endpoint: verified 2026-07-06 (see URLS.gibsSstAnomalyWmts caveats): keyless
 * WMTS, wildcard CORS, daily cadence with a one-day lag, tile matrix capped at
 * z=7 (maxzoom is load-bearing; tiles 404 beyond it). The anomaly climatology
 * baseline is NOT stated in the GIBS metadata, so the legend deliberately
 * reads qualitatively (warmer or cooler than usual) and does not assert one.
 */

import type maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import { watchRasterTiles, type RasterTileWatch } from '../util/raster-status';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';
import { showToast } from '../ui/overlay';

const LAYER_KEY = 'sst-anomaly';
const SOURCE_ID = 'sst-anomaly';
const LAYER_ID = 'sst-anomaly';
const NINO_SOURCE_ID = 'nino34-box';
const NINO_LINE_ID = 'nino34-box-line';
const NINO_LABEL_ID = 'nino34-box-label';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID, NINO_LINE_ID, NINO_LABEL_ID] as const;

/** The tile-load honesty watcher (util/raster-status.ts); null when inactive. */
let tileWatch: RasterTileWatch | null = null;

/** One toast per session; repeat activations should not nag. */
let pacificHintShown = false;

type SstStatus = 'loading' | 'ready' | 'error';

function reportStatus(state: SstStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * The Nino 3.4 region (170W-120W, 5S-5N): the east-central equatorial Pacific
 * box whose average SST anomaly defines the ONI the sidebar driver line shows.
 */
const NINO34_BOX: GeoJSON.Feature = {
  type: 'Feature',
  properties: { label: 'Nino 3.4 (the ENSO index region)' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-170, -5],
        [-120, -5],
        [-120, 5],
        [-170, 5],
        [-170, -5]
      ]
    ]
  }
};

/** Does the current view include any of the equatorial Pacific ENSO region? */
function viewIncludesNino34(map: maplibregl.Map): boolean {
  const b = map.getBounds();
  return b.getWest() < -120 && b.getEast() > -170 && b.getSouth() < 5 && b.getNorth() > -5;
}

/**
 * Add the SST anomaly raster, the Nino 3.4 box, and the legend. Idempotent:
 * re-activation with existing sources/layers is a no-op per the registry
 * contract.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  reportStatus('loading');

  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [URLS.gibsSstAnomalyWmts],
        tileSize: 256,
        // Load-bearing: the GIBS tile matrix set tops out at z=7; beyond it
        // tiles 404 (see the URLS stamp). MapLibre overzooms from here.
        maxzoom: 7,
        attribution: 'NASA EOSDIS GIBS · GHRSST MUR SST anomaly'
      });
    }

    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          // High enough that the ocean signal reads clearly; the anomaly
          // raster is transparent over land, so land layers stay legible.
          'raster-opacity': 0.78
        }
      });
    }

    if (!map.getSource(NINO_SOURCE_ID)) {
      map.addSource(NINO_SOURCE_ID, {
        type: 'geojson',
        data: NINO34_BOX
      });
    }

    if (!map.getLayer(NINO_LINE_ID)) {
      map.addLayer({
        id: NINO_LINE_ID,
        type: 'line',
        source: NINO_SOURCE_ID,
        paint: {
          'line-color': '#e2e8f0',
          'line-width': 1.4,
          'line-dasharray': [2, 2],
          'line-opacity': 0.9
        }
      });
    }

    if (!map.getLayer(NINO_LABEL_ID)) {
      map.addLayer({
        id: NINO_LABEL_ID,
        type: 'symbol',
        source: NINO_SOURCE_ID,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-anchor': 'top',
          // Label sits under the box's south edge, over open ocean.
          'text-offset': [0, 0.4],
          'text-justify': 'center'
        },
        paint: {
          'text-color': '#e2e8f0',
          'text-halo-color': '#0b1220',
          'text-halo-width': 1.2
        }
      });
    }

    tileWatch?.detach();
    tileWatch = watchRasterTiles(map, SOURCE_ID, reportStatus);

    showLegend(LAYER_KEY, {
      order: LEGEND_ORDER.surface,
      render: (body) =>
        renderSwatchLegend(
          body,
          'Ocean temperature anomaly',
          [
            { color: '#b2182b', label: 'Warmer than usual' },
            { color: '#f7f7f7', label: 'Near usual' },
            { color: '#2166ac', label: 'Cooler than usual' }
          ],
          'NASA GHRSST MUR daily anomaly · the dashed box is Nino 3.4, the region the ENSO index measures'
        )
    });

    // The ENSO signal lives in the equatorial Pacific; a regional framing
    // shows only coastal water. One honest nudge per session.
    if (!pacificHintShown && !viewIncludesNino34(map)) {
      pacificHintShown = true;
      showToast('Ocean temperature anomaly is global; zoom out toward the equatorial Pacific to see the ENSO signal.');
    }

    reportStatus('ready');
  } catch (err) {
    console.warn('[sst-anomaly] activation failed.', err);
    reportStatus('error');
  }
}

/**
 * Remove the SST raster, the Nino 3.4 box, and the legend. Symmetric with
 * `activate`; each guard is defensive so deactivate is safe to call whenever.
 */
export function deactivate(map: maplibregl.Map): void {
  tileWatch?.detach();
  tileWatch = null;
  for (const id of [NINO_LABEL_ID, NINO_LINE_ID, LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [NINO_SOURCE_ID, SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
  hideLegend(LAYER_KEY);
}

/**
 * No-op popup binder: the anomaly is a server-rendered raster with no
 * per-pixel attributes on the client. Same uniform-shape rationale as
 * usfs-whp.ts.
 */
export function bindPopups(_map: maplibregl.Map): void {
  // Intentionally empty; see JSDoc above.
}
