import { expect, test, type Page, type Route } from '@playwright/test';

import {
  FIRE3D_CAMERA_TRANSITION_MS,
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_NON_PREDICTION_NOTE,
  FIRE3D_PITCH_DEGREES,
  FIRE3D_SKY_CLEAR_SPECIFICATION,
  FIRE3D_SKY_SPECIFICATION,
  FIRE3D_TERRAIN_EXAGGERATION
} from '../src/config/fire3d-presentation';
import {
  FBFM40_PRESENTATION,
  FUELS_DRAPE_OPACITY,
  HMS_VOLUME_QUALIFICATION,
  POWER_LINES_QUALIFICATION,
  POWER_SHARED_QUALIFICATION
} from '../src/config/wildfire-presentation';
import { activateContextLayers } from '../src/map/fire3d-context';
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
import { parseFire3dParam, syncFire3dParam } from '../src/state/url';
import {
  PMTILES_V3_HEADER_PREFIX,
  fakeMapHarness,
  installFakeBrowser
} from './map-harness';
import { gotoApp, layerCheckbox, search, waitForLayerSettled } from './helpers';

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
const PLANTS_STUB_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        Plant_Name: 'Synthetic Falls',
        PrimSource: 'hydroelectric',
        Total_MW: 24,
        Utility_Na: 'Synthetic Power',
        Period: '202502'
      },
      geometry: { type: 'Point', coordinates: [-120.5, 45.0] }
    }
  ]
};

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

/** Valid PMTiles for every archive EXCEPT the fuels drape (corrupt);
 * plants stay live-stubbed so the power context still activates. */
function stubFuelsCorruptFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('fuels-fbfm40')) {
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

/** Fuels healthy; BOTH power sources fail (corrupt lines archive, an
 * error-shaped plants response). */
function stubPowerDeadFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('power-lines')) {
      return new Response('<html>not tiles</html>', { status: 200 });
    }
    if (url.includes('Power_Plants_in_the_US')) {
      return new Response('<html>service down</html>', { status: 503 });
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

    // W-CTX: the fuels drape rides the context chunk over its bundled
    // archive, at the ruled condition-surface position below the smoke.
    expect(getFire3DStatus().contextLayers).toEqual(['fuels', 'power']);
    expect(harness.sources.get('fuels-fbfm40')).toMatchObject({
      type: 'raster',
      tileSize: 512
    });
    expect(harness.layerSpecs.get('fuels-fbfm40')).toMatchObject({
      type: 'raster',
      source: 'fuels-fbfm40',
      paint: { 'raster-opacity': FUELS_DRAPE_OPACITY }
    });
    expect(harness.layerOrder.indexOf('fuels-fbfm40')).toBeLessThan(
      harness.layerOrder.indexOf('hms-smoke-fill')
    );

    // The power context: baked lines plus the live-stubbed plants, seated
    // between the drape and the event overlays.
    expect(harness.layerSpecs.get('power-lines')).toMatchObject({
      type: 'line',
      source: 'power-lines'
    });
    // Unknown voltage class rides its own dashed layer so missing issuer
    // data never reads as a definite low-voltage line.
    expect(harness.layerSpecs.get('power-lines-unknown')).toMatchObject({
      type: 'line',
      source: 'power-lines',
      paint: { 'line-dasharray': [2, 2] }
    });
    expect(harness.sources.get('power-plants')).toMatchObject({
      type: 'geojson'
    });
    expect(harness.layerSpecs.get('power-plants')).toMatchObject({
      type: 'circle',
      source: 'power-plants'
    });
    expect(harness.layerOrder.indexOf('power-lines')).toBeGreaterThan(
      harness.layerOrder.indexOf('fuels-fbfm40')
    );
    expect(harness.layerOrder.indexOf('power-lines')).toBeLessThan(
      harness.layerOrder.indexOf('hms-smoke-fill')
    );

    setFire3DActive(map, false);
    expect(getFire3DStatus().state).toBe('inactive');
    expect(getFire3DStatus().contextLayers).toEqual([]);
    expect(harness.getTerrain()).toBeNull();
    expect(harness.sources.has('fire3d-terrain-dem')).toBe(false);
    expect(harness.sources.has('fuels-fbfm40')).toBe(false);
    expect(harness.layerSpecs.has('fuels-fbfm40')).toBe(false);
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

  try {
    seedFire3DPreference(true);
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('unavailable');

    expect(getFire3DStatus().reason).toMatch(/terrain archive/i);
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
    setFire3DActive(map, false);
    restoreFetch();
    browser.restore();
  }
});

test('a corrupt fuels archive degrades only the drape; the scene stays active', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubFuelsCorruptFetch();
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    // Terrain succeeded; the fuels drape alone degraded, with no partial
    // fuels state left on the map, while the power context stayed.
    expect(harness.getTerrain()).not.toBeNull();
    expect(getFire3DStatus().contextLayers).toEqual(['power']);
    expect(harness.sources.has('fuels-fbfm40')).toBe(false);
    expect(harness.layerSpecs.has('fuels-fbfm40')).toBe(false);
    expect(harness.layerSpecs.has('power-lines')).toBe(true);
  } finally {
    setFire3DActive(map, false);
    setFire3DPreference(false);
    restoreFetch();
    browser.restore();
  }
});

test('a partial power activation composes a truthful embed line (plants only)', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  // Fuels and the lines archive are corrupt; only the live plants read
  // succeeds: the embed disclosure may name ONLY the plants.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('Power_Plants_in_the_US')) {
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    return new Response('<html>not tiles</html>', { status: 200 });
  }) as typeof fetch;
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });

  try {
    const controller = new AbortController();
    const activation = await activateContextLayers(
      harness.map,
      controller.signal
    );
    expect(activation.keys).toEqual(['power']);
    expect(activation.embedLines).toHaveLength(1);
    expect(activation.embedLines[0]).toContain(
      'EIA power plants (reporting period 2025-02)'
    );
    expect(activation.embedLines[0]).not.toContain('HIFLD');
    expect(harness.layerSpecs.has('power-plants')).toBe(true);
    expect(harness.layerSpecs.has('power-lines')).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('a dead power pair degrades only the power context; fuels stays', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPowerDeadFetch();
  const harness = fakeMapHarness({ pitch: 0, bearing: 0 });
  const { map } = harness;

  try {
    setFire3DActive(map, true);
    await expect.poll(() => getFire3DStatus().state).toBe('active');

    expect(getFire3DStatus().contextLayers).toEqual(['fuels']);
    expect(harness.layerSpecs.has('fuels-fbfm40')).toBe(true);
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);
    expect(harness.layerSpecs.has('power-lines')).toBe(false);
    expect(harness.layerSpecs.has('power-plants')).toBe(false);
  } finally {
    setFire3DActive(map, false);
    setFire3DPreference(false);
    restoreFetch();
    browser.restore();
  }
});

test('post-probe terrain tile failures roll the scene back transactionally', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPmtilesFetch();
  const harness = fakeMapHarness({ pitch: 12, bearing: -20 });
  const { map } = harness;

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
  } finally {
    setFire3DActive(map, false);
    setFire3DPreference(false);
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Browser: the production build end to end
// ---------------------------------------------------------------------------

const PNW_POLYGON = (west: number, south: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [west + 0.6, south],
      [west + 0.6, south + 0.45],
      [west, south + 0.45],
      [west, south]
    ]
  ]
});

const NIFC_STUB = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        attr_IncidentTypeCategory: 'WF',
        poly_IncidentName: 'Synthetic Ridge'
      },
      geometry: PNW_POLYGON(-121.4, 44.6)
    },
    {
      type: 'Feature',
      properties: {
        attr_IncidentTypeCategory: 'WF',
        poly_IncidentName: 'Synthetic Butte'
      },
      geometry: PNW_POLYGON(-119.9, 46.1)
    }
  ]
};

const HMS_STUB = {
  type: 'FeatureCollection',
  features: (
    [
      ['Light', -122.4, 44.2],
      ['Medium', -120.9, 45.2],
      ['Heavy', -119.4, 46.4]
    ] as const
  ).map(([density, west, south]) => ({
    type: 'Feature',
    properties: {
      Density: density,
      Satellite: 'GOES-WEST',
      Start: '2026230 1200',
      End_: '2026230 1800'
    },
    geometry: PNW_POLYGON(west, south)
  }))
};

async function stubWildfireFeeds(page: Page): Promise<void> {
  const fulfillJson = (route: Route, body: unknown): Promise<void> =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    });
  await page.route(
    (url) => url.href.includes('WFIGS_Interagency_Perimeters_Current'),
    (route) => fulfillJson(route, NIFC_STUB)
  );
  await page.route(
    (url) => url.href.includes('NOAA_Satellite_Smoke_Detection'),
    (route) => fulfillJson(route, HMS_STUB)
  );
  await page.route(
    (url) => url.href.includes('SPC_firewx'),
    (route) => fulfillJson(route, { type: 'FeatureCollection', features: [] })
  );
  // The 3D power context's live EIA plants read stays hermetic in tests.
  await page.route(
    (url) => url.href.includes('Power_Plants_in_the_US'),
    (route) => fulfillJson(route, PLANTS_STUB_FC)
  );
}

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

const TOGGLE = '.shell-fire3d-btn';

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
    let fuelsBytes = 0;
    let fuelsRequests = 0;
    let powerBytes = 0;
    let powerRequests = 0;
    page.on('response', (response) => {
      const url = response.url();
      const length = Number(response.headers()['content-length']);
      if (url.includes('hillshade-dem-pnw.pmtiles')) {
        demRequests += 1;
        if (Number.isFinite(length)) demBytes += length;
      } else if (url.includes('fuels-fbfm40-pnw.pmtiles')) {
        fuelsRequests += 1;
        if (Number.isFinite(length)) fuelsBytes += length;
      } else if (url.includes('power-lines-pnw.pmtiles')) {
        powerRequests += 1;
        if (Number.isFinite(length)) powerBytes += length;
      }
    });

    await gotoApp(page, '?cluster=wildfire');
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

    // W-CTX: the fuels drape and the power context activated; each legend
    // carries its issuer palette or caveat qualification.
    await expect
      .poll(() => fire3dContextStamp(page), { timeout: 30_000 })
      .toBe('fuels power');
    const fuelsLegend = page.locator(
      '.legend-section[data-legend="fuels-fbfm40"]'
    );
    await expect(fuelsLegend).toHaveCount(1);
    await expect
      .poll(() => fuelsLegend.textContent())
      .toContain(FBFM40_PRESENTATION.qualification);
    const powerLegend = page.locator(
      '.legend-section[data-legend="power-context"]'
    );
    await expect(powerLegend).toHaveCount(1);
    await expect
      .poll(() => powerLegend.textContent())
      .toContain(POWER_LINES_QUALIFICATION);
    await expect
      .poll(() => powerLegend.textContent())
      .toContain(POWER_SHARED_QUALIFICATION);
    await expect
      .poll(() => powerLegend.textContent())
      .toContain('reporting period 2025-02');
    // The embed disclosure chip is embed-only chrome; the desktop shell
    // already carries the notes, so no chip appears here.
    await expect(page.locator('#fire3d-embed-note')).toHaveCount(0);

    // Let terrain tiles land (a bounded wait; live basemap tiles make
    // networkidle nondeterministic), then capture the pitched-scene
    // evidence.
    await page.waitForTimeout(4_000);
    await page.screenshot({
      path: 'fire3d-evidence/fire3d-active-desktop.png'
    });
    await page
      .locator('#shell-panel')
      .screenshot({ path: 'fire3d-evidence/fire3d-control-coverage-note.png' });
    console.log(
      `[fire3d-budget] terrain archive transport: ${demBytes} bytes over ${demRequests} requests`
    );
    console.log(
      `[fire3d-budget] fuels archive transport: ${fuelsBytes} bytes over ${fuelsRequests} requests`
    );
    console.log(
      `[fire3d-budget] power-lines archive transport: ${powerBytes} bytes over ${powerRequests} requests (the live EIA plants read is stubbed here; its real measure is 174,970 raw bytes in one request, probed 2026-08-18)`
    );

    // Toggle off: the flat scene returns and the flag drops.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
    await expect(volumeLegend).toHaveCount(0);
    await expect(fuelsLegend).toHaveCount(0);
    await expect(powerLegend).toHaveCount(0);
    expect(await fire3dContextStamp(page)).toBeUndefined();
  });

  test('a shared fire3d link boots active and ordinary URL writes preserve the flag', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true');

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
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('region'))
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
    await page.screenshot({
      path: 'fire3d-evidence/fire3d-reduced-motion.png'
    });

    await page.locator(TOGGLE).click();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
  });

  test('embed stays chrome-inert while a URL-named fire3d still drives the map effect', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true&embed=true');

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    // The shell panel is hidden in embeds, so the toggle is inert chrome.
    await expect(page.locator(TOGGLE)).not.toBeVisible();
    expect(await search(page)).toContain('embed=true');
    expect(await search(page)).toContain('fire3d=true');

    // The honesty surfaces travel with the map in embeds: the disclosure
    // chip renders while the scene is active, carrying the non-prediction
    // statement, the coverage note, and the fuels vintage line.
    const embedNote = page.locator('#fire3d-embed-note');
    await expect(embedNote).toBeVisible();
    await expect(embedNote).toContainText(FIRE3D_NON_PREDICTION_NOTE);
    await expect(embedNote).toContainText(FIRE3D_COVERAGE_NOTE);
    await expect
      .poll(() => embedNote.textContent(), { timeout: 30_000 })
      .toContain('LANDFIRE 2024');
    await expect
      .poll(() => embedNote.textContent())
      .toContain('HIFLD transmission lines');
    await expect
      .poll(() => embedNote.textContent())
      .toContain('reporting period 2025-02');
    await page.screenshot({
      path: 'fire3d-evidence/fire3d-embed-disclosure.png'
    });
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
    // The fuels drape's tile fan-out on the software renderer pushes this
    // multi-toggle walk past the default budget; give it explicit room.
    test.setTimeout(120_000);
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
