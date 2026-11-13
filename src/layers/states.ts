/**
 * United States state-boundary layer (E1, national framing).
 *
 * Draws the state lines and the national border from the base map's own
 * archive (source `base`, layer `boundary`, kinds `state` and `country`: the
 * Census 1:500,000 inner lines and the U.S./Canada and U.S./Mexico lines baked
 * by scripts/build-base-tiles.mjs, so they meet the coast and each other at the
 * base map's scale) as a quiet slate line on a dark casing, the national border
 * the same as a state line, and the coast beside them (the archive has no
 * coastline: the land edge, and the Great Lakes' water edge, are drawn).
 * They sit in the reference band above the condition fills, so the border and
 * the coast stay legible over the Drought fill; the
 * hairline `base-country` under every fill (src/map/style.ts) remains the
 * fallback when States is off. The bundled Census
 * cartographic boundary file (public/data/us-states.geojson, 1:20,000,000,
 * scripts/build-states.mjs) stays the fully transparent click target and
 * carries the selected-state tint and outline. States are the fourth
 * selectable space alongside the Tribal, Treaty / BIA, and ecoregion
 * boundaries: clicking a state opens the impact briefing with the resource
 * routing resolved to that state.
 *
 * Stewardship: state boundaries are public administrative reference data, not
 * sovereign-jurisdiction polygons, so bundling them is consistent with the
 * no-redistribution hard rule. A state selection never carries the representation
 * caveat and never displaces a Tribal selection; the stewardship-ordered
 * resource list (Tribe's-own slot first) applies to every briefing.
 *
 * Cancellation (the cancellation invariant): the bundled-file fetch goes
 * through `fetchSharedJsonWithBudget` (DDM-P14-T06: the file is read by six
 * other consumers this session, so the transport is page-lifetime shared
 * under `US_STATES_SHARED_KEY`) with a per-call timeout and this module's own
 * master abort signal that fires on `deactivate` or a superseding `activate`,
 * matching the hardened usdm / nifc-fires / bia-reservations pattern; only
 * this module's own wait is cancelled, never the shared transport while
 * another consumer still needs it.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { STATE_OUTLINE_COLOR } from '../config/palette';
import { MAP_GROUND_COLOR } from '../config/interface-tokens';
import { buildStatePopupModel } from '../ui/popups';
import { buildPlaceConditionsHtml } from '../ui/popup-conditions';
import { buildBoundaryContext, resolveBoundaryTitle } from '../impact/context';
import { registerClickTarget } from '../map/interaction-coordinator';
import { fetchSharedJsonWithBudget, US_STATES_SHARED_KEY } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'states';
const SOURCE_ID = 'us-states';
const FILL_LAYER_ID = 'us-states-fill';
const CASING_LAYER_ID = 'us-states-casing';
const OUTLINE_LAYER_ID = 'us-states-outline';
const SELECTED_LAYER_ID = 'us-states-selected';
/**
 * The base map's North America archive (src/map/style.ts): its state lines and every national border it
 * holds (the U.S. with Canada and with Mexico, and Natural Earth's other borders inside the archive's box,
 * such as Mexico with Guatemala), all kind `state` or `country` in its `boundary` layer.
 */
const BASE_SOURCE_ID = 'base';
const STATE_LINES = {
  source: BASE_SOURCE_ID,
  'source-layer': 'boundary',
  filter: ['match', ['get', 'kind'], ['state', 'country'], true, false] as maplibregl.FilterSpecification
};

/**
 * The coast: the archive holds no coastline, so the edge of its `land` polygons is the coast (the line sits on
 * the land fill's own edge). The Atlas of Canada landmass takes in the Canadian Great Lakes while the Census
 * land leaves them out, so the five Great Lakes and Georgian Bay also get their own `water` polygon edge: it
 * lies on the land edge wherever one exists (within half a pixel at zoom 8) and fills in the Canadian shores.
 * Every other lake keeps no line. The box clip at 14N, 84N and 50W also leaves an edge there (far from the U.S.).
 * Tile clip edges are not drawn: the archive buffers 64 of 4096 units and MapLibre clips each tile's lines to it.
 */
const GREAT_LAKES = ['Lake Superior', 'Lake Michigan', 'Lake Huron', 'Lake Erie', 'Lake Ontario', 'Georgian Bay'];
const COASTS = [
  { id: 'us-coast', source: BASE_SOURCE_ID, 'source-layer': 'land' },
  {
    id: 'us-coast-lakes',
    source: BASE_SOURCE_ID,
    'source-layer': 'water',
    filter: ['all', ['==', ['get', 'kind'], 'lake'], ['match', ['get', 'name'], GREAT_LAKES, true, false]] as maplibregl.FilterSpecification
  }
] as const;
const coastCasingId = (id: string): string => `${id}-casing`;
const coastOutlineId = (id: string): string => `${id}-outline`;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [
  FILL_LAYER_ID,
  CASING_LAYER_ID,
  OUTLINE_LAYER_ID,
  SELECTED_LAYER_ID,
  ...COASTS.flatMap(({ id }) => [coastCasingId(id), coastOutlineId(id)])
] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor so the boundary stacks below
 * the basemap label glyphs, matching every other reference-polygon module.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call budget for the bundled-file fetch (same-origin, normally fast). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * E1 chrome targets (D-0.7.0-041 part 2, review E1.3): starting values for
 * the stewardship visual review at unit close. A 0.4 px hairline at roughly
 * 0.50 opacity at the national framing, easing to the regional weight by
 * zoom 8; the selected boosts stay constant so the chosen reference frame
 * reads at any zoom.
 */
const OUTLINE_WIDTH_NATIONAL = 0.4;
const OUTLINE_WIDTH_REGIONAL = 1.5;
const OUTLINE_WIDTH_SELECTED = 2.4;
const OUTLINE_OPACITY_NATIONAL = 0.5;
// Above every state highway and under the interstates at regional zoom (design pass 2026-11-13).
const OUTLINE_OPACITY_REGIONAL = 0.8;
const CASING_COLOR = MAP_GROUND_COLOR;

/**
 * One look for every line this module draws from the base archive: state lines, national borders (owner,
 * 2026-11-13: the same colour and weight as the state lines) and the coast. ["zoom"] stays the top-level input.
 */
type LinePaint = NonNullable<maplibregl.LineLayerSpecification['paint']>;
const CASING_PAINT: LinePaint = {
  'line-color': CASING_COLOR,
  'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 8, 2.8],
  'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.72, 8, 0.84]
};
// U4c chrome weights (headroom A5): with states default-on, the line must stay a quiet reference frame at
// EVERY zoom: hairline at the whole-US framing, a touch heavier once a region fills the view (E1: about half
// strength at the national framing).
const OUTLINE_PAINT: LinePaint = {
  'line-color': STATE_OUTLINE_COLOR,
  'line-width': ['interpolate', ['linear'], ['zoom'], 3, OUTLINE_WIDTH_NATIONAL, 8, OUTLINE_WIDTH_REGIONAL],
  'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, OUTLINE_OPACITY_NATIONAL, 8, OUTLINE_OPACITY_REGIONAL]
};

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
 * Fetch the bundled state boundaries and add the source, the transparent hit
 * fill, and the outline. Idempotent: if the source already exists the call is
 * a no-op. A missing or malformed bundle surfaces as `'error'` (the artifact
 * is committed; its absence is a deployment defect, unlike the deliberately
 * empty placeholder files).
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
    // Shared, page-lifetime: this call either starts the one transport this
    // session, or joins one another consumer already started. The parsed
    // value below is read-only here (handed straight to `map.addSource`,
    // never sorted, pushed, or written to), so sharing the reference is
    // safe.
    geojson = (await fetchSharedJsonWithBudget(
      US_STATES_SHARED_KEY,
      URLS.usStatesLocal,
      null,
      signal,
      FETCH_TIMEOUT_MS
    )) as FeatureCollection;
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[states] bundled state boundaries fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'US Census Bureau',
    // Stable per-feature ids for the selected-place emphasis (U3h).
    generateId: true
  });

  if (features.length === 0) {
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  // Transparent hit area: MapLibre hit-tests fill layers regardless of paint
  // opacity, so this carries the click-to-briefing affordance without adding
  // any visual weight over the thematic layers.
  // A quiet dark casing prevents the state hairline from disappearing on the
  // historical imagery while preserving the outline as a reference, not a
  // competing condition surface.
  map.addLayer(
    {
      id: CASING_LAYER_ID,
      type: 'line',
      ...STATE_LINES,
      paint: CASING_PAINT
    },
    beforeId
  );

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        // Transparent hit area by default; the selected state (U3h) takes a
        // faint slate tint so the chosen reference frame reads under an open
        // briefing without competing with the thematic surface.
        'fill-color': STATE_OUTLINE_COLOR,
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          0.08,
          0
        ]
      }
    },
    beforeId
  );

  map.addLayer(
    {
      id: OUTLINE_LAYER_ID,
      type: 'line',
      ...STATE_LINES,
      paint: OUTLINE_PAINT
    },
    beforeId
  );

  // The coast, in the state lines' own grey on the same casing, in the same reference band above the fills.
  for (const { id, ...spec } of COASTS) {
    const line = (lineId: string, paint: LinePaint): maplibregl.LineLayerSpecification =>
      ({ id: lineId, type: 'line', ...spec, layout: { 'line-join': 'round' }, paint });
    map.addLayer(line(coastCasingId(id), CASING_PAINT), beforeId);
    map.addLayer(line(coastOutlineId(id), OUTLINE_PAINT), beforeId);
  }

  // The selected state's outline, on the coarse click shape. STRUCTURE
  // MATTERS: MapLibre only accepts ["zoom"] as input to a TOP-LEVEL
  // step/interpolate, so the zoom curve wraps the feature-state case (the
  // inverted form validates but logs a style error; the 2026-07-12 console
  // inspection). It fades out by zoom 9, where the 1:20,000,000 shape strays
  // visibly from the drawn line; the selected tint stays.
  map.addLayer(
    {
      id: SELECTED_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': STATE_OUTLINE_COLOR,
        'line-width': OUTLINE_WIDTH_SELECTED,
        'line-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          7,
          ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
          9,
          0
        ]
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
  if (map.getLayer(SELECTED_LAYER_ID)) map.removeLayer(SELECTED_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getLayer(CASING_LAYER_ID)) map.removeLayer(CASING_LAYER_ID);
  for (const { id } of COASTS) {
    for (const layerId of [coastOutlineId(id), coastCasingId(id)]) if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Wire the click-to-popup handler and the hover cursor affordance on the hit
 * fill. Bound once at boot, independent of activation; MapLibre tolerates a
 * handler bound to a not-yet-existing layer ID.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'state-boundary',
    layerIds: [FILL_LAYER_ID],
    label: (feature) => resolveBoundaryTitle('state', feature.properties ?? null),
    respond: (feature, click, map) => {
      const props: GeoJsonProperties = feature.properties ?? null;
      return {
        model: buildStatePopupModel(props, buildPlaceConditionsHtml(map, click.point, feature)),
        selection: buildBoundaryContext('state', props, feature.geometry, click.lngLat),
        // An id-less feature clears any prior emphasis (the old
        // emphasizePlace contract) rather than lighting an unknown one.
        emphasis: feature.id === undefined || feature.id === null
          ? []
          : [{ source: SOURCE_ID, id: feature.id }]
      };
    }
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
