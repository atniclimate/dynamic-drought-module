import { expect, test } from '@playwright/test';

import {
  POWER_MIN_ZOOM,
  POWER_SHARED_QUALIFICATION
} from '../src/config/wildfire-presentation';
import { buildPowerEmbedLine } from '../src/map/fire3d-context';
import { CONTEXT_OVERLAY_IDS } from '../src/map/layer-order';
import {
  activate,
  cancelActivation,
  deactivate,
  fadeLayerIds,
  POWER_LAYER_KEY
} from '../src/layers/power-3d';
import { getPowerContextState } from '../src/state/power-context';
import { registry } from '../src/state/registry';
import {
  buildPowerLinePopupHtml,
  buildPowerPlantPopupHtml
} from '../src/ui/power-popups';
import {
  PMTILES_V3_HEADER_PREFIX,
  fakeMapHarness,
  installFakeBrowser
} from './map-harness';
import { PLANTS_STUB_FC } from './wildfire-fixtures';

/**
 * Power infrastructure as a CATALOG layer (owner direction, 2026-08-19).
 *
 * It used to ride the 3D Fire scene's activation, which meant it was
 * always on there and unreachable everywhere else, its plant points
 * overplotted at every framing, and clicking one revealed nothing. These
 * cases pin the four things that changed: the layer is governed by its own
 * toggle, it says `zoom in to load` below its gate instead of drawing a
 * smear, its plants group with a printed count, and both surfaces answer a
 * click with the issuer's own fields.
 *
 * Node-level, against the shared fake map (tests/map-harness.ts): the
 * production build carries no dev map handle, so source, layer, filter,
 * and status truth is asserted at the module seam. The browser-observable
 * half (the toggle governing the 3D scene, the zoom-gate pill) lives in
 * the view-contract matrix.
 */

const LINE_IDS = ['power-lines', 'power-lines-unknown'];
const PLANT_IDS = [
  'power-plants',
  'power-plants-clusters',
  'power-plants-cluster-count'
];

/** Valid PMTiles for the archive probe; the stub collection for EIA. */
function stubHealthyFetch(): () => void {
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

/** The archive is corrupt; only the live plants answer. */
function stubPlantsOnlyFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('Power_Plants_in_the_US')) {
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    return new Response('<html>not tiles</html>', { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Neither source answers. */
function stubDeadFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html>not tiles</html>', { status: 200 })) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test.afterEach(() => {
  // Module and registry state are process-global, so each case leaves the
  // layer fully off rather than letting a status leak into the next one.
  cancelActivation();
  registry.deactivate(POWER_LAYER_KEY);
});

test('above the gate both surfaces draw, group, and report live', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubHealthyFetch();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });

  try {
    await activate(harness.map);

    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('ready');
    expect(getPowerContextState()).toEqual({
      linesOn: true,
      plantsOn: true,
      periodLabel: '2025-02'
    });

    // Every drawn layer carries the SAME gate, so the layer can never be
    // half-drawn while the pill claims one state.
    for (const id of [...LINE_IDS, ...PLANT_IDS]) {
      expect(harness.layerSpecs.get(id)?.minzoom, `${id} minzoom`).toBe(
        POWER_MIN_ZOOM
      );
    }

    // Unknown voltage class keeps its own dashed layer: absent issuer data
    // must never read as a definite low-voltage line.
    expect(harness.layerSpecs.get('power-lines-unknown')).toMatchObject({
      type: 'line',
      source: 'power-lines',
      paint: { 'line-dasharray': [2, 2] }
    });

    // Grouping is MapLibre's own clustering of issuer records; the count
    // layer prints that count and nothing derived from it.
    expect(harness.sources.get('power-plants')).toMatchObject({
      type: 'geojson',
      cluster: true
    });
    expect(harness.layerSpecs.get('power-plants-clusters')).toMatchObject({
      type: 'circle',
      filter: ['has', 'point_count']
    });
    expect(
      harness.layerSpecs.get('power-plants-cluster-count')?.layout
    ).toMatchObject({ 'text-field': ['get', 'point_count_abbreviated'] });
    expect(harness.layerSpecs.get('power-plants')).toMatchObject({
      filter: ['!', ['has', 'point_count']]
    });

    // Every id this module draws is seated in the ruled context band, so
    // the new cluster layers cannot float above the event overlays.
    for (const id of [...LINE_IDS, ...PLANT_IDS]) {
      expect(CONTEXT_OVERLAY_IDS, `${id} is ruled`).toContain(id);
    }
    expect([...fadeLayerIds].sort()).toEqual(
      [...LINE_IDS, ...PLANT_IDS].sort()
    );

    deactivate(harness.map);
    expect(getPowerContextState()).toBeNull();
    for (const id of [...LINE_IDS, ...PLANT_IDS]) {
      expect(harness.layerSpecs.has(id), `${id} removed`).toBe(false);
    }
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);
    // The watcher is released with the layer; a deactivated layer must not
    // keep answering camera moves.
    expect(harness.listenerCount('moveend')).toBe(0);
  } finally {
    restoreFetch();
    browser.restore();
  }
});

test('below the gate nothing is fetched or drawn and the pill says zoom in', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(PMTILES_V3_HEADER_PREFIX, { status: 206 });
  }) as typeof fetch;
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM - 1 });

  try {
    await activate(harness.map);

    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('zoom-in');
    expect(requests, 'no upstream is touched below the gate').toBe(0);
    expect(harness.sources.size).toBe(0);
    expect(getPowerContextState()).toBeNull();

    deactivate(harness.map);
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('crossing the gate activates, and crossing back reports zoom in again', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubHealthyFetch();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM - 1 });

  try {
    await activate(harness.map);
    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('zoom-in');

    harness.setZoom(POWER_MIN_ZOOM + 1);
    await expect
      .poll(() => registry.getStatus(POWER_LAYER_KEY))
      .toBe('ready');
    expect(harness.layerSpecs.has('power-lines')).toBe(true);

    harness.setZoom(POWER_MIN_ZOOM - 1);
    await expect
      .poll(() => registry.getStatus(POWER_LAYER_KEY))
      .toBe('zoom-in');
    // The state is cleared with the claim: nothing may compose a
    // disclosure about surfaces that are no longer drawn.
    expect(getPowerContextState()).toBeNull();

    deactivate(harness.map);
  } finally {
    restoreFetch();
    browser.restore();
  }
});

test('a dead archive leaves the live plants, reports partial, and says so', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubPlantsOnlyFetch();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });

  try {
    await activate(harness.map);

    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');
    const state = getPowerContextState();
    expect(state).toMatchObject({ linesOn: false, plantsOn: true });
    expect(harness.layerSpecs.has('power-plants')).toBe(true);
    expect(harness.layerSpecs.has('power-lines')).toBe(false);

    // The 3D scene's embed disclosure is composed from that state, so a
    // partial activation may name ONLY its live half.
    const line = buildPowerEmbedLine(state!);
    expect(line).toContain('EIA power plants (reporting period 2025-02)');
    expect(line).not.toContain('HIFLD');

    deactivate(harness.map);
  } finally {
    restoreFetch();
    browser.restore();
  }
});

test('both sources dead is unavailable, not an empty success', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubDeadFetch();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });

  try {
    await activate(harness.map);

    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('error');
    expect(getPowerContextState()).toBeNull();
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);

    deactivate(harness.map);
  } finally {
    restoreFetch();
    browser.restore();
  }
});

// ---------------------------------------------------------------------------
// Popups: what a click reveals
// ---------------------------------------------------------------------------

test('a plant popup prints the issuer fields with the vintage beside the capacity', () => {
  const html = buildPowerPlantPopupHtml({
    Plant_Name: 'Synthetic Falls',
    PrimSource: 'hydroelectric',
    Total_MW: 24,
    Utility_Na: 'Synthetic Power',
    Period: '202502'
  });

  expect(html).toContain('Synthetic Falls');
  expect(html).toContain('hydroelectric');
  expect(html).toContain('24 MW');
  expect(html).toContain('Synthetic Power');
  expect(html).toContain('2025-02');
  // A nameplate rating is not current output, and the popup says so.
  expect(html).toContain('rated maximum');
});

test('a line popup never prints the issuer unknown sentinels as values', () => {
  const html = buildPowerLinePopupHtml({
    VOLT_CLASS: 'NOT AVAILABLE',
    OWNER: 'NOT AVAILABLE',
    STATUS: 'IN SERVICE',
    TYPE: 'AC',
    VOLTAGE: -999999
  });

  // -999999 is the issuer's unknown marker; printing it would fabricate a
  // reading, and 'NOT AVAILABLE' is an absence, not an owner named that.
  expect(html).not.toContain('-999999');
  expect(html).not.toContain('999,999');
  expect(html).not.toContain('NOT AVAILABLE');
  expect(html).toContain('Voltage class: not published');
  expect(html).toContain('Owner: not published');
  expect(html).toContain('IN SERVICE');
  // The archive caveat is mandatory on every line response.
  expect(html).toContain('2024-09-30');
  expect(html).toContain('no longer maintained');
});

test('a line popup prints a real published voltage', () => {
  const html = buildPowerLinePopupHtml({
    VOLT_CLASS: '500',
    OWNER: 'BONNEVILLE POWER ADMINISTRATION',
    STATUS: 'IN SERVICE',
    VOLTAGE: 500
  });
  expect(html).toContain('500 kV');
  expect(html).toContain('BONNEVILLE POWER ADMINISTRATION');
});

test('the shared qualification names the absent surfaces and why', () => {
  // A viewer seeing only long transmission lines could read the sparse
  // network as the whole grid. The absence, and whose choice it is, has to
  // be in the interface.
  expect(POWER_SHARED_QUALIFICATION).toContain('Substations');
  expect(POWER_SHARED_QUALIFICATION).toContain('distribution circuits');
  expect(POWER_SHARED_QUALIFICATION).toContain('utilities');
  expect(POWER_SHARED_QUALIFICATION).toContain('security');
  expect(POWER_SHARED_QUALIFICATION).toContain(
    'not evidence that none are present'
  );
});
