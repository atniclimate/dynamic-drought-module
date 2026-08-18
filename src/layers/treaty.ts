/**
 * Treaty Areas layer module.
 *
 * Ports the vanilla baseline `loadTreatyAreas` flow (Leaflet) to MapLibre GL.
 * Treaty boundaries are rendered as hollow, dashed outlines per the v0.1
 * styling spec; no fill is drawn so underlying basemap and overlays remain
 * visible.
 *
 * Stewardship note: Treaty boundaries are a
 * representation of Treaty cession areas, not a definitive depiction of
 * Tribal jurisdiction. The mandatory popup framing carrying that caveat lives
 * in `buildTreatyPopupHtml` and is reused verbatim from this module's click
 * handler. The repository ships an empty FeatureCollection placeholder
 * because the project never redistributes sovereign-jurisdiction polygons;
 * deployers populate `data/treaty-areas.geojson`
 * under their own authorizations.
 *
 * Per-feature color: MapLibre data-driven property expressions cannot call
 * arbitrary JavaScript, so we precompute the per-feature outline color in
 * a top-level property `_color` on each feature when adding the source. The
 * outline layer's `line-color` paint then references `['get', '_color']`.
 * This keeps the `pickTreatyColor` substring matching logic in TypeScript
 * (where it belongs) and the MapLibre paint expression trivial.
 */

import type maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import { URLS } from '../config/urls';
import { TREATY_COLOR_DEFAULT, pickTreatyColor } from '../config/palette';
import { buildTreatyPopupHtml } from '../ui/popups';
import { buildBoundaryContext } from '../impact/context';
import { registerClickTarget } from '../map/interaction-coordinator';
import { registry } from '../state/registry';
import { fetchWithBudget } from '../util/fetch';

const LAYER_KEY = 'treaty';
const SOURCE_ID = 'treaty-areas';
const OUTLINE_LAYER_ID = 'treaty-areas-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [OUTLINE_LAYER_ID] as const;

/** Per-call budget for the bundled boundary fetch; honors invariant 5. */
const FETCH_TIMEOUT_MS = 10_000;

/** Master abort for the in-flight bundled fetch; aborted on deactivate (#13). */
let masterController: AbortController | null = null;

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
 * polygons yet" case (absent data is an expected state, not a failure) and
 * surfaces as 'no-data' rather than an error.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    return;
  }

  reportStatus('loading');

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  let geojson: FeatureCollection;
  try {
    const response = await fetchWithBudget(URLS.treatyAreasLocal, null, signal, FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${URLS.treatyAreasLocal}`);
    }
    geojson = (await response.json()) as FeatureCollection;
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[treaty] Treaty Areas file fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

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
      data: decorated,
      // Stable per-feature ids for the selected-place emphasis (U3h) without
      // depending on a deployer-supplied unique field.
      generateId: true
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
      // Hollow throughout (a cession-area representation, never a fill); the
      // selected Treaty (U3h) reads through a heavier, fully opaque line.
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        3.4,
        2.4
      ],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        1,
        0.95
      ],
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
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
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
 * framing (boundaries as representations) lives inside that factory. The
 * full formal Tribe names (Confederated Tribes and Bands of the Yakama
 * Nation, Nez Perce Tribe, Quinault Indian Nation) come through
 * `pickTreatyEntry` inside the popup factory; full formal names are a
 * project hard rule.
 *
 * Cursor affordance: switch to the pointer cursor on hover so users see
 * that Treaty outlines are interactive even though they are hollow.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'treaty-cession',
    layerIds: [OUTLINE_LAYER_ID],
    label: (feature) => pickTreatyName(feature.properties ?? {}) ?? 'Treaty Area',
    respond: (feature, click) => {
      const props: GeoJsonProperties = feature.properties ?? {};
      const featureName = pickTreatyName(props) ?? 'Treaty Area';
      return {
        content: buildTreatyPopupHtml(props, featureName),
        selection: buildBoundaryContext('treaty', props, feature.geometry, click.lngLat, featureName),
        // An id-less feature clears any prior emphasis (the old
        // emphasizePlace contract) rather than lighting an unknown one.
        emphasis: feature.id === undefined || feature.id === null
          ? []
          : [{ source: SOURCE_ID, id: feature.id }]
      };
    }
  });

  map.on('mouseenter', OUTLINE_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', OUTLINE_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
