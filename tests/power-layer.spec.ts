import { expect, test } from './offline-test';

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
  captureWarnings,
  fakeMapHarness,
  installFakeBrowser,
  pmtilesHeaderResponse
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
    return pmtilesHeaderResponse();
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
    return pmtilesHeaderResponse();
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
  const warnings = captureWarnings();

  try {
    await activate(harness.map);

    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');
    // The dead half warned once; the live half raised nothing.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[power-3d\] the transmission-line archive is unreachable or invalid\./)
    ]);
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
    warnings.restore();
    restoreFetch();
    browser.restore();
  }
});

test('both sources dead is unavailable, not an empty success', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const restoreFetch = stubDeadFetch();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });
  const warnings = captureWarnings();

  try {
    await activate(harness.map);

    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('error');
    expect(getPowerContextState()).toBeNull();
    expect(harness.sources.has('power-lines')).toBe(false);
    expect(harness.sources.has('power-plants')).toBe(false);
    // Each dead source warned once, and nothing else did.
    expect(warnings.messages).toEqual([
      expect.stringMatching(/^\[power-3d\] the transmission-line archive is unreachable or invalid\./),
      expect.stringMatching(/^\[power-3d\] the EIA power-plant fetch failed\./)
    ]);

    deactivate(harness.map);
  } finally {
    warnings.restore();
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

// ---------------------------------------------------------------------------
// The re-read after a slow first read (S30D B6-POWER, found-125)
// ---------------------------------------------------------------------------

/**
 * The delays the layer's own timers use: the three re-read delays
 * (src/layers/power-3d.ts RETRY_DELAYS_MS), the archive probe's budget
 * (src/util/pmtiles-probe.ts, 10 s) and the plants read's budget (15 s; the
 * module clears both budgets as soon as its read settles).
 */
const MODULE_TIMER_DELAYS = new Set([5_000, 10_000, 15_000, 45_000]);
/** Explicit, and not one of the delays above, so a poll's own deadline stays real. */
const POLL = { timeout: 3_000 };

/**
 * A manual clock for the module's timers: a timer set with one of
 * MODULE_TIMER_DELAYS waits here until the case runs it; every other timer
 * stays real, so `expect.poll` (given POLL) keeps working. The module calls
 * the global `setTimeout`, so no seam in src/layers/power-3d.ts is needed.
 */
function installManualClock(): {
  /** Delays of the long timers still pending, in the order they were set. */
  pending: () => number[];
  /** Run the earliest pending long timer. */
  runNext: () => void;
  restore: () => void;
} {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map<string, { delay: number; run: () => void }>();
  let nextId = 0;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...args: unknown[]) => {
    if (!MODULE_TIMER_DELAYS.has(delay ?? 0)) return realSetTimeout(handler, delay, ...args);
    nextId += 1;
    const id = `manual-${nextId}`;
    timers.set(id, { delay: delay ?? 0, run: handler });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: unknown) => {
    if (typeof id === 'string' && timers.delete(id)) return;
    realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return {
    pending: () => [...timers.values()].map((timer) => timer.delay),
    runNext: () => {
      const [id, timer] = [...timers.entries()][0] ?? [];
      if (id === undefined || timer === undefined) throw new Error('no pending long timer');
      timers.delete(id);
      timer.run();
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  };
}

/**
 * Plants always answer; the line archive answers by `archiveAnswers` (true
 * for a healthy header, false for a failed read) one call at a time, and
 * every read is counted per half.
 */
function stubCountingFetch(archiveAnswers: (call: number) => boolean): {
  archive: () => number;
  plants: () => number;
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  let archive = 0;
  let plants = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('Power_Plants_in_the_US')) {
      plants += 1;
      return new Response(JSON.stringify(PLANTS_STUB_FC), { status: 200 });
    }
    archive += 1;
    if (!archiveAnswers(archive)) throw new TypeError('the read outlived the page');
    return pmtilesHeaderResponse();
  }) as typeof fetch;
  return {
    archive: () => archive,
    plants: () => plants,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}

/** Every status the layer writes, in order. */
function recordStatusWrites(): { writes: string[]; stop: () => void } {
  const writes: string[] = [];
  const stop = registry.on('status-change', (key, status) => {
    if (key === POWER_LAYER_KEY) writes.push(status);
  });
  return { writes, stop };
}

test('a failed first archive read is read again and the layer reaches ready', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const clock = installManualClock();
  const reads = stubCountingFetch((call) => call > 1);
  const warnings = captureWarnings();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });

  try {
    await activate(harness.map);
    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');
    expect(getPowerContextState()).toMatchObject({ linesOn: false, plantsOn: true });
    // One re-read is waiting, at the first delay; the reads' own budgets
    // were cleared when they settled.
    expect(clock.pending()).toEqual([5_000]);
    expect({ archive: reads.archive(), plants: reads.plants() }).toEqual({ archive: 1, plants: 1 });

    clock.runNext();
    await expect.poll(() => registry.getStatus(POWER_LAYER_KEY), POLL).toBe('ready');

    // Only the missing half was read again; the live plants were not refetched.
    expect({ archive: reads.archive(), plants: reads.plants() }).toEqual({ archive: 2, plants: 1 });
    expect(getPowerContextState()).toEqual({ linesOn: true, plantsOn: true, periodLabel: '2025-02' });
    expect(harness.layerSpecs.has('power-lines')).toBe(true);
    expect(harness.layerSpecs.has('power-plants')).toBe(true);
    // Complete: nothing further is scheduled.
    expect(clock.pending()).toEqual([]);

    deactivate(harness.map);
  } finally {
    warnings.restore();
    reads.restore();
    clock.restore();
    browser.restore();
  }
});

test('switching off or zooming out before the delay cancels the pending re-read', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const clock = installManualClock();
  const reads = stubCountingFetch(() => false);
  const warnings = captureWarnings();

  try {
    // Switched off before the delay.
    const offHarness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });
    await activate(offHarness.map);
    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');
    expect(clock.pending()).toEqual([5_000]);
    deactivate(offHarness.map);
    expect(clock.pending(), 'switching off clears the re-read').toEqual([]);
    expect({ archive: reads.archive(), plants: reads.plants() }).toEqual({ archive: 1, plants: 1 });

    // Zoomed out below the gate before the delay.
    const zoomHarness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });
    await activate(zoomHarness.map);
    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');
    expect(clock.pending()).toEqual([5_000]);
    zoomHarness.setZoom(POWER_MIN_ZOOM - 1);
    await expect.poll(() => registry.getStatus(POWER_LAYER_KEY), POLL).toBe('zoom-in');
    expect(clock.pending(), 'dropping below the gate clears the re-read').toEqual([]);

    // Nothing fires later: no read and no status write.
    const status = recordStatusWrites();
    await new Promise((resolve) => setTimeout(resolve, 50));
    status.stop();
    expect(status.writes).toEqual([]);
    expect({ archive: reads.archive(), plants: reads.plants() }).toEqual({ archive: 2, plants: 2 });

    deactivate(zoomHarness.map);
  } finally {
    warnings.restore();
    reads.restore();
    clock.restore();
    browser.restore();
  }
});

test('after three failed re-reads the partial state stands and no fourth is scheduled', async () => {
  const browser = installFakeBrowser({ desktop: true, reducedMotion: false });
  const clock = installManualClock();
  const reads = stubCountingFetch(() => false);
  const warnings = captureWarnings();
  const harness = fakeMapHarness({ zoom: POWER_MIN_ZOOM + 2 });
  const status = recordStatusWrites();

  try {
    await activate(harness.map);
    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');

    // Each failed re-read schedules the next delay, and only that one.
    for (const [index, delay] of [5_000, 15_000, 45_000].entries()) {
      await expect.poll(() => clock.pending(), POLL).toEqual([delay]);
      clock.runNext();
      await expect.poll(() => reads.archive(), POLL).toBe(2 + index);
    }

    // Let the third re-read settle, then nothing more is waiting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clock.pending(), 'no fourth re-read').toEqual([]);
    expect({ archive: reads.archive(), plants: reads.plants() }).toEqual({ archive: 4, plants: 1 });
    expect(registry.getStatus(POWER_LAYER_KEY)).toBe('degraded');
    expect(getPowerContextState()).toMatchObject({ linesOn: false, plantsOn: true });
    // The re-reads never flipped the pill: loading once, then partial once.
    expect(status.writes).toEqual(['loading', 'degraded']);

    deactivate(harness.map);
  } finally {
    status.stop();
    warnings.restore();
    reads.restore();
    clock.restore();
    browser.restore();
  }
});
