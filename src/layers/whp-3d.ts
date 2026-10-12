/**
 * The desktop 3D Fire scene's static USFS Wildfire Hazard Potential drape.
 * The archive contains the published 2023 classes and stays unchanged.
 * Requested tiles map those known classes to increasing white opacity,
 * keeping the landscape visible and the orange fire perimeters legible.
 * Inside a mapped fire perimeter the drape draws nothing (`syncPerimeters`).
 * The companion legend carries the matching opacity scale and source limits.
 *
 * This presentation companion is owned by the lazy fire3d context module,
 * not the layer catalog. It stands down whenever the flat WHP surface is
 * active, so one product never draws twice. An unavailable archive leaves
 * terrain and smoke available as a partial scene.
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

/** The flat catalog layer that draws the SAME issuer product, live. */
const FLAT_WHP_LAYER_KEY = 'usfs-whp';

/** Released when the drape is torn down; watches for the flat layer. */
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
 * One issuer, one legend, per layer: never draw this drape while the flat
 * `usfs-whp` catalog surface is on.
 *
 * The two render the same USFS product from the same service. Stacked,
 * they would double the translucency of one classification, print two
 * legends for one issuer, and show the PNW bake box as a hard rectangular
 * seam over the live CONUS layer. The wildfire cluster's season-ahead
 * horizon activates exactly that flat layer
 * (src/config/clusters.ts:119), so this is a real pairing, not a
 * hypothetical one.
 *
 * The flat layer wins when both are eligible: it is live rather than a
 * snapshot, and it covers the conterminous United States rather than the
 * Pacific Northwest box. It also drapes over terrain on its own, so the
 * 3D scene still shows hazard relief; it simply shows the better copy.
 */
function flatWhpLayerIsOn(): boolean {
  return registry.getActiveKeys().has(FLAT_WHP_LAYER_KEY);
}

/**
 * Probe the bundled archive, then add the raster source and drape layer
 * and register the legend. Idempotent. Returns false (nothing added) when
 * the flat WHP surface already covers this ground, or when the archive is
 * unreachable or invalid; the caller degrades partially either way.
 */
export async function activateWhpDrape(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  if (flatWhpLayerIsOn()) return false;

  try {
    await probeArchiveHeader(URLS.whp2023PmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[whp-3d] invalid or unavailable archive.', err);
    }
    return false;
  }
  if (signal.aborted) return false;
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
          // DOES honour it rests on DR-009 (MapLibre 6.6.0, pinned at
          // package.json:72) and on the 6.6.0 raster draw path itself:
          // node_modules/maplibre-gl/dist/maplibre-gl-dev.mjs, function
          // drawTiles, the line reading
          // `layer.paint.get("resampling") === "nearest" ||
          // layer.paint.get("raster-resampling") === "nearest" ? gl.NEAREST
          // : gl.LINEAR` (line 18332 in the 6.6.0 package), which selects
          // GL's nearest-texel filter when either the deprecated
          // `resampling` or this `raster-resampling` property is 'nearest';
          // this layer sets only the latter.
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

  announceFuelRisk();
  releaseSwitchWatch?.();
  releaseSwitchWatch = onFire3DGroundLayerChange((layer) => {
    if (layer !== 'fuelRisk') return;
    if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, 'visibility', fuelRiskVisibility());
    announceFuelRisk();
  });

  // The flat layer can be switched on AFTER the scene is up (the
  // season-ahead horizon does exactly that). Watch for it and stand down
  // rather than stacking two copies of one issuer. The reverse is not
  // symmetric on purpose: switching the flat layer back off does not
  // resurrect the drape until the scene is re-entered, which
  // under-claims rather than over-claims and needs no disclosure.
  releaseFlatLayerWatch?.();
  releaseFlatLayerWatch = registry.on('change', () => {
    if (flatWhpLayerIsOn()) deactivateWhpDrape(map);
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
 * Remove the drape layer, source, and legend. Defensive guards throughout;
 * symmetric with activate.
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
  hideLegend(LEGEND_KEY);
  window.dispatchEvent(new CustomEvent('ddm:whp-shade', { detail: { layer: LAYER_ID, active: false, mounted: false } }));
}
