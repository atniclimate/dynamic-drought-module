import { expect, test, type Page } from '@playwright/test';

import {
  FIRE3D_CAMERA_TRANSITION_MS,
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_NON_PREDICTION_NOTE,
  FIRE3D_PITCH_DEGREES,
  FIRE3D_SKY_CLEAR_SPECIFICATION,
  FIRE3D_SKY_SPECIFICATION,
  FIRE3D_TERRAIN_EXAGGERATION,
  PERIMETER_RIBBON_QUALIFICATION,
  PERIMETER_RIBBON_SLAB_COUNT,
  perimeterRibbonSlabOpacity
} from '../src/config/fire3d-presentation';
import {
  DRAPE_OPACITY,
  HMS_VOLUME_QUALIFICATION,
  STRUCTURES_QUALIFICATION,
  USFS_WHP_PRESENTATION,
  WILDFIRE_STATIC_COLOR
} from '../src/config/wildfire-presentation';
import { WILDFIRE_PULSE_PAINT_TARGETS } from '../src/layers/nifc-fires';
import { PERIMETER_RIBBON_LAYER_IDS } from '../src/layers/nifc-perimeter-ribbon';
import { EVENT_OVERLAY_IDS } from '../src/map/layer-order';
import {
  getFire3DStatus,
  setFire3DActive,
  shouldFire3DBeActive
} from '../src/map/fire3d';
import {
  getFire3DPreference,
  seedFire3DPreference,
  setFire3DPreference
} from '../src/state/fire3d-store';
import {
  activateContextLayers,
  deactivateContextLayers
} from '../src/map/fire3d-context';
import { registry } from '../src/state/registry';
import { parseFire3dParam, syncFire3dParam } from '../src/state/url';
import {
  PMTILES_V3_HEADER_PREFIX,
  captureWarnings,
  fakeMapHarness,
  installFakeBrowser
} from './map-harness';
import { gotoApp, layerCheckbox, search, waitForLayerSettled } from './helpers';
import {
  NIFC_STUB,
  PLANTS_STUB_FC,
  PNW_POLYGON,
  stubWildfireFeeds
} from './wildfire-fixtures';

/**
 * W3/W4 desktop 3D Fire mode.
 *
 * Node-level cases drive the orchestrator against the shared fake map
 * (tests/map-harness.ts): the production build carries no dev map handle,
 * so terrain/sky/camera truth is asserted here at the module seam, and the
 * browser cases assert the production-observable stamps
 * (data-ddm-fire3d / data-ddm-fire3d-smoke on the document element, the
 * control chrome, and the URL).
 */

// ---------------------------------------------------------------------------
// Node: URL parameter round trip (the heatday idiom)
// ---------------------------------------------------------------------------

test('fire3d parses only the exact single token true', () => {
  expect(parseFire3dParam(new URLSearchParams(''))).toBe(false);
  expect(parseFire3dParam(new URLSearchParams('fire3d=true'))).toBe(true);
  expect(parseFire3dParam(new URLSearchParams('fire3d=1'))).toBe(false);
  expect(parseFire3dParam(new URLSearchParams('fire3d=TRUE'))).toBe(false);
  expect(parseFire3dParam(new URLSearchParams('fire3d='))).toBe(false);
  expect(
    parseFire3dParam(new URLSearchParams('fire3d=true&fire3d=true'))
  ).toBe(false);
});

test('syncFire3dParam round-trips through the URL and preserves neighbors', () => {
  const browser = installFakeBrowser({
    search: '?cluster=wildfire&embed=true'
  });
  try {
    syncFire3dParam(true);
    expect(browser.search()).toContain('fire3d=true');
    expect(browser.search()).toContain('cluster=wildfire');
    expect(browser.search()).toContain('embed=true');
    expect(
      parseFire3dParam(new URLSearchParams(browser.search()))
    ).toBe(true);

    syncFire3dParam(false);
    expect(browser.search()).not.toContain('fire3d');
    expect(browser.search()).toContain('cluster=wildfire');
    expect(browser.search()).toContain('embed=true');
  } finally {
    browser.restore();
  }
});

/**
 * The clear-sky spec is a HAND-COPY of MapLibre's own internal "no sky"
 * fallback, and `Map.setSky` requires a full specification, so it cannot
 * be replaced by passing undefined.
 *
 * What this case proves and what it does not. It pins the APPLICATION
 * literal against an accidental edit: the two other assertions in this file
 * compare the harness call against this same constant, so a typo here would
 * otherwise change both sides at once and go unnoticed. It compares the
 * constant only with the values written below. It does NOT observe the
 * installed maplibre-gl, so it cannot detect the library changing its own
 * internal fallback; a hand-copy of another project's internals is exactly
 * the kind of thing that rots silently across a major upgrade, and this test
 * would stay green through that rot.
 *
 * Closing that gap is the version-bump checklist's job, not this test's. The
 * MapLibre bump checklist MUST re-verify these values by inspecting the
 * distributed bundle for the object literal containing
 * "sky-color":"transparent" (the fallback the library constructs a Sky with
 * when a style declares none) and MUST record the result in the bump commit.
 * Last such inspection: maplibre-gl 6.6.0 on 2026-09-03, unchanged from the
 * 4.7 values: `dist/maplibre-gl.mjs` still constructs the fallback Sky from
 * the literal {"sky-color":"transparent","horizon-color":"transparent",
 * "fog-color":"transparent","fog-ground-blend":1,"atmosphere-blend":0}.
 * Before that, 5.24.0 on 2026-08-19 (harvested from the retired
 * feature/maplibre-v5 branch on 2026-09-02), also unchanged.
 */
test('the clear-sky specification literal is pinned', () => {
  expect(FIRE3D_SKY_CLEAR_SPECIFICATION).toEqual({
    'sky-color': 'transparent',
    'horizon-color': 'transparent',
    'fog-color': 'transparent',
    'fog-ground-blend': 1,
    'atmosphere-blend': 0
  });
  // The scene's OWN sky is a separate, deliberately styled spec; the two
  // must never collapse into one another.
  expect(FIRE3D_SKY_SPECIFICATION).not.toEqual(FIRE3D_SKY_CLEAR_SPECIFICATION);
});

// ---------------------------------------------------------------------------
// Node: the activation gate (entry vs stay-alive, the IC refinement)
// ---------------------------------------------------------------------------

test('the gate requires wildfire for entry but survives a custom demotion with a fire event layer', () => {
  const base = {
    preference: true,
    desktopViewport: true,
    committedCluster: 'wildfire' as const,
    activeLayerKeys: new Set<string>(['nifc-fires', 'hms-smoke']),
    currentlyActive: false
  };

  expect(shouldFire3DBeActive(base)).toBe(true);
  expect(shouldFire3DBeActive({ ...base, preference: false })).toBe(false);
  expect(shouldFire3DBeActive({ ...base, desktopViewport: false })).toBe(false);

  // ENTRY requires the committed cluster to BE wildfire: custom never
  // enters, even with fire event layers on.
  expect(
    shouldFire3DBeActive({ ...base, committedCluster: 'custom' })
  ).toBe(false);
  expect(
    shouldFire3DBeActive({ ...base, committedCluster: 'heat' })
  ).toBe(false);

  // Once ACTIVE, an honest custom demotion keeps the scene while a fire
  // event layer remains in the active set (one extra reference layer must
  // not collapse the scene)...
  const active = { ...base, currentlyActive: true };
  expect(
    shouldFire3DBeActive({
      ...active,
      committedCluster: 'custom',
      activeLayerKeys: new Set(['nifc-fires', 'treaty'])
    })
  ).toBe(true);
  expect(
    shouldFire3DBeActive({
      ...active,
      committedCluster: 'custom',
      activeLayerKeys: new Set(['hms-smoke'])
    })
  ).toBe(true);

  // ...but removing every fire event layer, switching to another cluster,
  // toggling off, or a narrow viewport exits.
  expect(
    shouldFire3DBeActive({
      ...active,
      committedCluster: 'custom',
      activeLayerKeys: new Set(['treaty', 'states'])
    })
  ).toBe(false);
  expect(
    shouldFire3DBeActive({ ...active, committedCluster: 'drought' })
  ).toBe(false);
  expect(
    shouldFire3DBeActive({
      ...active,
      committedCluster: 'custom',
      activeLayerKeys: new Set(['hms-smoke']),
      preference: false
    })
  ).toBe(false);
  expect(
    shouldFire3DBeActive({
      ...active,
      committedCluster: 'custom',
      activeLayerKeys: new Set(['hms-smoke']),
      desktopViewport: false
    })
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Node: the scene ladder against the fake map
// ---------------------------------------------------------------------------

/** One synthetic EIA plant with the issuer's Period vintage attribute. */
/** Valid PMTiles for every archive probe; a real FeatureCollection for the
 * live EIA plants query (the two fetch shapes the 3D mode issues). */
function stubPmtilesFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('Power_Plants_in_the_US')) {
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    return new Response(PMTILES_V3_HEADER_PREFIX, { status: 206 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function stubCorruptFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<html>not tiles</html>', { status: 200 });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Valid PMTiles for every archive EXCEPT the hazard drape (corrupt). */
function stubDrapeCorruptFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('whp-2023')) {
      return new Response('<html>not tiles</html>', { status: 200 });
    }
    if (url.includes('Power_Plants_in_the_US')) {
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    return new Response(PMTILES_V3_HEADER_PREFIX, { status: 206 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('activation builds terrain, sky, camera, and the smoke volume; deactivation restores everything', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 15, bearing: 30 });
  const { map } = harness;

  // A live hms-smoke activation is already on the fake map.
  map.addSource('hms-smoke', { type: 'geojson' } as never);
  map.addLayer({ id: 'hms-smoke-fill', type: 'fill', source: 'hms-smoke' } as never);

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    // Terrain rides its OWN source, never the hillshade layer's.
    expect(harness.getTerrain()).toEqual({
      source: 'fire3d-terrain-dem',
      exaggeration: FIRE3D_TERRAIN_EXAGGERATION
    });
    const dem = harness.sources.get('fire3d-terrain-dem');
    expect(dem).toMatchObject({
      type: 'raster-dem',
      encoding: 'terrarium',
      tileSize: 512
    });
    expect(String((dem as { url?: string }).url)).toMatch(/^pmtiles:\/\//);
    expect(harness.skyCalls[0]).toEqual(FIRE3D_SKY_SPECIFICATION);

    // Motion allowed: an ease to the ruled pitch, at the ruled duration.
    expect(harness.cameraCalls[0]).toEqual({
      kind: 'easeTo',
      options: {
        pitch: FIRE3D_PITCH_DEGREES,
        duration: FIRE3D_CAMERA_TRANSITION_MS
      }
    });
    expect(harness.camera.pitch).toBe(FIRE3D_PITCH_DEGREES);

    // W4: the volume rides the EXISTING hms-smoke source; the flat veil is
    // hidden, not removed.
    expect(getFire3DStatus().smokeVolume).toBe(true);
    expect(harness.layerSpecs.get('hms-smoke-volume')).toMatchObject({
      type: 'fill-extrusion',
      source: 'hms-smoke'
    });
    expect(harness.layoutChanges).toContainEqual({
      layerId: 'hms-smoke-fill',
      name: 'visibility',
      value: 'none'
    });
    // Ruled order: the volume sits directly above the flat veil.
    expect(harness.layerOrder.indexOf('hms-smoke-volume')).toBe(
      harness.layerOrder.indexOf('hms-smoke-fill') + 1
    );

    // The hazard drape rides the context chunk over its bundled archive,
    // at the ruled condition-surface position below the smoke. It replaced
    // the fuel-model drape on 2026-08-19: the owner asked for a risk read,
    // and WHP is a published hazard scale where FBFM40 is a fuel-model
    // classification that would have had to be repainted to pretend.
    // Power infrastructure left this list on 2026-08-19: it is a catalog
    // layer now, off by default, and this orchestrator only reports it when
    // a person has turned it on (tests/power-layer.spec.ts owns its truth).
    expect(getFire3DStatus().contextLayers).toEqual(['whp', 'structures']);
    expect(harness.sources.get('whp-2023')).toMatchObject({
      type: 'raster',
      tileSize: 512
    });
    expect(harness.layerSpecs.get('whp-2023')).toMatchObject({
      type: 'raster',
      source: 'whp-2023',
      paint: {
        'raster-opacity': DRAPE_OPACITY,
        // A categorical raster must not blend two class colors into a
        // third that appears in no legend.
        'raster-resampling': 'nearest'
      }
    });
    expect(harness.layerOrder.indexOf('whp-2023')).toBeLessThan(
      harness.layerOrder.indexOf('hms-smoke-fill')
    );

    // The 3D scene must not bring power up on its own any more: the
    // catalog toggle is the one decision, and it is off here.
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);

    // Structures: one source, two extrusion layers splitting published
    // heights from disclosed placeholders, seated with the context
    // overlays under every event overlay.
    expect(harness.sources.get('structures-3d')).toMatchObject({
      type: 'vector'
    });
    // The height-honesty split is load-bearing: published heights and
    // placeholders may never share a layer, so the filters are pinned.
    expect(harness.layerSpecs.get('structures-3d')).toMatchObject({
      type: 'fill-extrusion',
      source: 'structures-3d',
      filter: ['has', 'h']
    });
    expect(harness.layerSpecs.get('structures-3d-est')).toMatchObject({
      type: 'fill-extrusion',
      source: 'structures-3d',
      filter: ['!', ['has', 'h']]
    });
    expect(harness.layerOrder.indexOf('structures-3d')).toBeGreaterThan(
      harness.layerOrder.indexOf('whp-2023')
    );
    expect(harness.layerOrder.indexOf('structures-3d-est')).toBeLessThan(
      harness.layerOrder.indexOf('hms-smoke-fill')
    );

    setFire3DActive(map, false);
    expect(getFire3DStatus().state).toBe('inactive');
    expect(getFire3DStatus().contextLayers).toEqual([]);
    expect(harness.getTerrain()).toBeNull();
    expect(harness.sources.has('fire3d-terrain-dem')).toBe(false);
    expect(harness.sources.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);
    expect(harness.layerSpecs.has('power-lines')).toBe(false);
    expect(harness.layerSpecs.has('power-lines-unknown')).toBe(false);
    expect(harness.layerSpecs.has('power-plants')).toBe(false);
    expect(harness.sources.has('structures-3d')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d-est')).toBe(false);
    expect(harness.skyCalls.at(-1)).toEqual(FIRE3D_SKY_CLEAR_SPECIFICATION);
    expect(harness.layerSpecs.has('hms-smoke-volume')).toBe(false);
    expect(harness.layoutChanges.at(-1)).toEqual({
      layerId: 'hms-smoke-fill',
      name: 'visibility',
      value: 'visible'
    });
    // The prior camera comes back exactly.
    expect(harness.cameraCalls.at(-1)).toEqual({
      kind: 'easeTo',
      options: { pitch: 15, bearing: 30, duration: FIRE3D_CAMERA_TRANSITION_MS }
    });
    expect(harness.camera).toEqual({ pitch: 15, bearing: 30 });
    // The tile watch detached with the scene.
    expect(harness.listenerCount('error')).toBe(0);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Node: the DR-064 perimeter ribbon
// ---------------------------------------------------------------------------

/**
 * What the flat perimeter layer leaves on the map: its own GeoJSON source,
 * carrying two mapped wildfire records and one prescribed burn. The ribbon
 * raises only the pulsing wildfire class, so the prescribed record is the
 * control case.
 */
const RIBBON_PERIMETER_COLLECTION = {
  type: 'FeatureCollection',
  features: [
    ...NIFC_STUB.features,
    {
      type: 'Feature',
      properties: {
        attr_IncidentTypeCategory: 'RX',
        poly_IncidentName: 'Synthetic Burn'
      },
      geometry: PNW_POLYGON(-118.9, 45.1)
    }
  ]
};

/**
 * The three files that name the ribbon's slab layers must agree.
 *
 * The ids are derived once (from PERIMETER_RIBBON_SLAB_COUNT) and mirrored
 * twice, because the ruled stacking chain and the pulse's paint targets
 * both live in modules that must not import the 3D chunk. Mirrors rot; this
 * is the case that stops a slab-count change from leaving one behind.
 */
test('the ribbon slab ids agree across the three modules that name them', () => {
  expect(PERIMETER_RIBBON_LAYER_IDS).toHaveLength(PERIMETER_RIBBON_SLAB_COUNT);

  // The pulse animates every slab, in phase with the flat outline.
  const ribbonTargets = WILDFIRE_PULSE_PAINT_TARGETS.filter((target) =>
    target.layerId.startsWith('nifc-perimeter-ribbon')
  );
  expect(ribbonTargets.map((target) => target.layerId)).toEqual([
    ...PERIMETER_RIBBON_LAYER_IDS
  ]);
  expect(
    ribbonTargets.every(
      (target) => target.paintProperty === 'fill-extrusion-color'
    )
  ).toBe(true);

  // Ruled seat: the slabs are event overlays, in order, directly above the
  // flat wildfire outline they stand on.
  const seats = PERIMETER_RIBBON_LAYER_IDS.map((id) =>
    EVENT_OVERLAY_IDS.indexOf(id)
  );
  expect(seats.every((seat) => seat >= 0)).toBe(true);
  expect(seats).toEqual([...seats].sort((a, b) => a - b));
  expect(seats[0]).toBe(EVENT_OVERLAY_IDS.indexOf('nifc-fires-outline') + 1);
});

/**
 * The fade ladder itself (DR-064: opaque at the ground, transparent at the
 * top, dropping quickly near the top rather than linearly).
 */
test('the ribbon fade is opaque at the ground and accelerates toward the top', () => {
  const ladder = Array.from(
    { length: PERIMETER_RIBBON_SLAB_COUNT },
    (_unused, index) => perimeterRibbonSlabOpacity(index)
  );
  expect(ladder[0]).toBeGreaterThan(0.9);
  expect(ladder.at(-1)).toBeLessThan(0.2);
  for (let i = 1; i < ladder.length; i += 1) {
    expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
  }
  // Logarithmic, not linear: each step down is larger than the one below it.
  for (let i = 2; i < ladder.length; i += 1) {
    expect(ladder[i - 1]! - ladder[i]!).toBeGreaterThan(
      ladder[i - 2]! - ladder[i - 1]!
    );
  }
});

test('the perimeter ribbon stands on the live perimeters and leaves with the scene', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness();
  const { map } = harness;

  // The flat perimeter layer is already live, exactly as it leaves the map:
  // one GeoJSON source plus its own fill and outline.
  map.addSource('nifc-fires', {
    type: 'geojson',
    data: RIBBON_PERIMETER_COLLECTION
  } as never);
  map.addLayer({
    id: 'nifc-fires-fill',
    type: 'fill',
    source: 'nifc-fires'
  } as never);
  map.addLayer({
    id: 'nifc-fires-outline',
    type: 'line',
    source: 'nifc-fires'
  } as never);
  registry.activate('nifc-fires');
  registry.setStatus('nifc-fires', 'ready');

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().perimeterRibbon).toBe(true);

    // Every slab stands on the ribbon's OWN derived source, so the flat
    // layer's source is never held open by this module.
    PERIMETER_RIBBON_LAYER_IDS.forEach((id, index) => {
      expect(harness.layerSpecs.get(id)).toMatchObject({
        type: 'fill-extrusion',
        source: 'nifc-perimeter-ribbon',
        paint: {
          'fill-extrusion-color': WILDFIRE_STATIC_COLOR,
          'fill-extrusion-opacity': perimeterRibbonSlabOpacity(index),
          // The fade is the opacity ladder alone; MapLibre's own vertical
          // gradient would darken the foot, which must stay brightest.
          'fill-extrusion-vertical-gradient': false
        }
      });
    });
    // The bottom slab sits ON the terrain: base zero, nearly opaque.
    expect(
      harness.layerSpecs.get(PERIMETER_RIBBON_LAYER_IDS[0]!)?.paint?.[
        'fill-extrusion-base'
      ]
    ).toBe(0);

    // The ribbon derives from the same collection the flat layer holds and
    // fetches nothing: two wildfire records raised, the prescribed burn
    // left with its deliberately neutral flat treatment.
    const ribbonSource = harness.sources.get('nifc-perimeter-ribbon') as {
      data?: { features?: unknown[] };
    };
    expect(ribbonSource?.data?.features).toHaveLength(2);

    // Ruled order: the slabs sit directly above the flat wildfire outline.
    expect(harness.layerOrder.indexOf(PERIMETER_RIBBON_LAYER_IDS[0]!)).toBe(
      harness.layerOrder.indexOf('nifc-fires-outline') + 1
    );

    // The ribbon never writes the perimeter layer's status, and never
    // touches the flat layer's own layers.
    expect(registry.getStatus('nifc-fires')).toBe('ready');

    setFire3DActive(map, false);
    expect(getFire3DStatus().state).toBe('inactive');
    expect(getFire3DStatus().perimeterRibbon).toBe(false);
    for (const id of PERIMETER_RIBBON_LAYER_IDS) {
      expect(harness.layerSpecs.has(id)).toBe(false);
    }
    expect(harness.sources.has('nifc-perimeter-ribbon')).toBe(false);
    expect(harness.refusedSourceRemovals).toEqual([]);
    // The flat perimeter is exactly as it was before the scene existed.
    expect(harness.layerSpecs.has('nifc-fires-fill')).toBe(true);
    expect(harness.layerSpecs.has('nifc-fires-outline')).toBe(true);
    expect(harness.sources.has('nifc-fires')).toBe(true);
    expect(registry.getStatus('nifc-fires')).toBe('ready');
  } finally {
    setFire3DActive(map, false);
    registry.deactivate('nifc-fires');
    restoreFetch();
    browser.restore();
  }
});

test('a scene with no live perimeters keeps terrain and simply has no ribbon', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness();
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    // Partial degrade, never a blocked scene: terrain is up, the ribbon is
    // absent because there is no perimeter source to derive it from.
    expect(getFire3DStatus().perimeterRibbon).toBe(false);
    expect(harness.getTerrain()).not.toBeNull();
    for (const id of PERIMETER_RIBBON_LAYER_IDS) {
      expect(harness.layerSpecs.has(id)).toBe(false);
    }
    expect(harness.sources.has('nifc-perimeter-ribbon')).toBe(false);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('reduced motion jumps the camera instead of easing, both directions', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: true });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 5, bearing: 10 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(harness.cameraCalls[0]).toEqual({
      kind: 'jumpTo',
      options: { pitch: FIRE3D_PITCH_DEGREES }
    });

    setFire3DActive(map, false);
    expect(harness.cameraCalls.at(-1)).toEqual({
      kind: 'jumpTo',
      options: { pitch: 5, bearing: 10 }
    });
    expect(
      harness.cameraCalls.every((call) => call.kind === 'jumpTo')
    ).toBe(true);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('a corrupt archive fails the probe before any map mutation and drops fire3d from the URL', async () => {
  const browser = installFakeBrowser({
    desktop: true,
    search: '?cluster=wildfire&fire3d=true'
  });
  const restoreFetch = stubCorruptFetch();
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });
  const { map } = harness;
  const warnings = captureWarnings();

  try {
    seedFire3DPreference(true);
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('unavailable');

    expect(getFire3DStatus().reason).toMatch(/terrain archive/i);
    // The failure is warned once, naming the probe, with the archive error.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[fire3d\] terrain archive probe failed\. .*not a PMTiles v3 archive/)
    ]);
    // Nothing was mutated: the probe failed before setup began.
    expect(harness.getTerrain()).toBeNull();
    expect(harness.sources.size).toBe(0);
    expect(harness.skyCalls).toHaveLength(0);
    expect(harness.cameraCalls).toHaveLength(0);
    // The honest demotion dropped the preference AND the URL flag while
    // preserving the neighbors.
    expect(getFire3DPreference()).toBe(false);
    expect(browser.search()).not.toContain('fire3d');
    expect(browser.search()).toContain('cluster=wildfire');
  } finally {
    warnings.restore();
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('the hazard drape stands down while the flat WHP surface is on, and leaves when it arrives', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });

  try {
    // The wildfire cluster's season-ahead horizon activates exactly this
    // flat layer (src/config/clusters.ts:119), so the pairing is real.
    // Both draw the SAME USFS product from the same service: stacked they
    // would double one classification's translucency, print two legends
    // for one issuer, and show the Pacific Northwest bake box as a hard
    // rectangular seam over the live conterminous-US layer.
    registry.activate('usfs-whp');
    const controller = new AbortController();
    const activation = await activateContextLayers(
      harness.map,
      controller.signal
    );

    expect(activation.keys).not.toContain('whp');
    expect(harness.sources.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    // No embed line either: a disclosure may only describe what rendered.
    expect(activation.embedLines.join(' ')).not.toContain(
      'Wildfire Hazard Potential'
    );

    // With the flat layer off, the drape activates as usual...
    registry.deactivate('usfs-whp');
    deactivateContextLayers(harness.map);
    const second = await activateContextLayers(harness.map, controller.signal);
    expect(second.keys).toContain('whp');
    expect(harness.layerSpecs.has('whp-2023')).toBe(true);

    // ...and it leaves the moment the flat layer is switched on, because a
    // horizon change can do that while the scene is already up.
    registry.activate('usfs-whp');
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    expect(harness.sources.has('whp-2023')).toBe(false);
  } finally {
    registry.deactivate('usfs-whp');
    deactivateContextLayers(harness.map);
    restoreFetch();
    browser.restore();
  }
});

test('a corrupt hazard archive degrades only the drape; the scene stays active', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubDrapeCorruptFetch();
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });
  const { map } = harness;
  const warnings = captureWarnings();

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    // Terrain succeeded; the hazard drape alone degraded, with no partial
    // drape state left on the map, while the other context stayed.
    expect(harness.getTerrain()).not.toBeNull();
    expect(getFire3DStatus().contextLayers).toEqual(['structures']);
    expect(harness.sources.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d')).toBe(true);
    // Only the drape warned; the scene itself raised nothing.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[whp-3d\] the hazard drape archive is unreachable or invalid\./)
    ]);
  } finally {
    warnings.restore();
    setFire3DActive(map, false);
    setFire3DPreference(false);
    restoreFetch();
    browser.restore();
  }
});

test('a corrupt structures archive degrades only the buildings; the rest stays', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('structures-central-oregon')) {
      return new Response('<html>not tiles</html>', { status: 200 });
    }
    if (url.includes('Power_Plants_in_the_US')) {
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    return new Response(PMTILES_V3_HEADER_PREFIX, { status: 206 });
  }) as typeof fetch;
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });
  const { map } = harness;
  const warnings = captureWarnings();

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    expect(getFire3DStatus().contextLayers).toEqual(['whp']);
    expect(harness.sources.has('structures-3d')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d-est')).toBe(false);
    // Only the structures context warned; the scene itself raised nothing.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[structures-3d\] the structures archive is unreachable or invalid\./)
    ]);
  } finally {
    warnings.restore();
    setFire3DActive(map, false);
    setFire3DPreference(false);
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('post-probe terrain tile failures roll the scene back transactionally', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 12, bearing: -20 });
  const { map } = harness;
  const warnings = captureWarnings();

  try {
    seedFire3DPreference(true);
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(harness.getTerrain()).not.toBeNull();

    // Three tile errors inside the rolling window with no successful load
    // in between: the shared watcher's honest degrade threshold.
    for (let i = 0; i < 3; i += 1) {
      harness.emit('error', {
        sourceId: 'fire3d-terrain-dem',
        error: new Error(`synthetic tile failure ${i}`)
      });
    }

    expect(getFire3DStatus().state).toBe('unavailable');
    expect(getFire3DStatus().reason).toMatch(/terrain tiles/i);
    expect(harness.getTerrain()).toBeNull();
    expect(harness.sources.has('fire3d-terrain-dem')).toBe(false);
    expect(harness.skyCalls.at(-1)).toEqual(FIRE3D_SKY_CLEAR_SPECIFICATION);
    expect(harness.camera).toEqual({ pitch: 12, bearing: -20 });
    expect(getFire3DPreference()).toBe(false);
    expect(harness.listenerCount('error')).toBe(0);
    // The watcher warned once at the third error, then the scene warned
    // its own rollback reason: exactly two, in that order.
    expect(warnings.messages).toEqual([
      expect.stringMatching(
        /^\[fire3d-terrain-dem\] repeated tile-load failures; reporting unavailable\. Error: synthetic tile failure 2$/
      ),
      expect.stringMatching(/^\[fire3d\] Terrain tiles failed to load\./)
    ]);
  } finally {
    warnings.restore();
    setFire3DActive(map, false);
    setFire3DPreference(false);
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Browser: the production build end to end
// ---------------------------------------------------------------------------

function fire3dStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['ddmFire3d']);
}

function fire3dSmokeStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dSmoke']
  );
}

function fire3dContextStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dContext']
  );
}

function fire3dRibbonStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dRibbon']
  );
}

const TOGGLE = '.shell-fire3d-btn';

// The evidence captures below render the live scene, including the
// default-on AIANNH and BIA boundaries, to fire3d-evidence/ (gitignored)
// for the owner's local review. They stay local: CI keeps no screenshots
// (playwright.config.ts), and a runner must not write that geometry to
// disk at all.
//
// OPT-IN, NOT OPT-OUT (DR-051 a, ruled 2026-09-02). This constant used to be
// `!process.env['CI']`, which made every local run a capture run: three of the
// slowest boots in the suite paid live agency latency, a routine loop could
// not run offline, and four PNGs the owner reviews were overwritten by anyone
// who typed `npm run test:serial`. A routine local run must be offline-safe
// and idempotent, so capture now happens only when the developer asks for it
// with `DDM_CAPTURE_EVIDENCE=1`; every other local run uses the fixtures
// exactly as CI does. The flag is the deliberate capture pass and the gate
// for the evidence categories that come next (terrain across views,
// volumetric smoke, layer studio 3D layers).
//
// The `!process.env['CI']` half stays as a second lock, not as the switch: a
// runner that somehow carried the flag still captures nothing.
const CAPTURE_EVIDENCE =
  process.env['DDM_CAPTURE_EVIDENCE'] === '1' && !process.env['CI'];

// THE ONE PLACE THE SUITE ASKS FOR LIVE BOUNDARIES, and only when it is
// about to photograph them.
//
// DDM-P1-T08 made every boot answer the AIANNH and BIA queries from
// synthetic rectangles. That silently changed what these captures were FOR:
// the owner reviews them to judge whether real Tribal-geography cartography
// draws honestly in the 3D scene, and a picture of two invented rectangles
// cannot answer that question. Source-health request receipts prove the
// services respond; they say nothing about how the boundaries look.
//
// So the three evidence-bearing boots ask for `live` exactly when
// `CAPTURE_EVIDENCE` is true, which since DR-051 a is exactly the deliberate
// `DDM_CAPTURE_EVIDENCE=1` capture pass on a local machine, where nothing is
// retained. The live mode exists only to serve those captures, so it is gated
// on the same flag: an ordinary local run is `fixture` like every CI boot. In
// CI this is `fixture`, the capture blocks are skipped, and
// `installBoundaryStubs` would throw on `live` anyway
// (tests/tribal-fixtures.ts), so the option cannot reach a public artifact by
// any route. tests/boundary-boot-inventory.test.mjs records this file as the
// single allowance and requires the CI guard.
const EVIDENCE_BOUNDARIES = CAPTURE_EVIDENCE ? ('live' as const) : ('fixture' as const);

test.describe('W3/W4 browser truth', () => {
  test('the desktop toggle activates the 3D scene with the volume legend, then exits cleanly', async ({
    page
  }) => {
    // Terrain probe, DEM tile fan-out, and full-page screenshots on the
    // software renderer overrun the default budget; this is the one
    // evidence-bearing case, so it gets explicit room.
    test.setTimeout(180_000);
    await stubWildfireFeeds(page);

    // Measure the terrain archive's real transport for the activation
    // budget row (logged, not asserted; the preview serves the bundled
    // archive with ranges).
    let demBytes = 0;
    let demRequests = 0;
    let drapeBytes = 0;
    let drapeRequests = 0;
    let powerBytes = 0;
    let powerRequests = 0;
    let structuresBytes = 0;
    let structuresRequests = 0;
    page.on('response', (response) => {
      const url = response.url();
      const length = Number(response.headers()['content-length']);
      if (url.includes('hillshade-dem-pnw.pmtiles')) {
        demRequests += 1;
        if (Number.isFinite(length)) demBytes += length;
      } else if (url.includes('whp-2023-pnw.pmtiles')) {
        drapeRequests += 1;
        if (Number.isFinite(length)) drapeBytes += length;
      } else if (url.includes('power-lines-pnw.pmtiles')) {
        powerRequests += 1;
        if (Number.isFinite(length)) powerBytes += length;
      } else if (url.includes('structures-central-oregon.pmtiles')) {
        structuresRequests += 1;
        if (Number.isFinite(length)) structuresBytes += length;
      }
    });

    await gotoApp(page, '?cluster=wildfire', { boundaries: EVIDENCE_BOUNDARIES });
    await waitForLayerSettled(page, 'hms-smoke');

    const toggle = page.locator(TOGGLE);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Both honesty notes render whenever the control does: coverage, and
    // the non-prediction disclosure (never a dismissible tooltip).
    await expect(page.locator('.shell-fire3d-note')).toHaveText([
      FIRE3D_COVERAGE_NOTE,
      FIRE3D_NON_PREDICTION_NOTE
    ]);
    await expect(page.locator('[data-fire3d-disclosure]')).toHaveText(
      FIRE3D_NON_PREDICTION_NOTE
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).toContain('fire3d=true');
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await expect.poll(() => fire3dSmokeStamp(page)).toBe('volume');
    await expect(
      page.locator('.shell-fire3d-status')
    ).toHaveAttribute('data-fire3d-status', 'active');

    // The volume legend carries the honest vertical qualification.
    const volumeLegend = page.locator(
      '.legend-section[data-legend="hms-smoke-volume"]'
    );
    await expect(volumeLegend).toHaveCount(1);
    await expect
      .poll(() => volumeLegend.textContent())
      .toContain(HMS_VOLUME_QUALIFICATION);

    // The context layers this mode OWNS activated, each with its issuer
    // palette or caveat qualification. Power is not among them since
    // 2026-08-19: it is a catalog layer, off unless someone asks for it,
    // and its legend must not appear while it is off.
    await expect
      .poll(() => fire3dContextStamp(page), { timeout: 30_000 })
      .toBe('whp structures');
    const hazardLegend = page.locator(
      '.legend-section[data-legend="whp-2023"]'
    );
    await expect(hazardLegend).toHaveCount(1);
    await expect
      .poll(() => hazardLegend.textContent())
      .toContain(USFS_WHP_PRESENTATION.qualification);
    const powerLegend = page.locator(
      '.legend-section[data-legend="power-context"]'
    );
    await expect(powerLegend).toHaveCount(0);
    const structuresLegend = page.locator(
      '.legend-section[data-legend="structures-3d"]'
    );
    await expect(structuresLegend).toHaveCount(1);
    await expect
      .poll(() => structuresLegend.textContent())
      .toContain(STRUCTURES_QUALIFICATION);
    // The embed disclosure chip is embed-only chrome; the desktop shell
    // already carries the notes, so no chip appears here.
    await expect(page.locator('#fire3d-embed-note')).toHaveCount(0);

    // Let terrain tiles land (a bounded wait; live basemap tiles make
    // networkidle nondeterministic), then capture the pitched-scene
    // evidence.
    await page.waitForTimeout(4_000);
    if (CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: 'fire3d-evidence/fire3d-active-desktop.png'
      });
      await page
        .locator('#shell-panel')
        .screenshot({ path: 'fire3d-evidence/fire3d-control-coverage-note.png' });
    }
    console.log(
      `[fire3d-budget] terrain archive transport: ${demBytes} bytes over ${demRequests} requests`
    );
    console.log(
      `[fire3d-budget] hazard drape archive transport: ${drapeBytes} bytes over ${drapeRequests} requests`
    );
    console.log(
      `[fire3d-budget] power-lines archive transport: ${powerBytes} bytes over ${powerRequests} requests (ZERO is the expected reading since 2026-08-19: power is a catalog layer, off by default, so the 3D scene no longer pulls it. Its own budget row lives under the power-infrastructure feature in scripts/check-activation-budget.mjs)`
    );
    console.log(
      `[fire3d-budget] structures archive transport: ${structuresBytes} bytes over ${structuresRequests} requests (z13-14 tiles load only when zoomed into the pilot area; this view measures the activation-time header and directory reads)`
    );

    // Toggle off: the flat scene returns and the flag drops.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
    await expect(volumeLegend).toHaveCount(0);
    await expect(hazardLegend).toHaveCount(0);
    await expect(powerLegend).toHaveCount(0);
    await expect(structuresLegend).toHaveCount(0);
    expect(await fire3dContextStamp(page)).toBeUndefined();
  });

  test('the perimeter ribbon follows the perimeter layer, not the other way round', async ({
    page
  }) => {
    // A terrain build plus the perimeter fetch on the software renderer.
    test.setTimeout(180_000);
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true');

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await waitForLayerSettled(page, 'nifc-fires');
    // The perimeter data lands after the scene does, so the ribbon arrives
    // on the layer's status seam rather than on a toggle.
    await expect
      .poll(() => fire3dRibbonStamp(page), { timeout: 30_000 })
      .toBe('on');

    const ribbonLegend = page.locator(
      '.legend-section[data-legend="nifc-perimeter-ribbon"]'
    );
    await expect(ribbonLegend).toHaveCount(1);
    await expect
      .poll(() => ribbonLegend.textContent())
      .toContain(PERIMETER_RIBBON_QUALIFICATION);

    // Leaving the scene takes the ribbon and its legend with it, and the
    // flat perimeter carries on alone.
    await page.locator(TOGGLE).click();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    expect(await fire3dRibbonStamp(page)).toBeUndefined();
    await expect(ribbonLegend).toHaveCount(0);
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();

    // Re-entering rebuilds it from the perimeters already on the map.
    await page.locator(TOGGLE).click();
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await expect
      .poll(() => fire3dRibbonStamp(page), { timeout: 30_000 })
      .toBe('on');

    // Turning the perimeter layer off takes the ribbon with it while the
    // scene stays up: the ribbon is a re-presentation of that layer and has
    // no life of its own. (The layer change demotes the committed cluster to
    // custom, which hides the 3D control while a fire event layer keeps the
    // scene alive, so this is the last gesture of the case.)
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await expect.poll(() => fire3dRibbonStamp(page)).toBe('off');
    await expect(ribbonLegend).toHaveCount(0);
    expect(await fire3dStamp(page)).toBe('active');
  });

  test('a shared fire3d link boots active and ordinary URL writes preserve the flag', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true', {
      boundaries: EVIDENCE_BOUNDARIES
    });

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).toContain('fire3d=true');

    // An unrelated ordinary region write must preserve the flag (the
    // heatday preservation idiom inside syncUrl).
    await page
      .locator('#region-select')
      .selectOption('region:central_oregon', { force: true });
    // 20 s, not the default 10: the write itself is synchronous, but the
    // gesture competes with terrain tile work on the software renderer, and
    // a starved frame should not be what decides a URL contract. The same
    // budget is used for the URL assertions in the view-contract matrix.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('region'), {
        timeout: 20_000
      })
      .toBe('central_oregon');
    expect(await search(page)).toContain('fire3d=true');
  });

  test('reduced motion still enters and leaves the 3D scene', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await stubWildfireFeeds(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoApp(page, '?cluster=wildfire&fire3d=true');

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await page.waitForTimeout(4_000);
    if (CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: 'fire3d-evidence/fire3d-reduced-motion.png'
      });
    }

    await page.locator(TOGGLE).click();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
  });

  test('embed stays chrome-inert while a URL-named fire3d still drives the map effect', async ({
    page
  }) => {
    // Unlike every other heavy case in this block (120_000-180_000), this one
    // declared no budget and inherited the global 60_000 while doing the most
    // expensive boot in the file: an evidence-bearing boot (EVIDENCE_BOUNDARIES
    // is `live` during a `DDM_CAPTURE_EVIDENCE=1` capture pass, so it then pays
    // real agency latency; the measurement below was taken that way, back when
    // every local run was a capture run), a full 3D activation,
    // then four expect.poll chains with 30_000 ceilings of their own. That is
    // the exact shape playwright.config.ts warns about: the budget has to sit
    // above boot plus the chain, or a correctly-behaving app fails on a slow
    // upstream day. Measured 2026-09-01 on this laptop: 1.1 minutes, red
    // locally against 60_000, green in CI only because retries absorb it
    // (Validate 33452141530, 33444784737). Match the other evidence-bearing
    // case above rather than the cheaper siblings.
    test.setTimeout(180_000);
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true&embed=true', {
      boundaries: EVIDENCE_BOUNDARIES
    });

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    // The shell panel is hidden in embeds, so the toggle is inert chrome.
    await expect(page.locator(TOGGLE)).not.toBeVisible();
    expect(await search(page)).toContain('embed=true');
    expect(await search(page)).toContain('fire3d=true');

    // The honesty surfaces travel with the map in embeds: the disclosure
    // chip renders while the scene is active, carrying the non-prediction
    // statement, the coverage note, and the hazard drape's vintage line.
    const embedNote = page.locator('#fire3d-embed-note');
    await expect(embedNote).toBeVisible();
    await expect(embedNote).toContainText(FIRE3D_NON_PREDICTION_NOTE);
    await expect(embedNote).toContainText(FIRE3D_COVERAGE_NOTE);
    await expect
      .poll(() => embedNote.textContent(), { timeout: 30_000 })
      .toContain('Wildfire Hazard Potential 2023');
    await expect
      .poll(() => embedNote.textContent(), { timeout: 30_000 })
      .toContain('Overture footprints');
    // ...and it describes ONLY what rendered. Power infrastructure is a
    // catalog layer since 2026-08-19 and is off in this embed, so the chip
    // must not claim a grid the viewer cannot see.
    await expect
      .poll(() => embedNote.textContent())
      .not.toContain('HIFLD transmission lines');
    if (CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: 'fire3d-evidence/fire3d-embed-disclosure.png'
      });
    }
  });

  test('an empty smoke read says so in the 3D control instead of looking broken', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubWildfireFeeds(page);
  // Registered AFTER the shared stub, so it wins: HMS answers with a valid
  // but EMPTY collection, which is an ordinary and correct answer from a
  // daytime satellite analysis product.
  await page.route(
    (url) => url.href.includes('NOAA_Satellite_Smoke_Detection'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] })
      })
  );
  await gotoApp(page, '?cluster=wildfire&fire3d=true');

  await expect
    .poll(() => fire3dStamp(page), { timeout: 60_000 })
    .toBe('active');

  // The scene still reports the volume, because the source is there and
  // the extrusion is over it; there is simply nothing in it. Without the
  // line below, that reads as a broken feature rather than an answer.
  const empty = page.locator('[data-fire3d-empty-smoke]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No current smoke plumes in view');
  // The standing notes stay countable: the empty line carries its own
  // class so it cannot be mistaken for one of them.
  await expect(page.locator('.shell-fire3d-note')).toHaveCount(2);
});

test('an embed without the flag never activates and never gains it', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&embed=true');

    await page.waitForTimeout(3_000);
    expect(await fire3dStamp(page)).not.toBe('active');
    expect(await search(page)).not.toContain('fire3d');
    // No scene, no chip.
    await expect(page.locator('#fire3d-embed-note')).toHaveCount(0);
  });

  test('a mobile viewport never fetches the 3D chunks', async ({ page }) => {
    await stubWildfireFeeds(page);
    // Only the 3D chunks themselves are forbidden on mobile. The tiny
    // fire3d-presentation constants chunk legitimately rides the shell
    // island (the control needs the coverage note and breakpoint), and
    // the document URL itself carries the fire3d parameter.
    const chunkRequests: string[] = [];
    page.on('request', (request) => {
      if (
        /assets\/(?:fire3d-(?!presentation)|hms-smoke-volume-)/.test(
          request.url()
        )
      ) {
        chunkRequests.push(request.url());
      }
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?cluster=wildfire&fire3d=true');
    await page.waitForTimeout(3_000);

    expect(chunkRequests).toEqual([]);
    expect(await fire3dStamp(page)).toBeUndefined();
  });

  test('a landscape phone is offered no 3D control and never enters the scene', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    // 844 x 390 is the same phone rotated: wider than the desktop
    // breakpoint, shorter than FIRE3D_MIN_HEIGHT_PX. The map-side gate
    // refuses the scene on height (DR-025a); the control must agree and
    // withdraw rather than offer a button whose scene cannot come. The
    // width-only control was the last place the old rule survived.
    await page.setViewportSize({ width: 844, height: 390 });
    await gotoApp(page, '?cluster=wildfire&fire3d=true');
    await page.waitForTimeout(3_000);

    await expect(page.locator('#shell-fire3d')).toHaveCount(0);
    // The ask itself is kept (the preference is the user's durable request
    // and the gate, not the URL, decides); only the scene is refused.
    expect(await fire3dStamp(page)).not.toBe('active');

    // Rotating back to tall geometry restores the offer: the control
    // watches both queries, not only the width.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('#shell-fire3d')).toHaveCount(1);
  });

  test('a corrupt archive reads unavailable in the control and drops the flag', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    // Boot against the REAL bundled archive first: the default-on
    // hillshade layer shares the archive, and corrupting it at boot would
    // fail hillshade, honestly demote the cluster to custom, and hide
    // this control before the click. Only the fire3d probe sees the
    // corruption.
    await gotoApp(page, '?cluster=wildfire');
    await waitForLayerSettled(page, 'hillshade');

    // One glob covers the bundled path AND the ATNI fallback copy (both
    // end in the same file name), so the resolver honestly exhausts its
    // ladder (the u4g corrupt-archive fixture idiom).
    await page.route('**/hillshade-dem-pnw.pmtiles*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html>not tiles</html>'
      })
    );

    const toggle = page.locator(TOGGLE);
    await toggle.click();
    // The corrupt probe fails within milliseconds, so the pressed state is
    // transient by design (the press flip itself is asserted in the
    // desktop activation case); this case asserts the terminal truths.
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('unavailable');
    await expect(page.locator('.shell-fire3d-status')).toContainText(
      'Unavailable'
    );
    // The honest demotion: preference off, flag gone, cluster preserved.
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
    expect(await search(page)).toContain('cluster=wildfire');
  });

  test('one extra reference layer keeps the scene; losing every fire layer or the cluster exits it', async ({
    page
  }) => {
    // The drape's tile fan-out on the software renderer pushes this
    // multi-toggle walk past the default budget; give it explicit room.
    // 120_000 was not enough room. Measured 2026-09-01 on this laptop: the
    // walk builds terrain, adds `places`, tears the smoke volume down, then
    // unchecks the last fire layer, and the budget expired around the
    // `hms-smoke` uncheck below (the call log shows the click completing)
    // at 2.1 minutes, red locally and green in CI on retry. Nothing here is
    // slower than the scene-building siblings, so carry their ceiling.
    test.setTimeout(180_000);
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&view=console&fire3d=true');

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await waitForLayerSettled(page, 'nifc-fires');
    await waitForLayerSettled(page, 'hms-smoke');

    // Add one bundled reference layer: the display honestly demotes to a
    // custom layer set (cluster= leaves the URL) but the scene stays.
    await layerCheckbox(page, 'places').check();
    await waitForLayerSettled(page, 'places');
    await expect.poll(async () => search(page)).not.toContain('cluster=');
    expect(await fire3dStamp(page)).toBe('active');

    // Removing the smoke layer keeps terrain but honestly downgrades the
    // smoke read to (absent) flat; the volume never outlives its layer.
    await layerCheckbox(page, 'hms-smoke').uncheck();
    await expect.poll(() => fire3dSmokeStamp(page)).toBe('flat');
    expect(await fire3dStamp(page)).toBe('active');
    await expect(
      page.locator('.legend-section[data-legend="hms-smoke-volume"]')
    ).toHaveCount(0);

    // Removing the last fire event layer exits the scene; the durable
    // preference (and its URL flag) survives for the next Fire view.
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    expect(await search(page)).toContain('fire3d=true');
  });

  test('switching clusters exits the scene and hides the control without dropping the preference', async ({
    page
  }) => {
    // Unlike its siblings above (120_000-180_000), this test declared no
    // explicit budget while doing two full cluster swaps on the software
    // renderer: enter the scene, exit it (a click that itself can outrun
    // the default 60_000 while the main thread is blocked tearing the
    // scene down), then re-enter and rebuild it. Measured report,
    // 2026-08-29: flaky in 12 of 21 CI runs, always green on retry 1,
    // `locator.click: Test timeout of 60000ms exceeded` on the drought
    // cluster button. Match the budget its build-twice workload calls for.
    test.setTimeout(150_000);
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true');
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');

    await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect(page.locator(TOGGLE)).toHaveCount(0);
    // The durable preference stays; re-entering the Fire view restores 3D.
    expect(await search(page)).toContain('fire3d=true');

    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
  });
});
