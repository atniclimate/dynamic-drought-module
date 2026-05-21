/**
 * Treaty Areas layer module.
 *
 * Ports the vanilla baseline `loadTreatyAreas` flow (Leaflet) to MapLibre GL.
 * Treaty boundaries are rendered as hollow, dashed outlines per the v0.1
 * styling spec; no fill is drawn so underlying basemap and overlays remain
 * visible.
 *
 * Stewardship note (CLAUDE.md section 2): Treaty boundaries are a
 * representation of Treaty cession areas, not a definitive depiction of
 * Tribal jurisdiction. The popup framing required by section 2 lives in
 * `buildTreatyPopupHtml` and is reused verbatim from this module's click
 * handler. The repository ships an empty FeatureCollection placeholder per
 * CLAUDE.md section 4 rule 1; deployers populate `data/treaty-areas.geojson`
 * under their own authorizations.
 *
 * Per-feature color: MapLibre data-driven property expressions cannot call
 * arbitrary JavaScript, so we precompute the per-feature outline color in
 * a top-level property `_color` on each feature when adding the source. The
 * outline layer's `line-color` paint then references `['get', '_color']`.
 * This keeps the `pickTreatyColor` substring matching logic in TypeScript
 * (where it belongs) and the MapLibre paint expression trivial.
 */

import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import { URLS } from '../config/urls';
import { TREATY_COLOR_DEFAULT, pickTreatyColor } from '../config/palette';
import { buildTreatyPopupHtml } from '../ui/popups';
import { registry } from '../state/registry';

const LAYER_KEY = 'treaty';
const SOURCE_ID = 'treaty-areas';
const OUTLINE_LAYER_ID = 'treaty-areas-outline';

type TreatyStatus = 'loading' | 'ready' | 'error' | 'no-data';

function reportStatus(state: TreatyStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Mirrors the vanilla `pickTreatyName` helper. Reads name-bearing keys in
 * the order observed across upstream Treaty datasets (Native Land Digital,
 * Washington Department of Archaeology and Historic Preservation (DAHP),
 * regional Tribal data sources). Returns null if no candidate is present;
 * callers substitute a generic label in that case.
 */
function pickTreatyName(props: GeoJsonProperties): string | null {
  if (!props) return null;
  const candidate =
    props.name ??
    props.TREATY_NAM ??
    props.TREATY_NAME ??
    props.TreatyName ??
    props.NAME ??
    props.Treaty;
  if (candidate === null || candidate === undefined || candidate === '') return null;
  return String(candidate);
}

/**
 * Fetches the bundled GeoJSON, precomputes per-feature outline colors, and
 * adds the source plus the dashed outline layer. Idempotent: a second call
 * is a no-op once the source and layer exist.
 *
 * Empty FeatureCollection is treated as the "deployer has not populated
 * polygons yet" case (CLAUDE.md section 6 invariant 4) and surfaces as
 * 'no-data' rather than an error.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    return;
  }

  reportStatus('loading');

  let geojson: FeatureCollection;
  try {
    const response = await fetch(URLS.treatyAreasLocal);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${URLS.treatyAreasLocal}`);
    }
    geojson = (await response.json()) as FeatureCollection;
  } catch (err) {
    console.warn('[treaty] Treaty Areas file fetch failed.', err);
    reportStatus('error');
    return;
  }

  const features: Feature<Geometry, GeoJsonProperties>[] = Array.isArray(geojson?.features)
    ? geojson.features
    : [];

  if (features.length === 0) {
    reportStatus('no-data');
    return;
  }

  // Precompute the per-feature color into a `_color` property so the
  // MapLibre paint expression can read it via ['get', '_color']. We do not
  // mutate the caller's feature objects: each feature is rebuilt with a
  // fresh `properties` object that carries the original keys plus `_color`.
  const decorated: FeatureCollection = {
    type: 'FeatureCollection',
    features: features.map((feature) => {
      const props: GeoJsonProperties = { ...(feature.properties ?? {}) };
      const name = pickTreatyName(props);
      props._color = pickTreatyColor(name);
      return {
        ...feature,
        properties: props
      };
    })
  };

  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: decorated
    });
  } else {
    const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource;
    existing.setData(decorated);
  }

  map.addLayer({
    id: OUTLINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: {
      // The coalesce fall-through to TREATY_COLOR_DEFAULT is defensive: in
      // practice every feature gets a `_color` from `pickTreatyColor`, but
      // the expression keeps the layer well-defined if an upstream change
      // ever ships features without the precomputed property.
      'line-color': ['coalesce', ['get', '_color'], TREATY_COLOR_DEFAULT],
      'line-width': 2.4,
      'line-opacity': 0.95,
      'line-dasharray': [6, 3]
    }
  });

  reportStatus('ready');
}

/**
 * Removes the outline layer and the GeoJSON source. Safe to call when the
 * layer is not present (each removal is guarded). Idempotent.
 */
export function deactivate(map: maplibregl.Map): void {
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    map.removeLayer(OUTLINE_LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
}

/**
 * Wires a click handler on the outline layer that opens a MapLibre popup
 * with HTML produced by `buildTreatyPopupHtml`. The mandatory stewardship
 * framing required by CLAUDE.md section 2 lives inside that factory. The
 * full formal Tribe names (Confederated Tribes and Bands of the Yakama
 * Nation, Nez Perce Tribe, Quinault Indian Nation) come through
 * `pickTreatyEntry` inside the popup factory (CLAUDE.md section 4 rule 6).
 *
 * Cursor affordance: switch to the pointer cursor on hover so users see
 * that Treaty outlines are interactive even though they are hollow.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', OUTLINE_LAYER_ID, (e) => {
    const feature = e.features && e.features[0];
    if (!feature) return;

    const props: GeoJsonProperties = feature.properties ?? {};
    const featureName = pickTreatyName(props) ?? 'Treaty Area';
    const html = buildTreatyPopupHtml(props, featureName);

    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
  });

  map.on('mouseenter', OUTLINE_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', OUTLINE_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
