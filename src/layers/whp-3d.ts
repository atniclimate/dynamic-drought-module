/**
 * The desktop 3D Fire scene's static USFS Wildfire Hazard Potential drape.
 * The archive contains the published 2023 classes and stays unchanged.
 * Requested tiles map those known classes to increasing white opacity,
 * keeping the landscape visible and the orange fire perimeters legible.
 * Inside a mapped fire perimeter the drape draws nothing (`syncPerimeters`).
 * The companion legend carries the matching opacity scale and source limits.
 *
 * This presentation companion is owned by the lazy fire3d context module,
 * not the layer catalog. While it is mounted the flat Fuel risk layer
 * (`usfs-whp`) steps aside (layout visibility none) and comes back when the
 * drape is torn down, as hms-smoke-volume.ts does with the flat smoke veil;
 * the person's layer choices never change. Between the scene going active
 * and the drape mounting the flat layer still draws, like the smoke veil and
 * the perimeter ribbon. The drape stands down for the issuer-coloured row
 * (`usfs-whp-classes`), a deliberate Layer studio choice. An unavailable
 * archive leaves terrain and smoke as a partial scene, with the flat Fuel
 * risk layer, if on, as the degrade.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Position } from 'geojson';

import { WHP_3D_SHADE_CATEGORIES, WHP_3D_SHADE_QUALIFICATION } from '../config/whp-shade';
import { registerWhpShadeProtocol, setWhpShadePerimeters } from './whp-shade-protocol';
import { URLS } from '../config/urls';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import { getPerimeterSnapshot, onPerimeterSnapshotChange } from '../state/fire-perimeter-snapshot';
import { getFire3DGroundLayer, onFire3DGroundLayerChange } from '../state/fire3d-ground-layers';
import { registry } from '../state/registry';
import { FLAT_FUEL_RISK_KEY } from '../ui/fire3d-fuel-risk';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import { probeArchiveHeader } from '../util/pmtiles-probe';

const SOURCE_ID = 'whp-2023';
const LAYER_ID = 'whp-2023';
const LEGEND_KEY = 'whp-2023';

/** Released when the drape is torn down; watches the flat WHP layers. */
let releaseFlatLayerWatch: (() => void) | null = null;
/** Released when the drape is torn down; follows the console's "Fuel risk" switch. */
let releaseSwitchWatch: (() => void) | null = null;

/** Released when the drape is torn down; follows the fire perimeters. */
let releasePerimeterWatch: (() => void) | null = null;
/** The perimeter snapshot revision the drape is shaded with; 0 for none. */
let shadedRevision = 0;
/** The polygons of that revision, in an order-free form, which the mounted tiles were shaded with. */
let shadedPolygons = '';

/**
 * Fuel risk is fully transparent inside a fire perimeter (owner, 2026-10-11).
 * Take the perimeters the flat layer published (src/state/fire-perimeter-snapshot.ts),
 * hand them to the shading protocol, and reload the mounted drape's tiles
 * when the snapshot moved on from the one they were shaded with and the
 * polygons differ; loaded tiles stay drawn until their re-shaded copies arrive. Every perimeter the
 * layer holds counts, whatever its incident class. No layer, no perimeters
 * or unreadable geometry all mean the same thing: fuel risk draws whole.
 */
function syncPerimeters(map: maplibregl.Map): void {
  const { collection, revision } = getPerimeterSnapshot();
  if (revision === shadedRevision) return;
  shadedRevision = revision;
  const polygons: Position[][][] = [];
  let key = '';
  try {
    for (const { geometry } of collection?.features ?? []) {
      if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates);
      else if (geometry?.type === 'MultiPolygon') polygons.push(...geometry.coordinates);
    }
    key = polygons.map((polygon) => JSON.stringify(polygon)).sort().join();
  } catch (err) {
    console.warn('[whp-3d]', err);
    polygons.length = 0;
  }
  if (key === shadedPolygons) return;
  shadedPolygons = key;
  setWhpShadePerimeters(polygons);
  // Always the whole source: a tile list reloads only in-view tiles and leaves
  // MapLibre's out-of-view cache holding tiles cut to the old perimeters.
  if (map.getSource(SOURCE_ID)) map.refreshTiles(SOURCE_ID);
}

/** The drape's layout visibility under the console's "Fuel risk" switch (session only). */
const fuelRiskVisibility = (): 'visible' | 'none' => (getFire3DGroundLayer('fuelRisk') ? 'visible' : 'none');

/**
 * The legend and the map key follow the switch with the drape: a key never
 * describes a layer that is not drawn. Hidden, the layer and its source
 * stay mounted, so switching back on needs no new activation.
 */
function announceFuelRisk(): void {
  const on = getFire3DGroundLayer('fuelRisk');
  if (on) {
    showLegend(LEGEND_KEY, {
      order: LEGEND_ORDER.surface + 5,
      render: (body) =>
        renderSwatchLegend(
          body,
          'Wildfire hazard potential (3D view)',
          WHP_3D_SHADE_CATEGORIES.map((c) => ({
            color: `rgba(255, 255, 255, ${c.opacity})`,
            label: c.label
          })),
          WHP_3D_SHADE_QUALIFICATION
        )
    });
  } else {
    hideLegend(LEGEND_KEY);
  }
  // `mounted` tells the console its Fuel risk switch has a drape to act on.
  window.dispatchEvent(new CustomEvent('ddm:whp-shade', { detail: { layer: LAYER_ID, active: on, mounted: true } }));
}

/**
 * One issuer, one drawn copy. The issuer-coloured row (`usfs-whp-classes`)
 * is a deliberate Layer studio choice of the issuer's colours, so the drape
 * stands down for it. Fuel risk (`usfs-whp`, white, also the Long Range
 * recipe) is the drape's own presentation, so it steps aside for the
 * perimeter-masked drape instead (`showFlatFuelRisk`).
 */
function issuerColoursOn(): boolean {
  return registry.getActiveKeys().has('usfs-whp-classes');
}

/** Hide or restore the flat Fuel risk layer; its registry state is untouched. */
function showFlatFuelRisk(map: maplibregl.Map, visible: boolean): void {
  if (map.getLayer(FLAT_FUEL_RISK_KEY)) map.setLayoutProperty(FLAT_FUEL_RISK_KEY, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Probe the bundled archive, then add the raster source and drape layer
 * and register the legend. Idempotent. Returns false (nothing added) when
 * the issuer-coloured row is on, or when the archive is unreachable or
 * invalid; the caller degrades partially either way.
 */
export async function activateWhpDrape(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  if (issuerColoursOn()) return false;

  try {
    await probeArchiveHeader(URLS.whp2023PmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[whp-3d] invalid or unavailable archive.', err);
    }
    return false;
  }
  if (signal.aborted) return false;
  // The issuer colours can finish activating during the probe, before the watcher below exists.
  if (issuerColoursOn()) return false;
  // Before the source exists, so its first tiles are already cut and
  // entering the scene reloads nothing.
  syncPerimeters(map);

  try {
    registerWhpShadeProtocol();
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        url: `whp-shade://${URLS.whp2023PmtilesLocal}`,
        tileSize: 512,
        attribution: 'USFS Wildfire Hazard Potential 2023'
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        layout: { visibility: fuelRiskVisibility() },
        paint: {
          // The shading table carries each class's effective white opacity
          // (WHP_3D_SHADE_CATEGORIES), so the layer itself adds none.
          'raster-opacity': 1,
          // On terrain every fade frame redraws the draped ground, and each
          // perimeter-driven reload would repeat it.
          'raster-fade-duration': 0,
          // NEAREST, not MapLibre's default linear. This is a categorical
          // raster of seven issuer classes, and the archive is over-zoomed
          // well past its bake depth at the scene's framing. Linear
          // interpolation between two class colors produces a color that
          // appears in no legend: green blended into red reads as an
          // orange hazard the issuer never assigned to that ground, and
          // water blended into Very High reads as nothing at all. Crisp
          // class boundaries are the honest presentation of a
          // classification. MapLibre 4 had a known nearest-resampling
          // defect that could make this property inert. The test in
          // tests/fire3d-mode.spec.ts reads this paint property back and
          // proves only that this module still SETS it; it cannot prove
          // the renderer honours it, because the test runs against a
          // fake map with no GPU draw path. That the shipped renderer
          // DOES honour it rests on DR-009 (the exact maplibre-gl pin in
          // package.json) and on the raster draw path itself:
          // maplibre-gl/src/webgl/draw/draw_raster.ts, function drawTiles,
          // which picks gl.NEAREST when either `resampling` or
          // `raster-resampling` is 'nearest'; this layer sets only the
          // latter.
          'raster-resampling': 'nearest'
        }
      });
      // Added outside the layer controller, so this module re-asserts the
      // ruled chain itself (the hms-smoke-volume discipline): the drape id
      // is a CONDITION_SURFACE_IDS member and seats below every event
      // overlay and reference boundary.
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
  } catch (err) {
    console.warn('[whp-3d] drape setup failed.', err);
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    return false;
  }

  showFlatFuelRisk(map, false);
  announceFuelRisk();
  releaseSwitchWatch?.();
  releaseSwitchWatch = onFire3DGroundLayerChange((layer) => {
    if (layer !== 'fuelRisk') return;
    if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, 'visibility', fuelRiskVisibility());
    announceFuelRisk();
  });

  // Either flat layer can be switched on AFTER the scene is up (the Long
  // Range horizon adds Fuel risk). Fuel risk is hidden again each time it
  // is re-added; the issuer colours make the drape stand down, and turning
  // them back off does not resurrect it until the scene is re-entered,
  // which under-claims rather than over-claims.
  releaseFlatLayerWatch?.();
  releaseFlatLayerWatch = registry.on('change', () => {
    if (issuerColoursOn()) deactivateWhpDrape(map);
    else showFlatFuelRisk(map, false);
  });
  // The perimeter layer publishes each different collection it puts on the
  // map (its first, and after a pan or zoom), and null once it is off; the
  // same collection again reloads nothing.
  releasePerimeterWatch?.();
  releasePerimeterWatch = onPerimeterSnapshotChange(() => {
    syncPerimeters(map);
  });

  return true;
}

/**
 * Remove the drape layer, source, and legend, and give the flat Fuel risk
 * layer back its visibility. Defensive guards throughout; symmetric with activate.
 */
export function deactivateWhpDrape(map: maplibregl.Map): void {
  releaseFlatLayerWatch?.();
  releaseFlatLayerWatch = null;
  releaseSwitchWatch?.();
  releaseSwitchWatch = null;
  releasePerimeterWatch?.();
  releasePerimeterWatch = null;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  showFlatFuelRisk(map, true);
  hideLegend(LEGEND_KEY);
  window.dispatchEvent(new CustomEvent('ddm:whp-shade', { detail: { layer: LAYER_ID, active: false, mounted: false } }));
}
