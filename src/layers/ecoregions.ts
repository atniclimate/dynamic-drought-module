/**
 * Ecoregions layer: United States Environmental Protection Agency (EPA) Omernik
 * Level III and Level IV ecoregions for the Pacific Northwest (PNW), rendered
 * from a baked PMTiles vector bundle (scripts/build-ecoregion-tiles.mjs).
 *
 * Phase D Phase 8 turned ecoregions from an empty-placeholder GeoJSON layer into
 * a selectable space on equal footing with the Tribal-boundary selection: the
 * bundle ships two source-layers (`ecoregions-l3`, `ecoregions-l4`) and a
 * sidebar drill-down selector switches which level is drawn and clickable. A
 * click on either level opens the drought-impact briefing for that ecoregion
 * (the briefing model already treats `'ecoregion'` as a first-class boundary
 * kind). Ecoregions are a landscape representation, not a jurisdiction, so they
 * carry no sovereignty caveat; the layers are inserted at the bottom of the
 * overlay stack so an ecoregion fill never obscures a Tribal, Treaty, or Bureau
 * of Indian Affairs (BIA) boundary above it.
 *
 * Both levels are colored by parent Level III name (`US_L3NAME`) through one
 * data-driven `match` expression, so Level IV reads as a finer subdivision of
 * the same Level III hue rather than 914 unrelated colors. The source vintage
 * and simplification are recorded in the bundle attribution (the honesty guard;
 * the overlay never implies precision the 2012 source does not carry).
 */

import type * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { ECOREGION_COLORS, ECOREGION_DEFAULT_COLOR } from '../config/palette';
import { matchExpression } from '../config/style-expressions';
import { URLS } from '../config/urls';
import { firstLayerIdAbove, BOTTOM_STACK_IDS } from '../map/layer-order';
import { buildEcoregionPopupHtml } from '../ui/popups';
import { buildBoundaryContext } from '../impact/context';
import { registerClickTarget } from '../map/interaction-coordinator';
import { escapeHtml } from '../util/escape';
import { isObject } from '../util/guards';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER } from '../ui/legend-registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYER_KEY = 'ecoregions';
const SOURCE_ID = 'ecoregions';

/** Source-layer names baked into the PMTiles bundle. */
const L3_SOURCE_LAYER = 'ecoregions-l3';
const L4_SOURCE_LAYER = 'ecoregions-l4';
type EcoregionLevel = typeof L3_SOURCE_LAYER | typeof L4_SOURCE_LAYER;

/** One fill plus one outline layer per level. */
const L3_FILL_ID = 'ecoregions-l3-fill';
const L3_OUTLINE_ID = 'ecoregions-l3-outline';
const L4_FILL_ID = 'ecoregions-l4-fill';
const L4_OUTLINE_ID = 'ecoregions-l4-outline';
const ALL_LAYER_IDS = [L3_FILL_ID, L3_OUTLINE_ID, L4_FILL_ID, L4_OUTLINE_ID] as const;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = ALL_LAYER_IDS;

/** The MapLibre source URL: the PMTiles protocol over the bundled archive. */
const PMTILES_URL = 'pmtiles://' + URLS.ecoregionsPmtilesLocal;

const LEVEL_NOTE: Record<EcoregionLevel, string> = {
  [L3_SOURCE_LAYER]: 'EPA Omernik Level III ecoregions; 2012 delineation, simplified for display.',
  [L4_SOURCE_LAYER]:
    'EPA Omernik Level IV ecoregions (finer subdivisions, colored by parent Level III); 2012 delineation, simplified for display.'
};

/**
 * The states this layer can actually reach. `'no-data'` was declared here but
 * never written (ARCH-16): the PMTiles archive either resolves and renders
 * (`'ready'`) or fails to resolve (`'error'`), and nothing inspects a tile for
 * emptiness. Declaring a state the module cannot produce misreads as coverage
 * the layer does not have, so it is gone; restore it only alongside a real
 * empty-viewport check.
 */
type EcoregionStatus = 'loading' | 'ready' | 'error';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Which level is currently drawn and clickable. Level III is the default. */
let activeLevel: EcoregionLevel = L3_SOURCE_LAYER;
/** Level III names seen in loaded tiles, accumulated for the legend. */
const legendNames = new Set<string>();
/** The idle handler that refreshes the legend while the layer is active. */
let idleHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// activate / deactivate / bindPopups
// ---------------------------------------------------------------------------

/**
 * Add the ecoregion vector source and the four level layers. Idempotent: a
 * re-activation with the source present only re-asserts the layers and the
 * active-level visibility, so a URL-restore or toggle-cycle never stacks
 * duplicates.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  setStatus('loading');

  if (!map.getSource(SOURCE_ID)) {
    // The stable EPA codes become the feature ids so feature-state
    // emphasis addresses an ECOREGION (every fragment sharing the code
    // lights together), not one tile-clipped polygon.
    map.addSource(SOURCE_ID, {
      type: 'vector',
      url: PMTILES_URL,
      promoteId: {
        [L3_SOURCE_LAYER]: 'US_L3CODE',
        [L4_SOURCE_LAYER]: 'US_L4CODE'
      }
    });
  }
  ensureLayers(map);
  applyLevelVisibility(map);
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.reference,
    render: (body) => renderLegendSection(map, body)
  });
  startLegendUpdates(map);
  markReadyWhenLoaded(map);
}

/**
 * Remove the ecoregion layers and source, hide the legend, and stop the legend
 * updater. Symmetric with `activate`; safe to call when never activated.
 */
export function deactivate(map: maplibregl.Map): void {
  detachReadyWatchers(map);
  stopLegendUpdates(map);
  for (const id of ALL_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  legendNames.clear();
  hideLegend(LAYER_KEY);
}

/**
 * Register the click target for both level fills with the
 * InteractionCoordinator (one response per click; D-0.7.0-058 ruling 5)
 * and wire hover cursors. Only the visible level renders features, so
 * the active-level selector decides which ecoregion a click selects.
 * The clicked feature carries `US_L3NAME` and (at Level IV) `US_L4NAME`;
 * the resolved name becomes the response title and the briefing land
 * title, and the geometry yields the bounding box the briefing uses to
 * clip live queries.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'ecoregion-watershed',
    layerIds: [L3_FILL_ID, L4_FILL_ID],
    label: (feature) =>
      pickName(feature.properties ?? null, levelForFill(feature.layer.id)),
    respond: (feature, click) => {
      const props = feature.properties ?? null;
      const level = levelForFill(feature.layer.id);
      const name = pickName(props, level);
      const parentL3 = level === 'IV' ? pickL3Name(props) : null;
      return {
        content: buildEcoregionPopupHtml(name, parentL3 ? { level, parentL3 } : { level }),
        selection: buildBoundaryContext('ecoregion', props, feature.geometry, click.lngLat, name)
      };
    }
  });

  for (const fillId of [L3_FILL_ID, L4_FILL_ID]) {
    map.on('mouseenter', fillId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', fillId, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}

/** The ecoregion level a fill layer id renders. */
function levelForFill(fillId: string): 'III' | 'IV' {
  return fillId === L4_FILL_ID ? 'IV' : 'III';
}

// ---------------------------------------------------------------------------
// Layers and visibility
// ---------------------------------------------------------------------------

/**
 * Add the four ecoregion layers if absent, inserted beneath every other overlay
 * so an ecoregion fill never obscures a Tribal, Treaty, or BIA boundary. The
 * base style has no `first-symbol` label layer, so overlays stack by activation
 * order; this anchors the ecoregion layers to the bottom of that stack.
 */
function ensureLayers(map: maplibregl.Map): void {
  const beforeId = bottomOverlayBeforeId(map);
  const fillColor = buildFillColorExpression();

  addFillAndOutline(map, L3_SOURCE_LAYER, L3_FILL_ID, L3_OUTLINE_ID, fillColor, 0.4, 0.6, 0.65, beforeId);
  addFillAndOutline(map, L4_SOURCE_LAYER, L4_FILL_ID, L4_OUTLINE_ID, fillColor, 0.32, 0.5, 0.5, beforeId);
}

function addFillAndOutline(
  map: maplibregl.Map,
  sourceLayer: string,
  fillId: string,
  outlineId: string,
  fillColor: maplibregl.ExpressionSpecification,
  fillOpacity: number,
  lineWidth: number,
  lineOpacity: number,
  beforeId: string | undefined
): void {
  if (!map.getLayer(fillId)) {
    map.addLayer(
      {
        id: fillId,
        type: 'fill',
        source: SOURCE_ID,
        'source-layer': sourceLayer,
        paint: {
          'fill-color': fillColor,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            Math.min(fillOpacity + 0.15, 1),
            fillOpacity
          ]
        }
      },
      beforeId
    );
  }
  if (!map.getLayer(outlineId)) {
    map.addLayer(
      {
        id: outlineId,
        type: 'line',
        source: SOURCE_ID,
        'source-layer': sourceLayer,
        paint: {
          'line-color': fillColor,
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            lineWidth + 1,
            lineWidth
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.95,
            lineOpacity
          ]
        }
      },
      beforeId
    );
  }
}

/** Show the active level's layers and hide the other level's. */
function applyLevelVisibility(map: maplibregl.Map): void {
  const l3Visible = activeLevel === L3_SOURCE_LAYER;
  setVisible(map, L3_FILL_ID, l3Visible);
  setVisible(map, L3_OUTLINE_ID, l3Visible);
  setVisible(map, L4_FILL_ID, !l3Visible);
  setVisible(map, L4_OUTLINE_ID, !l3Visible);
}

function setVisible(map: maplibregl.Map, layerId: string, visible: boolean): void {
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * Studio-facing display-level facade (swarm finding R2 H3): the Place
 * studio must draw the level its selection belongs to, or the selected
 * feature-state lands on a hidden source-layer and the emphasis is
 * invisible. Returns the PREVIOUS level so the caller can restore it on
 * studio exit. Keeps the legend select (when mounted) and the legend
 * note in sync, exactly as the select's own change handler does.
 */
export function setEcoregionDisplayLevel(
  map: maplibregl.Map,
  level: 'ecoregions-l3' | 'ecoregions-l4'
): 'ecoregions-l3' | 'ecoregions-l4' {
  const previous = activeLevel;
  if (level === previous) return previous;
  activeLevel = level;
  applyLevelVisibility(map);
  updateLegendNote();
  const select = document.querySelector<HTMLSelectElement>('#ecoregion-level');
  if (select) select.value = activeLevel;
  refreshLegend(map);
  return previous;
}

/**
 * The id of the first overlay layer that is not the basemap and not an
 * ecoregion layer, so new ecoregion layers insert beneath it. Returns undefined
 * when no such layer exists yet (ecoregions then append directly over the
 * basemap, which is still the bottom of the overlay stack).
 */
function bottomOverlayBeforeId(map: maplibregl.Map): string | undefined {
  // Skip the WHOLE permanent bottom stack (background, basemap, satellite,
  // hillshade; layer-order.ts), not a hardcoded pair: with satellite or
  // hillshade activated first, the old two-id skip made them the beforeId
  // and buried the ecoregions under opaque imagery (the U4 stage-5
  // adversarial major 2).
  return firstLayerIdAbove(map, [
    ...BOTTOM_STACK_IDS,
    ...(ALL_LAYER_IDS as readonly string[])
  ]);
}

/**
 * Build the data-driven `match` expression mapping a feature's parent Level III
 * name to its palette color, with `ECOREGION_DEFAULT_COLOR` for any name not in
 * the palette. Keyed on `US_L3NAME` (with `NA_L3NAME` and `name` fallbacks),
 * which both Level III and Level IV features carry.
 */
function buildFillColorExpression(): maplibregl.ExpressionSpecification {
  const keyExpr: maplibregl.ExpressionSpecification = [
    'coalesce',
    ['get', 'US_L3NAME'],
    ['get', 'NA_L3NAME'],
    ['get', 'name'],
    ''
  ];
  // `matchExpression` does the head-pair/tail split the Style Spec tuple type
  // requires. For every non-empty palette, and so for ECOREGION_COLORS as
  // shipped, the emitted array is the same one the older cast-and-spread form
  // produced; for an empty palette the two disagree and both are invalid, so
  // the helper throws instead of emitting either.
  return matchExpression(
    keyExpr,
    Object.entries(ECOREGION_COLORS),
    ECOREGION_DEFAULT_COLOR,
    'ECOREGION_COLORS'
  );
}

// ---------------------------------------------------------------------------
// Controls (the Level III / Level IV drill-down)
// ---------------------------------------------------------------------------

/**
 * Build the ecoregion legend section: the Level III/IV detail selector, the
 * (initially empty) name list, and the level note. The unified legend registry
 * creates and destroys this section per activation, so the selector is built
 * and its change handler bound here (each show). The idle-driven refreshLegend
 * fills the list, which is why it ships empty; switching the level toggles
 * which level's layers are visible (and clickable) and refreshes the list.
 */
function renderLegendSection(map: maplibregl.Map, body: HTMLElement): void {
  body.innerHTML =
    '<h3 class="legend-section-title">Ecoregion key</h3>' +
    '<label class="legend-control">' +
    '<span class="legend-control-label">Detail level</span>' +
    '<select id="ecoregion-level" class="legend-select" aria-label="Ecoregion detail level">' +
    `<option value="${L3_SOURCE_LAYER}">Level III (broad)</option>` +
    `<option value="${L4_SOURCE_LAYER}">Level IV (detailed)</option>` +
    '</select>' +
    '</label>' +
    '<ul id="ecoregion-legend" class="legend ecoregion-legend"></ul>' +
    `<p class="legend-note" id="ecoregion-legend-note">${escapeHtml(LEVEL_NOTE[activeLevel])}</p>`;

  const select = body.querySelector<HTMLSelectElement>('#ecoregion-level');
  if (!select) return;
  select.value = activeLevel;
  select.addEventListener('change', () => {
    activeLevel = select.value === L4_SOURCE_LAYER ? L4_SOURCE_LAYER : L3_SOURCE_LAYER;
    applyLevelVisibility(map);
    updateLegendNote();
    refreshLegend(map);
  });
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

/**
 * Start refreshing the legend on every map idle while the layer is active. The
 * legend lists the Level III names found in loaded tiles, accumulating as the
 * user pans so it fills in rather than flickering with the viewport.
 */
function startLegendUpdates(map: maplibregl.Map): void {
  if (idleHandler) return;
  idleHandler = () => refreshLegend(map);
  map.on('idle', idleHandler);
  refreshLegend(map);
}

function stopLegendUpdates(map: maplibregl.Map): void {
  if (idleHandler) {
    map.off('idle', idleHandler);
    idleHandler = null;
  }
}

/**
 * Query the active level's loaded features for their parent Level III names,
 * add any new ones to the accumulator, and render the legend list. Both levels
 * carry `US_L3NAME`, so the legend is the same set of Level III hues whichever
 * level is drawn.
 */
function refreshLegend(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) return;
  const features = map.querySourceFeatures(SOURCE_ID, { sourceLayer: activeLevel });
  for (const f of features) {
    const name = pickL3Name(f.properties);
    if (name) legendNames.add(name);
  }
  renderLegend();
  updateLegendNote();
}

function renderLegend(): void {
  const list = document.getElementById('ecoregion-legend');
  if (!list) return;
  const sorted = Array.from(legendNames).sort();
  list.innerHTML = sorted
    .map((n) => {
      const color = ECOREGION_COLORS[n] ?? ECOREGION_DEFAULT_COLOR;
      return `<li><span class="swatch" style="background:${color}"></span>${escapeHtml(n)}</li>`;
    })
    .join('');
}

function updateLegendNote(): void {
  const note = document.getElementById('ecoregion-legend-note');
  if (note) note.textContent = LEVEL_NOTE[activeLevel];
}

// ---------------------------------------------------------------------------
// Status and property helpers
// ---------------------------------------------------------------------------

/**
 * The pending ready-watcher pair, held at module level so a deactivation
 * that lands BEFORE the source finishes loading can detach them. Without
 * this, each toggle-on/off-before-ready cycle orphaned a listener pair on
 * the shared map (and the orphans would react to the next activation's
 * source, which reuses the same source id).
 */
let readyWatchers: {
  onData: (e: maplibregl.MapSourceDataEvent) => void;
  onError: (e: maplibregl.ErrorEvent) => void;
} | null = null;

/**
 * Read the source id off an error event. MapLibre reports source failures
 * through `error` with the failing source's id attached by the style's
 * evented-parent data, but the v6 `ErrorEvent` type declares only `error`,
 * so the id is read through a guard instead of an assertion. A generic map
 * error carries no id and is ignored, exactly as before.
 */
function errorSourceId(e: maplibregl.ErrorEvent): string | null {
  return isObject(e) && typeof e.sourceId === 'string' ? e.sourceId : null;
}

function detachReadyWatchers(map: maplibregl.Map): void {
  if (!readyWatchers) return;
  map.off('sourcedata', readyWatchers.onData);
  map.off('error', readyWatchers.onError);
  readyWatchers = null;
}

/**
 * Flip the status pill to `ready` once the source has loaded its first tiles,
 * or to `error` if the source fails (a missing or malformed bundle). The
 * listeners self-remove on either outcome, and `deactivate` detaches a pair
 * still pending, so a toggle cycle cannot leak them.
 */
function markReadyWhenLoaded(map: maplibregl.Map): void {
  detachReadyWatchers(map);
  if (map.isSourceLoaded(SOURCE_ID)) {
    setStatus('ready');
    return;
  }
  const onData = (e: maplibregl.MapSourceDataEvent): void => {
    if (e.sourceId !== SOURCE_ID) return;
    if (map.isSourceLoaded(SOURCE_ID)) {
      setStatus('ready');
      detachReadyWatchers(map);
    }
  };
  const onError = (e: maplibregl.ErrorEvent): void => {
    if (errorSourceId(e) !== SOURCE_ID) return;
    console.warn('Ecoregion PMTiles source error.', e.error);
    setStatus('error');
    detachReadyWatchers(map);
  };
  readyWatchers = { onData, onError };
  map.on('sourcedata', onData);
  map.on('error', onError);
}

/** Read the parent Level III name from a feature's properties. */
function pickL3Name(props: GeoJsonProperties): string | null {
  return firstStringProp(props, ['US_L3NAME', 'NA_L3NAME', 'name']);
}

/** Resolve the display name for a clicked feature at the given level. */
function pickName(props: GeoJsonProperties, level: 'III' | 'IV'): string {
  if (level === 'IV') {
    return firstStringProp(props, ['US_L4NAME', 'US_L3NAME', 'NA_L3NAME', 'name']) ?? 'Ecoregion';
  }
  return pickL3Name(props) ?? 'Ecoregion';
}

function firstStringProp(props: GeoJsonProperties, keys: readonly string[]): string | null {
  if (!props) return null;
  for (const key of keys) {
    const v = (props as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function setStatus(status: EcoregionStatus): void {
  registry.setStatus(LAYER_KEY, status);
}
