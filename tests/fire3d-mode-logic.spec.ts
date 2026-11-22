// Moved from tests/fire3d-mode.spec.ts: these tests never open a page, so they run in the pure lane (verify:pure).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePmtilesHeader } from '../src/util/pmtiles-probe';
import { join } from 'node:path';

import { expect, test } from './offline-test';

import {
  FIRE3D_CAMERA_TRANSITION_MS,
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_OUT_OF_COVERAGE_STATUS,
  FIRE3D_PARTIAL_COVERAGE_STATUS,
  FIRE3D_PITCH_DEGREES,
  FIRE3D_REFUSAL_TEXT,
  FIRE3D_SKY_CLEAR_SPECIFICATION,
  FIRE3D_SKY_SPECIFICATION,
  FIRE3D_TERRAIN_COVERAGE,
  FIRE3D_TERRAIN_EXAGGERATION,
  PERIMETER_RIBBON_SLAB_COUNT,
  classifyTerrainCoverage,
  fire3dControlOffer,
  fire3dCoverageNote,
  formatLatitudeDeg,
  formatLongitudeDeg,
  isWithinTerrainCoverage,
  perimeterRibbonSlabOpacity
} from '../src/config/fire3d-presentation';
import { WILDFIRE_STATIC_COLOR } from '../src/config/wildfire-presentation';
import { WILDFIRE_PULSE_PAINT_TARGETS } from '../src/layers/nifc-fires';
import { PERIMETER_RIBBON_LAYER_IDS } from '../src/layers/nifc-perimeter-ribbon';
import { EVENT_OVERLAY_IDS } from '../src/map/layer-order';
import {
  deriveSceneTransport,
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
  deactivateContextLayers,
  WHP_EMBED_LINE
} from '../src/map/fire3d-context';
import { URLS } from '../src/config/urls';
import { registry } from '../src/state/registry';
import { parseFire3dParam, syncFire3dParam } from '../src/state/url';
import {
  captureWarnings,
  fakeMapHarness,
  installFakeBrowser,
  pmtilesHeaderResponse
} from './map-harness';
import {
  NIFC_STUB,
  PLANTS_STUB_FC,
  PNW_POLYGON
} from './wildfire-fixtures';
import { setPerimeterSnapshot } from '../src/state/fire-perimeter-snapshot';

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

// ---------------------------------------------------------------------------
// Node: the transport reading's own derivation (Fire3DStatus.transport)
// ---------------------------------------------------------------------------

/**
 * `deriveSceneTransport` is the pure predicate behind `Fire3DStatus.transport`
 * (src/map/fire3d.ts): it never touches a map, so its own state machine is
 * proved here at the function seam, the same way `parseFire3dParam` is
 * proved above without a URL. The wiring that calls it from real
 * `sourcedata`/`idle` events, and the RAWS case that waits on the resulting
 * stamp, are asserted at the browser level below (W3/W4 browser truth).
 */
test('deriveSceneTransport reads streaming until every known source is loaded, then settled', () => {
  // No known sources yet (an activation still discovering which context
  // layers it will add): streaming, not a vacuous "nothing to wait for".
  expect(deriveSceneTransport([], () => true)).toBe('streaming');

  // One source, not yet loaded.
  expect(deriveSceneTransport(['fire3d-terrain-dem'], () => false)).toBe(
    'streaming'
  );

  // One source, loaded: settled.
  expect(deriveSceneTransport(['fire3d-terrain-dem'], () => true)).toBe(
    'settled'
  );

  // Several sources: every one of them must report loaded, not just one.
  const loaded = new Set(['fire3d-terrain-dem']);
  expect(
    deriveSceneTransport(['fire3d-terrain-dem', 'whp-2023'], (id) => loaded.has(id))
  ).toBe('streaming');
  loaded.add('whp-2023');
  expect(
    deriveSceneTransport(['fire3d-terrain-dem', 'whp-2023'], (id) => loaded.has(id))
  ).toBe('settled');
});

test('deriveSceneTransport goes back to streaming the moment any settled source starts loading again', () => {
  // Models a pan that re-fetches tiles for a source already marked loaded:
  // the caller re-derives on every sourcedata/idle event, so a predicate
  // that flips back to false is exactly a source that started streaming
  // again, and the reading must follow it back down.
  let terrainLoaded = true;
  const isLoaded = (id: string): boolean =>
    id === 'fire3d-terrain-dem' ? terrainLoaded : true;
  expect(
    deriveSceneTransport(['fire3d-terrain-dem', 'whp-2023'], isLoaded)
  ).toBe('settled');
  terrainLoaded = false;
  expect(
    deriveSceneTransport(['fire3d-terrain-dem', 'whp-2023'], isLoaded)
  ).toBe('streaming');
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
 * Last such inspection: maplibre-gl 6.14.0 on 2026-10-12, unchanged from the
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
// Node: what the shell offers where the toggle would be (DDM-P9-T02)
// ---------------------------------------------------------------------------

test('a device that cannot hold the scene is told, and only that device is', () => {
  const capable = {
    wideEnough: true,
    tallEnough: true,
    webgl2: true,
    fireView: true
  } as const;

  expect(fire3dControlOffer(capable)).toBe('control');

  // The two refusals. Each one is a sentence, not an omission: this is the
  // whole of DDM-P9-T02's first acceptance clause.
  expect(fire3dControlOffer({ ...capable, webgl2: false })).toBe('no-webgl2');
  expect(fire3dControlOffer({ ...capable, tallEnough: false })).toBe(
    'short-window'
  );
  // Capability outranks geometry: a device that cannot render the scene is
  // told that, not told to find a taller window.
  expect(
    fire3dControlOffer({ ...capable, webgl2: false, tallEnough: false })
  ).toBe('no-webgl2');

  // The two silences. Another hazard view has no 3D toggle to miss, and a
  // viewport below the desktop breakpoint is the phone chrome, where 3D is
  // deferred by ruling rather than refused by the device. Saying anything
  // in either place would be an advertisement or a nag.
  expect(fire3dControlOffer({ ...capable, fireView: false })).toBe('silent');
  expect(fire3dControlOffer({ ...capable, wideEnough: false })).toBe('silent');
  expect(
    fire3dControlOffer({ ...capable, wideEnough: false, webgl2: false })
  ).toBe('silent');
});

test('each refusal states an observation and borrows no layer state', () => {
  for (const reason of ['no-webgl2', 'short-window'] as const) {
    const sentence = FIRE3D_REFUSAL_TEXT[reason];
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence.endsWith('.')).toBe(true);
    // Not a seventh layer state (AGENTS.md invariant 6): the six honest
    // states stay the property of the layer pills and of this control's own
    // status line, and none of their words describes a control affordance.
    for (const state of [
      'loading',
      'live',
      'live (partial)',
      'unavailable',
      'no data',
      'zoom in to load'
    ]) {
      expect(sentence.toLowerCase()).not.toContain(state);
    }
    // No promise of a fix and no instruction: the sentence says what was
    // observed and stops.
    for (const promise of ['will ', 'try ', 'please', 'update your', 'upgrade']) {
      expect(sentence.toLowerCase()).not.toContain(promise);
    }
  }
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
    return pmtilesHeaderResponse();
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
    return pmtilesHeaderResponse();
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
  const shadeEvents: { layer: string; active: boolean }[] = [];
  window.addEventListener('ddm:whp-shade', (event) => {
    shadeEvents.push((event as CustomEvent<{ layer: string; active: boolean }>).detail);
  });

  // A live hms-smoke activation is already on the fake map.
  map.addSource('hms-smoke', { type: 'geojson' } as never);
  map.addLayer({ id: 'hms-smoke-fill', type: 'fill', source: 'hms-smoke' } as never);

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    // The fake map declares no `isSourceLoaded`, so the transport watch's
    // own defensive guard (isSceneSourceLoaded) reads every scene source as
    // still streaming; the field is populated (not null) the moment 'active'
    // first publishes, never one publish behind it.
    expect(getFire3DStatus().transport).toBe('streaming');

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
    // Independent adopted pins on the actual scene setSky call, not a
    // comparison of a token against itself. Blend/camera tuning stays fixed.
    expect(harness.skyCalls[0]).toEqual({
      'sky-color': '#010B13', 'horizon-color': '#1E242C', 'fog-color': '#010B13',
      'fog-ground-blend': 0.8, 'horizon-fog-blend': 0.6,
      'sky-horizon-blend': 0.7, 'atmosphere-blend': 0.3
    });

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
    expect(shadeEvents.at(-1)).toEqual({ layer: 'whp-2023', active: true, mounted: true });
    expect(harness.sources.get('whp-2023')).toMatchObject({
      type: 'raster',
      url: `whp-shade://${URLS.whp2023PmtilesLocal}`,
      tileSize: 512
    });
    expect(harness.sources.get('whp-2023')).not.toHaveProperty('tiles');
    expect(harness.layerSpecs.get('whp-2023')).toMatchObject({
      type: 'raster',
      source: 'whp-2023',
      // DR-199: the console's "Fuel risk" switch is on by default.
      layout: { visibility: 'visible' },
      paint: {
        // The shading table carries each class's effective white opacity.
        'raster-opacity': 1,
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

    // Buildings: one source and ONE extrusion layer with no filter (every
    // footprint at the same stated height; tests/structures-3d.test.mjs
    // holds the paint), seated with the context overlays under every event
    // overlay.
    expect(harness.sources.get('structures-3d')).toMatchObject({
      type: 'vector',
      url: `pmtiles://${URLS.structuresPmtilesLocal}`
    });
    expect(harness.layerSpecs.get('structures-3d')).toMatchObject({
      type: 'fill-extrusion',
      source: 'structures-3d'
    });
    expect(harness.layerSpecs.get('structures-3d')).not.toHaveProperty('filter');
    expect(harness.layerOrder.indexOf('structures-3d')).toBeGreaterThan(
      harness.layerOrder.indexOf('whp-2023')
    );
    expect(harness.layerOrder.indexOf('structures-3d')).toBeLessThan(
      harness.layerOrder.indexOf('hms-smoke-fill')
    );

    setFire3DActive(map, false);
    expect(getFire3DStatus().state).toBe('inactive');
    expect(getFire3DStatus().contextLayers).toEqual([]);
    expect(shadeEvents.at(-1)).toEqual({ layer: 'whp-2023', active: false, mounted: false });
    expect(harness.getTerrain()).toBeNull();
    expect(harness.sources.has('fire3d-terrain-dem')).toBe(false);
    expect(harness.sources.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    expect(harness.sources.has('structures-3d')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d')).toBe(false);
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);
    expect(harness.layerSpecs.has('power-lines')).toBe(false);
    expect(harness.layerSpecs.has('power-lines-unknown')).toBe(false);
    expect(harness.layerSpecs.has('power-plants')).toBe(false);
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
    // The transport watch detached too: no stale reading survives
    // deactivation, and no listener leaks past the scene it was watching.
    expect(getFire3DStatus().transport).toBeNull();
    expect(harness.listenerCount('sourcedata')).toBe(0);
    expect(harness.listenerCount('idle')).toBe(0);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Node: the terrain source must not pin its own depth
// ---------------------------------------------------------------------------

/**
 * The scene must let the ARCHIVE decide how deep it goes.
 *
 * MapLibre resolves a source's zooms with `extend(tileJSON, options)`
 * (load_tilejson.ts), so an explicit option OVERRIDES the header the pmtiles
 * protocol supplies, rather than being overwritten by it. Pinning `maxzoom`
 * therefore caps the source at the pinned value for every archive, including
 * a deeper one resolved at runtime: `covering_tiles.ts` computes
 * `nominalZ = Math.min(desiredZ, maxZoom)` and the deeper tiles are simply
 * never requested.
 *
 * The assertion is on the KEY'S ABSENCE, not on its value. `extend` is a
 * `for...in` over own enumerable keys, so `maxzoom: undefined` is NOT the
 * same as no key at all: an explicit `undefined` still enumerates and still
 * stomps the header. `src/layers/hillshade.ts:113-118` already omits the
 * key, and this pins the 3D scene to the same shape.
 *
 * Nothing else in tests/ reads the terrain source's declared zooms, and the
 * spec assertion in the activation test uses `toMatchObject`, which ignores
 * extra keys. That is why a green gate was consistent with the pin.
 */
test('the terrain source declares no maxzoom of its own, so the resolved archive header sets the depth', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 15, bearing: 30 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    const dem = harness.sources.get('fire3d-terrain-dem');
    expect(dem).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(dem, 'maxzoom')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dem, 'minzoom')).toBe(false);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Node: DR-083 step 1 -- the coverage sentence names the archive that
// actually resolved, read from its header, never from a constant
// ---------------------------------------------------------------------------

/**
 * The deep archive answers however `deep` says; every other archive answers
 * with the bundled zoom 0 to 8 header shape.
 */
function stubDeepTerrainFetch(deep: () => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === URLS.terrainPmtilesDeep) return deep();
    if (url.includes('Power_Plants_in_the_US')) {
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    return pmtilesHeaderResponse();
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('when the deep archive resolves, the status carries its header depth and the sentence says zoom 10', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubDeepTerrainFetch(() => pmtilesHeaderResponse({ maxZoom: 10 }));
  const harness = fakeMapHarness({ pitch: 15, bearing: 30 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().terrainMaxZoom).toBe(10);
    const dem = harness.sources.get('fire3d-terrain-dem') as { url?: string };
    expect(dem.url).toBe('pmtiles://' + URLS.terrainPmtilesDeep);
    expect(fire3dCoverageNote(10)).toContain('detail ends at zoom 10');
    expect(fire3dCoverageNote(10)).not.toContain('zoom 8');

    setFire3DActive(map, false);
    await expect.poll(() => getFire3DStatus().state).toBe('inactive');
    expect(getFire3DStatus().terrainMaxZoom, 'no stale depth survives deactivation').toBeNull();
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('when the deep archive is unreachable, the bundled archive resolves and the status says zoom 8', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubDeepTerrainFetch(
    () => new Response('error code: 1042', { status: 404 })
  );
  const harness = fakeMapHarness({ pitch: 15, bearing: 30 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().terrainMaxZoom).toBe(FIRE3D_TERRAIN_COVERAGE.maxZoom);
    const dem = harness.sources.get('fire3d-terrain-dem') as { url?: string };
    expect(dem.url).toBe('pmtiles://' + URLS.hillshadePmtilesLocal);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('a truncated deep upload with a valid header is refused by the probe and the bundled archive is used instead', async () => {
  // Codex S1's scenario: the header is whole and says zoom 10, but the
  // server holds fewer bytes than the header's own extent. Before the
  // probe hardening this passed the probe, was installed, and tore the
  // scene down on its first tile read; the bundled archive was never tried.
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubDeepTerrainFetch(() =>
    pmtilesHeaderResponse({ maxZoom: 10, tileDataLength: 435_000_000 }, { total: 20_000_000 })
  );
  const harness = fakeMapHarness({ pitch: 15, bearing: 30 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().terrainMaxZoom).toBe(8);
    const dem = harness.sources.get('fire3d-terrain-dem') as { url?: string };
    expect(dem.url).toBe('pmtiles://' + URLS.hillshadePmtilesLocal);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('the bundled constants still describe the bundled archive; only the formatter varies', () => {
  expect(FIRE3D_TERRAIN_COVERAGE.maxZoom).toBe(8);
  expect(fire3dCoverageNote(FIRE3D_TERRAIN_COVERAGE.maxZoom)).toBe(FIRE3D_COVERAGE_NOTE);
  expect(FIRE3D_COVERAGE_NOTE).toContain('detail ends at zoom 8');
});

// ---------------------------------------------------------------------------
// Node: terrain-relief lane defect 1 -- the scene still builds outside the
// archive box, and says so, at the moment it is true
// ---------------------------------------------------------------------------

test('isWithinTerrainCoverage agrees with FIRE3D_TERRAIN_COVERAGE at its own edges', () => {
  const { west, south, east, north } = FIRE3D_TERRAIN_COVERAGE;
  // Inclusive at every edge: the archive's own bounding box is inclusive.
  expect(isWithinTerrainCoverage(west, south)).toBe(true);
  expect(isWithinTerrainCoverage(east, north)).toBe(true);
  expect(isWithinTerrainCoverage(west - 0.001, south)).toBe(false);
  expect(isWithinTerrainCoverage(east + 0.001, north)).toBe(false);
  expect(isWithinTerrainCoverage(west, south - 0.001)).toBe(false);
  expect(isWithinTerrainCoverage(east, north + 0.001)).toBe(false);
  // The archive's own declared center (public/data/hillshade-dem-pnw.pmtiles
  // metadata: [-119, 45.5]), well inside the box.
  expect(isWithinTerrainCoverage(-119, 45.5)).toBe(true);
});

test('a fire outside the archive box still gets the full scene, and the status names the coverage gap the moment it is true', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  // Miami: well outside FIRE3D_TERRAIN_COVERAGE (west -125 to east -110.5).
  const harness = fakeMapHarness({ center: { lng: -80.19, lat: 25.76 } });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    // Entry never asked about location (shouldFire3DBeActive tests only
    // preference, viewport, capability, and the committed cluster): the
    // scene still builds in full, camera and context included.
    expect(harness.getTerrain()).toEqual({
      source: 'fire3d-terrain-dem',
      exaggeration: FIRE3D_TERRAIN_EXAGGERATION
    });
    expect(getFire3DStatus().terrainCoverage).toBe('none');

    // Panning back inside the box clears it live, without leaving the scene.
    harness.setCenter({ lng: -119, lat: 45.5 });
    expect(getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().terrainCoverage).toBe('full');

    // And panning back out sets it again.
    harness.setCenter({ lng: -80.19, lat: 25.76 });
    expect(getFire3DStatus().terrainCoverage).toBe('none');

    setFire3DActive(map, false);
    // The moveend listener detaches with the scene (mirrors the existing
    // error-listener check on the activation test above), so a stray pan
    // after exit cannot resurrect or leak it.
    expect(harness.listenerCount('moveend')).toBe(0);
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('FIRE3D_OUT_OF_COVERAGE_STATUS names the same issuer as the standing coverage sentence and invents no new one', () => {
  expect(FIRE3D_OUT_OF_COVERAGE_STATUS).toContain(FIRE3D_TERRAIN_COVERAGE.issuer);
  expect(FIRE3D_PARTIAL_COVERAGE_STATUS).toContain(FIRE3D_TERRAIN_COVERAGE.issuer);
  // The two must not be interchangeable: the wholly-outside sentence is a
  // claim about all of the view, the partial one explicitly is not.
  expect(FIRE3D_OUT_OF_COVERAGE_STATUS).not.toBe(FIRE3D_PARTIAL_COVERAGE_STATUS);
  expect(FIRE3D_PARTIAL_COVERAGE_STATUS).toContain('Part of this view');
  expect(FIRE3D_PARTIAL_COVERAGE_STATUS).toContain('the rest of the view is modelled');
});

/**
 * A view is classified by its FOOTPRINT, never by its centre point (Codex
 * adversarial review 2026-09-10, finding 8).
 *
 * The centre test this replaced was wrong in both directions at the extent's
 * edge, and the pair of cases below are exactly those two directions: a view
 * that straddles the edge from the inside used to say nothing while half its
 * ground rendered flat, and the same view nudged a fraction of a degree east
 * used to announce that the whole view had no archived elevation.
 */
test('a view straddling the coverage edge reads as partial, from either side of the line', () => {
  const { west, south, east, north } = FIRE3D_TERRAIN_COVERAGE;

  // Wholly inside, comfortably: no qualification earned.
  expect(
    classifyTerrainCoverage({ west: west + 1, south: south + 1, east: east - 1, north: north - 1 })
  ).toBe('full');

  // Straddling the eastern edge from the inside. The centre is INSIDE the box,
  // so the old predicate said nothing at all while real ground rendered flat.
  expect(
    classifyTerrainCoverage({ west: east - 1, south: south + 1, east: east + 1, north: north - 1 })
  ).toBe('partial');

  // The same picture, centre now just OUTSIDE. The old predicate flipped to a
  // categorical "this view is outside" for a view still mostly covered.
  expect(
    classifyTerrainCoverage({ west: east - 0.5, south: south + 1, east: east + 1.5, north: north - 1 })
  ).toBe('partial');

  // Wholly outside: the categorical sentence is now the true one.
  expect(
    classifyTerrainCoverage({ west: east + 1, south: south + 1, east: east + 2, north: north - 1 })
  ).toBe('none');

  // Edges are inclusive, matching isWithinTerrainCoverage and the archive's
  // own inclusive box: touching the edge without crossing it is still full.
  expect(classifyTerrainCoverage({ west, south, east, north })).toBe('full');

  // A view larger than the whole archive contains it: partial, not full, and
  // certainly not none.
  expect(
    classifyTerrainCoverage({ west: west - 5, south: south - 5, east: east + 5, north: north + 5 })
  ).toBe('partial');
});

test('the scene publishes the partial reading for a straddling view, and clears it on a pan back in', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness();
  const { map } = harness;
  const { east, south, north } = FIRE3D_TERRAIN_COVERAGE;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().terrainCoverage).toBe('full');

    // Pan to a view whose box crosses the eastern edge.
    harness.setBounds({ west: east - 1, south: south + 1, east: east + 1, north: north - 1 });
    expect(getFire3DStatus().state).toBe('active');
    expect(getFire3DStatus().terrainCoverage).toBe('partial');

    // Back to a view wholly inside: the qualification clears.
    harness.setCenter({ lng: -119, lat: 45.5 });
    expect(getFire3DStatus().terrainCoverage).toBe('full');
  } finally {
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Node: DDM-P9-T04, terrain coverage, perimeter-over-drape order, and
// resampling
// ---------------------------------------------------------------------------

const HILLSHADE_ARCHIVE_PATH = join(
  process.cwd(),
  'public',
  'data',
  'hillshade-dem-pnw.pmtiles'
);

/**
 * Read the PMTiles v3 header fields the coverage sentence claims (min/max
 * zoom at bytes 100-101, the WGS84 bounding box at bytes 102-117, stored as
 * int32 degrees times 1e-7 per the spec), straight from the committed
 * archive. No dependency beyond Node's own fs and DataView, mirroring the
 * tile-data-offset reader in tests/layer-cancellation.spec.ts: a re-bake
 * that shifts the box makes this reader disagree with
 * FIRE3D_TERRAIN_COVERAGE and fails the test below, rather than only
 * leaving the sentence quietly wrong.
 */
function readHillshadeArchiveExtent(): {
  minZoom: number;
  maxZoom: number;
  west: number;
  south: number;
  east: number;
  north: number;
} {
  const header = readFileSync(HILLSHADE_ARCHIVE_PATH).subarray(0, 127);
  if (header.toString('latin1', 0, 7) !== 'PMTiles' || header[7] !== 3) {
    throw new Error(
      'the bundled hillshade archive is not a PMTiles v3 archive'
    );
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return {
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    west: view.getInt32(102, true) * 1e-7,
    south: view.getInt32(106, true) * 1e-7,
    east: view.getInt32(110, true) * 1e-7,
    north: view.getInt32(114, true) * 1e-7
  };
}

test('the terrain coverage constant matches the committed archive header, so a re-bake cannot silently falsify the coverage sentence', () => {
  const extent = readHillshadeArchiveExtent();
  expect(extent.maxZoom).toBe(FIRE3D_TERRAIN_COVERAGE.maxZoom);
  expect(extent.west).toBe(FIRE3D_TERRAIN_COVERAGE.west);
  expect(extent.south).toBe(FIRE3D_TERRAIN_COVERAGE.south);
  expect(extent.east).toBe(FIRE3D_TERRAIN_COVERAGE.east);
  expect(extent.north).toBe(FIRE3D_TERRAIN_COVERAGE.north);

  // The rendered sentence states the issuer and derives from the same
  // constant; it is composed, not typed by hand a second time. Each
  // header-derived bound string is asserted individually (not just the
  // issuer and the zoom figure) so a hand-typed rewrite of the sentence
  // that drops or mis-states a bound fails here rather than only failing
  // to notice.
  expect(FIRE3D_COVERAGE_NOTE).toContain(FIRE3D_TERRAIN_COVERAGE.issuer);
  expect(FIRE3D_COVERAGE_NOTE).toContain(
    formatLongitudeDeg(FIRE3D_TERRAIN_COVERAGE.west)
  );
  expect(FIRE3D_COVERAGE_NOTE).toContain(
    formatLongitudeDeg(FIRE3D_TERRAIN_COVERAGE.east)
  );
  expect(FIRE3D_COVERAGE_NOTE).toContain(
    formatLatitudeDeg(FIRE3D_TERRAIN_COVERAGE.south)
  );
  expect(FIRE3D_COVERAGE_NOTE).toContain(
    formatLatitudeDeg(FIRE3D_TERRAIN_COVERAGE.north)
  );
  // The zoom figure is stated as a DETAIL clause, never as part of the
  // coverage clause (an earlier draft read "through zoom 8; outside
  // it...flat", which a reader could misread as "past zoom 8 the ground
  // goes flat" -- false, since the archive is merely overzoomed past its
  // bake depth, per src/layers/hillshade.ts:7-11).
  expect(FIRE3D_COVERAGE_NOTE).toContain(
    `detail ends at zoom ${FIRE3D_TERRAIN_COVERAGE.maxZoom}`
  );
  expect(FIRE3D_COVERAGE_NOTE).not.toContain('terrarium');
});

// The flat Terrain Shading sentence (HILLSHADE_COVERAGE_SENTENCE) reads in
// Technical information, not the map key; pinned by
// tests/terrain-coverage.test.mjs.

test('the perimeter layer sits above the hazard drape in the style order while the scene is active (clause 2, read-only proof)', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness();
  const { map } = harness;

  // The flat perimeter layer, exactly as src/layers/nifc-fires.ts leaves it
  // on the map: one GeoJSON source with its own fill and outline, already
  // up before the scene is entered. This proof touches no ordering code;
  // src/map/layer-order.ts's CONDITION_SURFACE_IDS/EVENT_OVERLAY_IDS chain
  // is read only through its effect on map.getStyle().layers.
  map.addSource('nifc-fires', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  } as never);
  map.addLayer({ id: 'nifc-fires-fill', type: 'fill', source: 'nifc-fires' } as never);
  map.addLayer({ id: 'nifc-fires-outline', type: 'line', source: 'nifc-fires' } as never);

  try {
    const controller = new AbortController();
    const activation = await activateContextLayers(map, controller.signal);
    expect(activation.keys).toContain('whp');
    expect(harness.layerSpecs.has('whp-2023')).toBe(true);

    const order = map.getStyle().layers?.map((l) => l.id) ?? [];
    const drapeIndex = order.indexOf('whp-2023');
    expect(drapeIndex).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('nifc-fires-fill')).toBeGreaterThan(drapeIndex);
    expect(order.indexOf('nifc-fires-outline')).toBeGreaterThan(drapeIndex);
  } finally {
    deactivateContextLayers(map);
    restoreFetch();
    browser.restore();
  }
});

test('the hazard drape module still SETS nearest-neighbour resampling (clause 3; the renderer honouring it is a separate, cited fact, not proved by this fake-map read-back)', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness();
  const { map } = harness;

  try {
    const controller = new AbortController();
    const activation = await activateContextLayers(map, controller.signal);
    expect(activation.keys).toContain('whp');

    // This assertion proves only that whp-3d.ts's own map.addLayer call
    // still sets the property; the fake map has no GPU draw path, so it
    // cannot prove the renderer HONOURS it. That the shipped renderer does
    // honour it rests on two facts outside this test: DR-009 pins
    // maplibre-gl exactly in package.json, and its raster draw path
    // (maplibre-gl/src/webgl/draw/draw_raster.ts, function drawTiles) picks
    // gl.NEAREST when either `resampling` or `raster-resampling` is
    // 'nearest'; this layer sets only the latter. See the comment beside
    // the value itself in src/layers/whp-3d.ts for the same citation.
    expect(harness.layerSpecs.get('whp-2023')?.paint).toMatchObject({
      'raster-resampling': 'nearest'
    });
  } finally {
    deactivateContextLayers(map);
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
  // The ribbon reads what the fire layer published, not the map source.
  setPerimeterSnapshot(RIBBON_PERIMETER_COLLECTION as never);
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
    setPerimeterSnapshot(null);
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

// The Layer studio's issuer-coloured row ('usfs-whp-classes') is a deliberate
// choice of the issuer's colours, so the drape stands down for it.
for (const flatKey of ['usfs-whp-classes'] as const) {
  test(`the hazard drape stands down while the flat WHP surface (${flatKey}) is on, and stands back up when it goes off`, async () => {
    const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
    const restoreFetch = stubPmtilesFetch();
    const harness = fakeMapHarness({ pitch: 0, bearing: 0 });

    try {
      // Both draw the SAME USFS product from the same service: stacked they
      // would double one classification's translucency, print two legends
      // for one issuer, and show the Pacific Northwest bake box as a hard
      // rectangular seam over the live conterminous-US layer.
      registry.activate(flatKey);
      const controller = new AbortController();
      const activation = await activateContextLayers(
        harness.map,
        controller.signal
      );

      // Mounted stood down (hidden), so turning the flat layer off stands it up.
      // Reported as mounted, so the scene's load watch already holds its source
      // when it stands up; the orchestrator prints the embed line only while
      // the ddm:whp-shade event says the drape is mounted.
      expect(activation.keys).toContain('whp');
      expect(activation.embedLines).toContain(WHP_EMBED_LINE);
      expect(harness.sources.has('whp-2023')).toBe(true);
      expect(harness.layerSpecs.get('whp-2023')?.layout?.['visibility']).toBe('none');
      registry.deactivate(flatKey);
      expect(harness.layerSpecs.get('whp-2023')?.layout?.['visibility']).toBe('visible');

      // With the flat layer off, the drape activates as usual...
      deactivateContextLayers(harness.map);
      const second = await activateContextLayers(harness.map, controller.signal);
      expect(second.keys).toContain('whp');
      expect(harness.layerSpecs.has('whp-2023')).toBe(true);

      // ...and it stands down (hidden, still mounted) the moment the flat layer
      // is switched on, because the Layer studio can do that while the scene
      // is up, and stands back up when it goes off again.
      registry.activate(flatKey);
      expect(harness.layerSpecs.get('whp-2023')?.layout?.['visibility']).toBe('none');
      registry.deactivate(flatKey);
      expect(harness.layerSpecs.get('whp-2023')?.layout?.['visibility']).toBe('visible');
    } finally {
      registry.deactivate(flatKey);
      deactivateContextLayers(harness.map);
      restoreFetch();
      browser.restore();
    }
  });
}

test('flat Fuel risk steps aside for the drape and draws again when the drape leaves, still on throughout', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });
  const { map } = harness;
  // A fresh spec each time, as the flat adapter adds it (src/layers/usfs-whp.ts).
  const addFlat = (): void => {
    map.addLayer({ id: 'usfs-whp', type: 'raster', source: 'usfs-whp' } as never);
  };
  const flatVisibility = (): unknown => harness.layerSpecs.get('usfs-whp')?.layout?.['visibility'];

  try {
    // Fuel risk is on (Wildfire's optional layer, or the Long Range recipe) when the scene opens.
    addFlat();
    registry.activate('usfs-whp');
    const controller = new AbortController();
    const activation = await activateContextLayers(map, controller.signal);

    // The perimeter-masked drape mounts and the flat layer is hidden, not turned off.
    expect(activation.keys).toContain('whp');
    expect(harness.layerSpecs.has('whp-2023')).toBe(true);
    expect(harness.layoutChanges).toContainEqual({ layerId: 'usfs-whp', name: 'visibility', value: 'none' });
    expect(registry.getActiveKeys().has('usfs-whp')).toBe(true);

    // Turned off and on again while the scene is up (a horizon change): re-added visible, hidden again.
    map.removeLayer('usfs-whp');
    registry.deactivate('usfs-whp');
    addFlat();
    expect(flatVisibility()).toBeUndefined();
    registry.activate('usfs-whp');
    expect(flatVisibility()).toBe('none');
    expect(harness.layerSpecs.has('whp-2023')).toBe(true);

    // The scene leaves: the drape goes and the flat layer draws again.
    deactivateContextLayers(map);
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    expect(flatVisibility()).toBe('visible');
    expect(registry.getActiveKeys().has('usfs-whp')).toBe(true);
  } finally {
    registry.deactivate('usfs-whp');
    deactivateContextLayers(map);
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
    // drape state left on the map, while the buildings stayed.
    expect(harness.getTerrain()).not.toBeNull();
    expect(getFire3DStatus().contextLayers).toEqual(['structures']);
    expect(harness.sources.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('whp-2023')).toBe(false);
    expect(harness.layerSpecs.has('structures-3d')).toBe(true);
    // Only the drape warned; the scene itself raised nothing.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[whp-3d\] invalid or unavailable archive\./)
    ]);
  } finally {
    warnings.restore();
    setFire3DActive(map, false);
    setFire3DPreference(false);
    restoreFetch();
    browser.restore();
  }
});

test('a corrupt buildings archive degrades only the buildings; the rest stays', async () => {
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
    return pmtilesHeaderResponse();
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
    // Only the buildings warned; the scene itself raised nothing.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[structures-3d\] invalid or unavailable archive\./)
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
        tile: {},
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

test('the historical deep archive fixture pins its URL, header, declared extent and PNW coverage', () => {
  const receipt = JSON.parse(readFileSync(new URL('./fixtures/terrain-deep-archive.json', import.meta.url), 'utf8'));
  const bytes = Buffer.from(receipt.headerHex, 'hex');
  expect(bytes.length).toBe(127);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.headerSha256);
  expect(receipt.archiveUrl).toBe(URLS.terrainPmtilesDeep);
  expect(receipt.contentRange).toBe('bytes 0-126/' + receipt.declaredObjectBytes);
  const header = parsePmtilesHeader(bytes);
  expect(header.tileDataOffset + header.tileDataLength).toBe(receipt.declaredObjectBytes);
  expect({
    issuer: FIRE3D_TERRAIN_COVERAGE.issuer,
    west: header.west, south: header.south, east: header.east, north: header.north,
    minZoom: header.minZoom, maxZoom: header.maxZoom
  }).toEqual(receipt.coverage);
});

for (const outcome of ['deep', 'missing', 'invalid-box'] as const) {
  test('terrain coverage follows the answering archive: ' + outcome, async () => {
    const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
    const restoreFetch = stubDeepTerrainFetch(() => outcome === 'missing'
      ? new Response('not found', { status: 404 })
      : pmtilesHeaderResponse({ maxZoom: 11, bounds: outcome === 'deep'
        ? [-125, 24, -66.9, 50] : [-66.9, 24, -125, 50] }));
    const harness = fakeMapHarness({ center: { lng: -105, lat: 39 }, viewHalfSpan: 0.1 });
    try {
      setFire3DActive(harness.map, true);
      await expect.poll(() => getFire3DStatus().state).toBe('active');
      const status = getFire3DStatus();
      const deep = outcome === 'deep';
      expect(status.terrainCoverage).toBe(deep ? 'full' : 'none');
      expect(status.terrainExtent).toEqual({
        issuer: FIRE3D_TERRAIN_COVERAGE.issuer, minZoom: 0,
        west: -125, south: deep ? 24 : 41.5,
        east: deep ? -66.9 : -110.5, north: deep ? 50 : 49.5,
        maxZoom: deep ? 11 : 8
      });
      const source = harness.sources.get('fire3d-terrain-dem') as { url?: string };
      expect(source.url).toBe('pmtiles://' + (deep ? URLS.terrainPmtilesDeep : URLS.hillshadePmtilesLocal));
      expect(fire3dCoverageNote(status.terrainExtent!)).toContain(deep ? '66.9°W' : '110.5°W');
      expect(fire3dCoverageNote(status.terrainExtent!)).toContain('zoom ' + (deep ? 11 : 8));
      harness.setCenter({ lng: -119, lat: 45.5 });
      expect(getFire3DStatus().terrainCoverage).toBe('full');
      harness.setCenter({ lng: -105, lat: 39 });
      expect(getFire3DStatus().terrainCoverage).toBe(deep ? 'full' : 'none');
      setFire3DActive(harness.map, false);
      await expect.poll(() => getFire3DStatus().state).toBe('inactive');
      expect(getFire3DStatus().terrainExtent).toBeNull();
      expect(harness.listenerCount('moveend')).toBe(0);
    } finally {
      setFire3DActive(harness.map, false);
      restoreFetch();
      browser.restore();
    }
  });
}
