/**
 * Tribal Lands layer (port of vanilla `app.js` `loadTribalLands`).
 *
 * Stewardship note (see CLAUDE.md sections 2 and 4): the bundled
 * `public/data/tribal-lands.geojson` ships as an empty FeatureCollection by
 * deliberate design. The Dynamic Drought Module does not redistribute
 * sovereign-jurisdiction polygons. Each deployer (Tribal Nation, state
 * agency, partner) populates the file with their own authorizations,
 * documented in `data/README.md`. An empty placeholder is therefore the
 * expected first-run state, not an error; this module surfaces it as the
 * canonical `'no-data'` status (rendered by the sidebar as
 * "empty placeholder (see data/README.md)") and renders nothing visible.
 *
 * Status reporting is currently a `console.info` placeholder; M7 wires the
 * LayerRegistry through `setStatus(key, status)` and removes the console
 * calls. The five canonical states (see `src/types/layer.ts`) are reused
 * verbatim so that no callsite migration is required.
 *
 * Source / property reference: Bureau of Indian Affairs (BIA) American
 * Indian / Alaska Native Land Area Representation (AIAN-LAR), clipped to
 * the Pacific Northwest (PNW) by the deployer.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';
import { URLS } from '../config/urls';
import { buildTribalPopupHtml } from '../ui/popups';

/* ---------------------------------------------------------------------------
 * Identifiers
 *
 * The source ID and layer IDs are stable strings referenced by the layer
 * registry (M7) and by `bindPopups`. Keeping them as module-level constants
 * means the registry can clean up by name without re-importing the module.
 * ------------------------------------------------------------------------- */

const SOURCE_ID = 'tribal-lands';
const FILL_LAYER_ID = 'tribal-lands-fill';
const OUTLINE_LAYER_ID = 'tribal-lands-outline';

/**
 * Symbol layer ID used as the `beforeId` anchor when inserting fill and
 * outline layers. Matches the ecoregions module so all reference-polygon
 * layers stack consistently below the basemap label glyphs. If the active
 * style does not contain `'first-symbol'`, MapLibre falls back to
 * appending at the top of the layer list, which is acceptable.
 */
const BEFORE_ID = 'first-symbol';

type Status = 'loading' | 'ready' | 'error' | 'no-data';

function reportStatus(state: Status): void {
  // Placeholder until M7 wires the LayerRegistry; see module header.
  console.info('[tribal]', state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Add the Tribal Lands GeoJSON source plus its fill and outline layers to
 * the map. Idempotent: if the source already exists (a previous activation
 * has not been cleaned up), the function exits early after re-reporting
 * status so the registry still observes a terminal state.
 *
 * Per CLAUDE.md section 2, an empty FeatureCollection is the expected
 * first-run state. We still attach the (empty) source so the registry can
 * cheaply re-render once a deployer populates the file, but we do not add
 * the visible fill / outline layers when there is nothing to draw.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    // Already activated; M7 will treat this as a no-op visibility flip.
    return;
  }

  reportStatus('loading');

  let geojson: FeatureCollection;
  try {
    const response = await fetch(URLS.tribalLandsLocal);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    geojson = (await response.json()) as FeatureCollection;
  } catch (err) {
    console.warn('[tribal] Tribal Lands fetch failed', err);
    reportStatus('error');
    return;
  }

  const features = geojson?.features ?? [];

  // Attach the source even when empty so M7 can hot-swap features without a
  // full re-activation. Layers are only added when there is data to render.
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson
  });

  if (features.length === 0) {
    // Empty placeholder is the deliberate ship state; do not render layers
    // and do not warn. The sidebar status pill communicates the situation.
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
        'fill-color': '#9a3412',
        'fill-opacity': 0.25
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
        'line-color': '#7c2d12',
        'line-width': 1.2,
        'line-opacity': 0.85
      }
    },
    beforeId
  );

  reportStatus('ready');
}

/**
 * Tear down the Tribal Lands fill, outline, and source. Safe to call when
 * the layer was never activated or activation aborted before adding the
 * source (the empty-placeholder path still adds the source; the error path
 * does not). All `getLayer` / `getSource` checks are defensive.
 */
export function deactivate(map: maplibregl.Map): void {
  if (map.getLayer(FILL_LAYER_ID)) {
    map.removeLayer(FILL_LAYER_ID);
  }
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    map.removeLayer(OUTLINE_LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
}

/**
 * Wire the click-to-popup handler on the Tribal Lands fill layer. Called
 * once at boot (by M7), independent of activation: MapLibre tolerates
 * binding a handler against a layer ID that does not yet exist, and the
 * handler short-circuits cleanly when the layer is absent.
 *
 * The popup factory `buildTribalPopupHtml` handles property fallback
 * (LARName / NAME / TRIBE / etc.) and HTML escaping; this function only
 * extracts the first feature's properties and forwards them.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const props: GeoJsonProperties = feature.properties ?? null;

    new maplibregl.Popup({ closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildTribalPopupHtml(props))
      .addTo(map);
  });
}
