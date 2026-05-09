/**
 * Ecoregions layer: United States Environmental Protection Agency (EPA)
 * Level III Ecoregions for the Pacific Northwest (PNW), bundled as a local
 * GeoJSON file. Empty FeatureCollection placeholders are first-class; an
 * empty file results in a `'no-data'` status, not an error.
 *
 * Ported from the vanilla `app.js` `loadEcoregions` function. The Leaflet
 * `L.geoJSON` layer with a per-feature style function and `onEachFeature`
 * popup binding becomes a MapLibre GeoJSON source plus two layers:
 *
 *   - `ecoregions-fill`    fill polygons keyed by ecoregion name
 *   - `ecoregions-outline` thin outlines matching the fill color
 *
 * The fill color is resolved through a `match` data-driven expression keyed
 * off `US_L3NAME` (with `NA_L3NAME` and `name` as fallbacks via `coalesce`),
 * so a single source feeds both layers and color is computed by the GPU
 * rather than precomputed per feature.
 *
 * Status reporting uses `console.info` for now; M7 wires it to the real
 * LayerRegistry.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { ECOREGION_COLORS, ECOREGION_DEFAULT_COLOR } from '../config/palette';
import { URLS } from '../config/urls';
import { buildEcoregionPopupHtml } from '../ui/popups';
import { escapeHtml } from '../util/escape';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = 'ecoregions';
const FILL_LAYER_ID = 'ecoregions-fill';
const OUTLINE_LAYER_ID = 'ecoregions-outline';

/**
 * Layer ID before which the ecoregion layers should be inserted, when
 * present. The base style may declare a label layer named `'first-symbol'`
 * to mark the boundary between data layers and labels; if it does not
 * exist, layers are appended to the end (no `beforeId`).
 */
const BEFORE_LAYER_ID = 'first-symbol';

type EcoregionStatus = 'loading' | 'ready' | 'no-data' | 'error';

// ---------------------------------------------------------------------------
// activate / deactivate / bindPopups
// ---------------------------------------------------------------------------

/**
 * Add the ecoregions source and visual layers to the map. Idempotent:
 * if the source already exists the function returns without re-fetching;
 * missing layers are re-added so a prior `deactivate` cycle restores
 * cleanly.
 *
 * Empty FeatureCollection input yields a `'no-data'` status. The source is
 * added either way so a later `deactivate` has something to remove and a
 * subsequent `activate` does not need a special-case branch.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  setStatus('loading');

  // Idempotency: if the source is already on the map, just make sure the
  // visual layers exist and return.
  if (map.getSource(SOURCE_ID)) {
    ensureLayers(map);
    setStatus('ready');
    return;
  }

  let geojson: FeatureCollection;
  try {
    geojson = await fetchLocalGeoJSON(URLS.ecoregionsLocal);
  } catch (err) {
    console.warn('Ecoregion file fetch failed.', err);
    setStatus('error');
    return;
  }

  const features = geojson.features ?? [];

  // Add the source unconditionally so deactivate / re-activate is a clean
  // remove and re-add path. An empty FeatureCollection is a valid source.
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson
  });

  if (features.length === 0) {
    // Placeholder file; the sidebar (M8) renders the
    // "empty placeholder (see data/README.md)" pill text.
    setStatus('no-data');
    return;
  }

  // Build the legend name set as we add layers. A MapLibre data-driven
  // `match` expression handles the per-feature color lookup at render time;
  // see `buildFillColorExpression`.
  const seenNames = new Set<string>();
  for (const f of features) {
    const name = pickEcoregionName(f.properties);
    if (name) seenNames.add(name);
  }

  ensureLayers(map);
  renderLegend(map, seenNames);
  setStatus('ready');
}

/**
 * Remove the ecoregions source and both visual layers from the map, and
 * hide the sidebar legend panel. Removing the source means a later
 * `activate` re-fetches the GeoJSON; this is acceptable because the file
 * is local and small, and avoids stale-source surprises if the placeholder
 * is repopulated between sessions.
 */
export function deactivate(map: maplibregl.Map): void {
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend();
}

/**
 * Wire a click handler on the fill layer that opens a `maplibregl.Popup`
 * at the click location with the ecoregion popup HTML. Safe to call once
 * at boot; the handler is bound to the layer ID, not the layer instance,
 * so it survives `deactivate` / `activate` cycles.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e: maplibregl.MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const name = pickEcoregionName(feature.properties) ?? 'Ecoregion';
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(buildEcoregionPopupHtml(name))
      .addTo(map);
  });

  // Hover affordance: cursor turns to a pointer over fill polygons.
  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read the human-readable ecoregion name from the GeoJSON properties bag.
 * Mirrors the vanilla `pickEcoregionName`: prefer `US_L3NAME`, then
 * `NA_L3NAME`, then `name`. Returns `null` if none are present.
 */
function pickEcoregionName(props: GeoJsonProperties): string | null {
  if (!props) return null;
  const us = props.US_L3NAME;
  const na = props.NA_L3NAME;
  const fallback = props.name;
  return (
    (typeof us === 'string' && us) ||
    (typeof na === 'string' && na) ||
    (typeof fallback === 'string' && fallback) ||
    null
  );
}

/**
 * Add the fill and outline layers to the map if they are not already
 * present. Inserts before `'first-symbol'` if such a layer exists in the
 * style, otherwise appends.
 */
function ensureLayers(map: maplibregl.Map): void {
  const beforeId = map.getLayer(BEFORE_LAYER_ID) ? BEFORE_LAYER_ID : undefined;
  const fillColor = buildFillColorExpression();

  if (!map.getLayer(FILL_LAYER_ID)) {
    map.addLayer(
      {
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-color': fillColor,
          'fill-opacity': 0.4
        }
      },
      beforeId
    );
  }

  if (!map.getLayer(OUTLINE_LAYER_ID)) {
    map.addLayer(
      {
        id: OUTLINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': fillColor,
          'line-width': 0.6,
          'line-opacity': 0.7
        }
      },
      beforeId
    );
  }
}

/**
 * Build the data-driven `match` expression that maps a feature's ecoregion
 * name to its palette color. Reads `US_L3NAME` first, falling back through
 * `NA_L3NAME` and `name` via `coalesce`, then falling back to
 * `ECOREGION_DEFAULT_COLOR` for any name not in the palette.
 *
 * The MapLibre `match` expression requires a flat sequence of label-output
 * pairs followed by the default; see the MapLibre Style Spec.
 */
function buildFillColorExpression(): maplibregl.ExpressionSpecification {
  // Each palette entry contributes a [name, color] pair to the match list.
  const matchPairs: (string | string[])[] = [];
  for (const [name, color] of Object.entries(ECOREGION_COLORS)) {
    matchPairs.push(name, color);
  }

  // The keying value: try US_L3NAME, then NA_L3NAME, then name; fall back
  // to an empty string so `match` reaches its default branch.
  const keyExpr: maplibregl.ExpressionSpecification = [
    'coalesce',
    ['get', 'US_L3NAME'],
    ['get', 'NA_L3NAME'],
    ['get', 'name'],
    ''
  ];

  // The match expression itself. The MapLibre type definitions cover this
  // shape under ExpressionSpecification; the cast is narrow and isolated.
  // Justification: the `match` operator's variadic [label, output, ...,
  // default] form is awkward to express in TypeScript without a cast, and
  // the runtime shape matches the Style Spec exactly.
  return [
    'match',
    keyExpr,
    ...matchPairs,
    ECOREGION_DEFAULT_COLOR
  ] as unknown as maplibregl.ExpressionSpecification;
}

/**
 * Generic fetch helper for bundled GeoJSON files in `public/data/`. Throws
 * on HTTP error or non-FeatureCollection payload; the caller catches and
 * sets the layer status to `'error'`.
 */
async function fetchLocalGeoJSON(path: string): Promise<FeatureCollection> {
  const resp = await fetch(path, { cache: 'default' });
  if (!resp.ok) {
    throw new Error(`Local GeoJSON ${path}: HTTP ${resp.status}`);
  }
  // `unknown` then a structural check, rather than `any`, keeps strict
  // mode honest. The shape check matches the vanilla baseline.
  const json: unknown = await resp.json();
  if (
    !json ||
    typeof json !== 'object' ||
    (json as { type?: unknown }).type !== 'FeatureCollection'
  ) {
    throw new Error(`Local GeoJSON ${path}: not a FeatureCollection`);
  }
  return json as FeatureCollection;
}

/**
 * Write the ecoregion legend list. One `<li>` per unique ecoregion name
 * actually present in the active GeoJSON, sorted alphabetically, each with
 * a colored swatch from `ECOREGION_COLORS` (defaulting to
 * `ECOREGION_DEFAULT_COLOR` for any name not in the palette). Reveals the
 * legend panel.
 *
 * The `map` parameter is reserved for future use (for example, scoping the
 * legend to features actually visible at the current zoom); it is unused
 * today.
 */
function renderLegend(_map: maplibregl.Map, names: ReadonlySet<string>): void {
  const panel = document.getElementById('ecoregion-legend-panel');
  const list = document.getElementById('ecoregion-legend');
  if (!panel || !list) return;
  panel.hidden = false;

  const sorted = Array.from(names).sort();
  list.innerHTML = sorted
    .map((n) => {
      const color = ECOREGION_COLORS[n] ?? ECOREGION_DEFAULT_COLOR;
      // The swatch color is a known constant; the name is escaped for
      // safe interpolation.
      return `<li><span class="swatch" style="background:${color}"></span>${escapeHtml(n)}</li>`;
    })
    .join('');
}

/**
 * Hide the ecoregion legend panel. Symmetric counterpart to the reveal
 * inside `renderLegend`. Fixes the [future] item in TODO.md noting that
 * the drought layer has the symmetric hide and the ecoregions layer did
 * not.
 */
function hideLegend(): void {
  const panel = document.getElementById('ecoregion-legend-panel');
  if (panel) panel.hidden = true;
  const list = document.getElementById('ecoregion-legend');
  if (list) list.innerHTML = '';
}

/**
 * Status reporting placeholder. Milestone 7 (M7) wires real reporting
 * through the LayerRegistry; for now we log the canonical state names so
 * regressions are visible in the developer console.
 */
function setStatus(status: EcoregionStatus): void {
  console.info(`[ecoregions] status=${status}`);
}
