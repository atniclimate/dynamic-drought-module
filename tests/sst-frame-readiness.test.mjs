import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * DDM-P14-T04, review finding C2: a historical SST link never reads live
 * from the latest frame.
 *
 * sst-anomaly mounts the provider's `default` (latest) frame for instant
 * paint, then enumerates the TIME axis (WMTS DescribeDomains) and only then
 * restores a `sst=` date from the URL. Before this file the default frame's
 * tile watcher reported its verdict the moment its tiles loaded, so a link
 * that named a historical date read live for imagery the URL did not ask
 * for while DescribeDomains was still in flight, and an enumeration failure
 * left that live verdict standing under the unresolved `sst=` token. The
 * ratified brief (C4-notes :78-79 and the M1 row at :320) makes the frame
 * proof, DescribeDomains, precede ready.
 *
 * Two halves:
 *
 *   1. The pure decision the layer takes once the axis answers
 *      (`planSstRestore`): restore the linked frame, show the latest, or fall
 *      back and say so.
 *   2. The behaviour, through the real `activate`/`deactivate` on a fake map
 *      with a gated `fetch`, the harness tests/raster-readiness-contract.test.mjs
 *      uses (the same three stand-ins for the modules that cannot load under
 *      type stripping or without a DOM). Every status write is recorded with
 *      the `sst=` date the URL carried at that instant, which is how
 *      "never live while sst= names another date" is judged.
 *
 * Runs under plain `node --test` (Node 24 strips the types).
 */

// ---------------------------------------------------------------------------
// Environment: the smallest window and document the layer touches.
// ---------------------------------------------------------------------------

const timeBars = new Map();
// `crossfadeGate`, when set to a promise, is awaited by the crossfadeFrames
// stand-in below; a test that needs a deterministic window inside showFrame's
// second await (after tile proof, before the frame is shown) sets it, then
// releases it on its own schedule. `null` preserves the instant no-op every
// other case in this file relies on.
globalThis.__rasterReadinessTest = { timeBars, prefetch: false, crossfadeGate: null };
globalThis.window = globalThis;
globalThis.document = {
  documentElement: { dataset: {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  hidden: false
};
globalThis.location = new URL('https://ddm.test/?view=console');
globalThis.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {}
});
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const STAND_INS = new Map([
  [
    '/src/util/frame-stepper.ts',
    'export const FRAME_FADE_MS = 0;\n' +
      'export function prefetchAllowed() { return globalThis.__rasterReadinessTest.prefetch === true; }\n' +
      'export async function crossfadeFrames() { const g = globalThis.__rasterReadinessTest.crossfadeGate; if (g) await g; }\n'
  ],
  [
    '/src/layers/enso-flow.ts',
    'export function activateEnsoFlow() {}\n' +
      'export function cancelEnsoFlowLoad() {}\n' +
      'export function deactivateEnsoFlow() {}\n'
  ],
  [
    '/src/ui/time-bar.ts',
    'export function setTimeBar(key, config) { globalThis.__rasterReadinessTest.timeBars.set(key, config); }\n' +
      'export function clearTimeBar(key) { globalThis.__rasterReadinessTest.timeBars.delete(key); }\n'
  ]
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    for (const [suffix, source] of STAND_INS) {
      if (url.endsWith(suffix)) return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const KEY = 'sst-anomaly';
const DEFAULT_SOURCE = 'sst-anomaly';
/** The boot-time `default` (latest) frame's layer id (sst-anomaly.ts LAYER_ID). */
const DEFAULT_LAYER = 'sst-anomaly';
const frameSource = (date) => `sst-frame-${date}`;

/** The stubbed window: five published days, the newest 2026-09-24. */
const WINDOW = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
const DOMAINS_XML =
  "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
  '<ows:Identifier>time</ows:Identifier>' +
  '<Domain>2026-09-20/2026-09-24/P1D</Domain>' +
  '<Size>1</Size></DimensionDomain></Domains>';

/** src/state/boot-idle.ts DEFAULT_QUIESCENCE_BUDGET_MS, the 10 s boot-idle budget. */
const BOOT_IDLE_BUDGET_MS = 10_000;

const mod = await import('../src/layers/sst-anomaly.ts');
const { registry } = await import('../src/state/registry.ts');
const { timeline } = await import('../src/state/timeline.ts');

// ---------------------------------------------------------------------------
// Part 1: the pure restore decision
// ---------------------------------------------------------------------------

test('planSstRestore restores a linked date inside the window, shows the latest otherwise, and names every fallback', () => {
  assert.equal(typeof mod.planSstRestore, 'function', 'sst-anomaly exports no planSstRestore');
  const plan = mod.planSstRestore;
  // No date asked: the latest frame, nothing to state.
  assert.deepEqual(plan(null, WINDOW), { kind: 'latest' });
  assert.deepEqual(plan(null, []), { kind: 'latest' });
  // The newest date IS the latest frame: shown, and the URL canonicalizes.
  assert.deepEqual(plan('2026-09-24', WINDOW), { kind: 'latest' });
  // A historical date inside the window: that frame, by its index.
  assert.deepEqual(plan('2026-09-21', WINDOW), { kind: 'restore', index: 1 });
  assert.deepEqual(plan('2026-09-20', WINDOW), { kind: 'restore', index: 0 });
  // A date the axis does not list (outside the window, or a gap day): a
  // verified absence, so the link falls back to the latest and says why.
  assert.deepEqual(plan('2026-08-01', WINDOW), {
    kind: 'fallback',
    requested: '2026-08-01',
    reason: 'outside-window'
  });
  // No axis at all (a failed, empty or unreadable enumeration): the date
  // cannot be resolved either way, and the fallback says that instead.
  assert.deepEqual(plan('2026-09-21', []), {
    kind: 'fallback',
    requested: '2026-09-21',
    reason: 'axis-unavailable'
  });
});

// ---------------------------------------------------------------------------
// Part 2: the behaviour on a fake map
// ---------------------------------------------------------------------------

class FakeMap {
  constructor() {
    this.sources = new Map();
    this.layers = new Map();
    this.listeners = new Map();
    this.loadedSources = new Set();
    /** Every setLayoutProperty call, in order, as { id, prop, value }. */
    this.layoutCalls = [];
  }
  getSource(id) {
    return this.sources.get(id);
  }
  addSource(id, spec) {
    if (this.sources.has(id)) throw new Error(`There is already a source with ID "${id}".`);
    this.sources.set(id, spec);
  }
  removeSource(id) {
    this.sources.delete(id);
    this.loadedSources.delete(id);
  }
  getLayer(id) {
    return this.layers.get(id);
  }
  addLayer(spec) {
    this.layers.set(spec.id, spec);
  }
  removeLayer(id) {
    this.layers.delete(id);
  }
  getStyle() {
    return { layers: [...this.layers.values()] };
  }
  setLayoutProperty(id, prop, value) {
    this.layoutCalls.push({ id, prop, value });
  }
  /** The last visibility the layer was given, or undefined when none was set. */
  visibilityOf(id) {
    for (let i = this.layoutCalls.length - 1; i >= 0; i -= 1) {
      const call = this.layoutCalls[i];
      if (call.id === id && call.prop === 'visibility') return call.value;
    }
    return undefined;
  }
  setPaintProperty() {}
  getBounds() {
    // A Pacific view that includes the Nino 3.4 box, so no toast is raised.
    return { getWest: () => -200, getEast: () => -80, getSouth: () => -30, getNorth: () => 50 };
  }
  isSourceLoaded(id) {
    return this.loadedSources.has(id);
  }
  on(event, handler) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return this;
  }
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
  emit(event, payload = {}) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload);
  }
  listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  /** MapLibre's per-tile `dataloading`, re-fired as `sourcedataloading`. */
  requestTile(sourceId, key) {
    this.emit('sourcedataloading', { sourceId, dataType: 'source', tile: { tileID: { key } } });
  }
  /** A tile that loaded; `settled` marks the source's last visible tile. */
  loadTile(sourceId, key, settled = false) {
    if (settled) this.loadedSources.add(sourceId);
    this.emit('sourcedata', {
      sourceId,
      dataType: 'source',
      tile: { tileID: { key } },
      isSourceLoaded: settled
    });
  }
}

/** A gate: whatever awaits `held` waits for `release()`. */
function gate() {
  let release = () => undefined;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

const domainsOk = (xml = DOMAINS_XML) =>
  new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml' } });

/**
 * Fail-closed fetch: only DescribeDomains answers, through `answer(call)`
 * (a Response or a promise of one), and every answer honours the request's
 * abort signal the way the platform's fetch does. Anything else throws.
 */
function installFetch(answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes('REQUEST=DescribeDomains')) {
      return Promise.reject(new Error(`unexpected egress from a node test: ${url}`));
    }
    const call = calls.length;
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => answer(call))
        .then(
          (response) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(response);
          },
          (err) => {
            signal?.removeEventListener('abort', onAbort);
            reject(err);
          }
        );
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

/** Let awaited fetch and stream work finish (microtasks and I/O callbacks). */
async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Every status the key is given from now on, each with the URL's `sst=` at that instant. */
function recordStatus() {
  const seen = [];
  const off = registry.on('status-change', (k, status) => {
    if (k === KEY) seen.push({ status, sst: timeline.sstDate });
  });
  return { seen, off };
}

const describe = (seen) => seen.map((e) => `${e.status}@${e.sst ?? 'latest'}`).join(' -> ');

/** Capture console.warn for one case; the layer's honest warnings are asserted, not printed. */
function captureWarn() {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => {
    messages.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return {
    messages,
    restore() {
      console.warn = original;
    }
  };
}

/**
 * One case: a `sst=` date seeded the way the sidebar seeds it from the URL
 * before any layer activates (src/ui/sidebar.ts, `timeline.setSstDate`), a
 * fake map, the recorder and the fetch stub, torn down in order whatever
 * the case does.
 */
async function withSst({ sst = null, answer }, body) {
  const map = new FakeMap();
  const fetchStub = installFetch(answer);
  const warn = captureWarn();
  registry.deactivate(KEY);
  timeline.setSstDate(sst);
  const log = recordStatus();
  // What the layer controller does before every activation.
  registry.setStatus(KEY, 'loading');
  try {
    await body({ map, log, fetchStub, warn });
  } finally {
    mod.deactivate(map);
    registry.deactivate(KEY);
    log.off();
    fetchStub.restore();
    warn.restore();
    timeline.setSstDate(null);
    timeBars.clear();
    globalThis.__rasterReadinessTest.prefetch = false;
    globalThis.__rasterReadinessTest.crossfadeGate = null;
  }
}

/** Prove the default (latest) frame's view: one tile requested, loaded, the source settled. */
function proveLatestFrame(map) {
  map.requestTile(DEFAULT_SOURCE, 'latest-1');
  map.loadTile(DEFAULT_SOURCE, 'latest-1', true);
}

for (const action of ['pause', 'reactivate', 'deactivate']) {
  test(`${action} during a held crossfade cannot stop or duplicate new playback`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await withSst({ answer: () => domainsOk() }, async ({ map }) => {
      map.isSourceLoaded = () => true;
      await mod.activate(map);
      proveLatestFrame(map);
      const crossfade = gate();
      globalThis.__rasterReadinessTest.crossfadeGate = crossfade.held;
      timeBars.get(KEY).play.onToggle();
      await settle();
      globalThis.__rasterReadinessTest.crossfadeGate = null;
      if (action === 'pause') timeBars.get(KEY).play.onToggle();
      else {
        if (action === 'deactivate') mod.deactivate(map);
        await mod.activate(map);
        proveLatestFrame(map);
      }
      timeBars.get(KEY).play.onToggle();
      await settle();
      const index = timeBars.get(KEY).rail.index;
      crossfade.release();
      await settle();
      t.mock.timers.tick(900);
      await settle();
      assert.equal(timeBars.get(KEY).rail.index, (index + 1) % WINDOW.length);
      assert.equal(timeBars.get(KEY).play.playing, true);
      t.mock.timers.tick(900);
      await settle();
      assert.equal(timeBars.get(KEY).rail.index, (index + 2) % WINDOW.length);
    });
  });
}

test('pause/resume and manual stepping retire the old playback loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withSst({ answer: () => domainsOk() }, async ({ map }) => {
    map.isSourceLoaded = () => true;
    await mod.activate(map);
    proveLatestFrame(map);
    const toggle = () => timeBars.get(KEY).play.onToggle();
    toggle();
    await settle();
    t.mock.timers.tick(100);
    toggle();
    toggle();
    await settle();
    const resumedIndex = timeBars.get(KEY).rail.index;
    t.mock.timers.tick(800);
    await settle();
    assert.equal(timeBars.get(KEY).rail.index, resumedIndex, 'old sleep cannot advance the resumed run');
    assert.equal(timeBars.get(KEY).play.playing, true, 'old finalizer cannot stop the resumed run');
    t.mock.timers.tick(100);
    await settle();
    assert.equal(timeBars.get(KEY).rail.index, (resumedIndex + 1) % WINDOW.length);
    timeBars.get(KEY).rail.onStep(0);
    await settle();
    t.mock.timers.tick(100);
    toggle();
    await settle();
    const steppedIndex = timeBars.get(KEY).rail.index;
    t.mock.timers.tick(800);
    await settle();
    assert.equal(timeBars.get(KEY).rail.index, steppedIndex, 'manual step retired the previous run');
    assert.equal(timeBars.get(KEY).play.playing, true);
  });
});

test('a plain boot stays loading while DescribeDomains is held, even with the latest frame proven, and reads live once the axis answers (M1: the frame proof precedes ready)', async () => {
  const domains = gate();
  await withSst({ answer: async () => (await domains.held, domainsOk()) }, async ({ map, log }) => {
    const activation = mod.activate(map);
    await settle();
    proveLatestFrame(map);
    assert.equal(registry.getStatus(KEY), 'loading', `read ${describe(log.seen)} with the time axis still in flight`);
    domains.release();
    await activation;
    assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
    assert.equal(timeBars.get(KEY)?.stamp.headline, 'Observed Sep 24, 2026');
  });
});

test('a historical sst= link never reads live from the latest frame: loading through the held axis and the requested frame\'s own held tiles, live only on that frame\'s proof', async () => {
  const domains = gate();
  await withSst(
    { sst: '2026-09-21', answer: async () => (await domains.held, domainsOk()) },
    async ({ map, log }) => {
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      assert.equal(
        registry.getStatus(KEY),
        'loading',
        `read ${describe(log.seen)}: the latest frame spoke for a link that names 2026-09-21`
      );

      domains.release();
      await settle();
      assert.ok(map.getSource(frameSource('2026-09-21')), 'the linked frame was not mounted once the axis answered');
      assert.equal(registry.getStatus(KEY), 'loading', `read ${describe(log.seen)} before the linked frame proved a tile`);
      assert.equal(timeBars.get(KEY)?.stamp.headline, 'Observed Sep 21, 2026');

      const beforeProof = log.seen.length;
      map.requestTile(frameSource('2026-09-21'), 'dated-1');
      map.loadTile(frameSource('2026-09-21'), 'dated-1', true);
      await activation;
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
      assert.ok(
        !log.seen.slice(0, beforeProof).some((e) => e.status === 'ready' || e.status === 'degraded'),
        `read ${describe(log.seen)}: live before the linked frame's own tile`
      );
      assert.equal(timeline.sstDate, '2026-09-21', 'the link lost its date');
    }
  );
});

test('a re-activation over a displayed dated frame (no deactivate between) never shows the latest frame beneath it: the default layer stays hidden through the re-activation and after it resolves (LATER:163, found-063)', async () => {
  const first = gate();
  const second = gate();
  await withSst(
    {
      sst: '2026-09-21',
      answer: async (call) => (await (call === 1 ? first.held : second.held), domainsOk())
    },
    async ({ map, log }) => {
      // Drive the linked frame to ready, as the historical-link case does.
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      first.release();
      await settle();
      map.requestTile(frameSource('2026-09-21'), 'dated-1');
      map.loadTile(frameSource('2026-09-21'), 'dated-1', true);
      await activation;
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
      assert.equal(
        map.visibilityOf(DEFAULT_LAYER),
        'none',
        'the dated frame displayed but the latest frame was never hidden beneath it'
      );
      const displayedAt = map.layoutCalls.length;
      const shownAgain = () =>
        map.layoutCalls
          .slice(displayedAt)
          .filter((c) => c.id === DEFAULT_LAYER && c.prop === 'visibility' && c.value === 'visible');

      // The same surface activated again with no deactivate between: the
      // kept branch, while 2026-09-21 is still the frame on screen.
      const reactivation = mod.activate(map);
      await settle();
      assert.deepEqual(
        shownAgain(),
        [],
        'the re-activation set the latest frame visible beneath the displayed dated frame while its time axis was in flight'
      );
      assert.equal(map.visibilityOf(DEFAULT_LAYER), 'none', 'the latest frame is not hidden during the re-activation');

      second.release();
      await reactivation;
      await settle();
      assert.deepEqual(
        shownAgain(),
        [],
        'the latest frame was set visible beneath the displayed dated frame across the re-activation'
      );
      assert.equal(map.visibilityOf(DEFAULT_LAYER), 'none', 'the latest frame is not hidden after the re-activation');
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
      assert.equal(timeline.sstDate, '2026-09-21', 'the re-activation lost the link date');
      assert.equal(timeBars.get(KEY)?.stamp.headline, 'Observed Sep 21, 2026');
    }
  );
});

test('a re-activation over a dated frame whose DescribeDomains fails keeps a dated stamp for the frame on screen', async () => {
  const first = gate();
  await withSst(
    {
      sst: '2026-09-21',
      answer: async (call) =>
        call === 1
          ? (await first.held, domainsOk())
          : new Response('Synthetic outage', { status: 500, statusText: 'Internal Server Error' })
    },
    async ({ map, log }) => {
      // Drive the linked frame to ready, as the historical-link case does.
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      first.release();
      await settle();
      map.requestTile(frameSource('2026-09-21'), 'dated-1');
      map.loadTile(frameSource('2026-09-21'), 'dated-1', true);
      await activation;
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
      assert.equal(timeline.sstDate, '2026-09-21');

      // The same surface activated again with no deactivate between, this
      // time DescribeDomains answers with a synthetic outage.
      const reactivation = mod.activate(map);
      await settle();
      await reactivation;

      assert.equal(
        timeBars.get(KEY)?.stamp.headline,
        'Observed Sep 21, 2026',
        `the dated frame on screen lost its own stamp when the axis failed to re-read: read ${describe(log.seen)}`
      );
      assert.equal(timeline.sstDate, '2026-09-21', 'the re-activation lost the link date');
      assert.equal(
        map.visibilityOf(DEFAULT_LAYER),
        'none',
        'the latest frame was shown beneath the dated frame while the axis could not be re-read'
      );
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
    }
  );
});

test('a re-activation whose axis no longer lists the retained date steps to the newest frame and states the fallback', async () => {
  const first = gate();
  const changedXml =
    "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
    '<ows:Identifier>time</ows:Identifier>' +
    '<Domain>2026-09-22/2026-09-26/P1D</Domain>' +
    '<Size>1</Size></DimensionDomain></Domains>';
  await withSst(
    {
      sst: '2026-09-21',
      answer: async (call) => (call === 1 ? (await first.held, domainsOk()) : domainsOk(changedXml))
    },
    async ({ map, log }) => {
      // Drive the linked frame to ready, as the historical-link case does.
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      first.release();
      await settle();
      map.requestTile(frameSource('2026-09-21'), 'dated-1');
      map.loadTile(frameSource('2026-09-21'), 'dated-1', true);
      await activation;
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);

      // Re-activated with no deactivate between: the axis now lists a
      // window that no longer includes the retained date.
      const reactivation = mod.activate(map);
      await settle();
      map.requestTile(frameSource('2026-09-26'), 'newest-1');
      map.loadTile(frameSource('2026-09-26'), 'newest-1', true);
      await reactivation;

      assert.equal(
        timeBars.get(KEY)?.stamp.headline,
        'Observed Sep 26, 2026',
        `the newest listed frame was not shown after the axis dropped the retained date: read ${describe(log.seen)}`
      );
      assert.equal(timeline.sstDate, null, 'sst= still names the date the new axis does not list');
      assert.match(
        timeBars.get(KEY)?.stamp.detail ?? '',
        /Sep 21, 2026/,
        `the stamp does not state the fallback: ${timeBars.get(KEY)?.stamp.detail}`
      );
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
    }
  );
});

test('a changed-axis fallback step, superseded while it awaits its own crossfade (tile proof already in, so showFrame\'s sibling guard already let it through clean), writes neither restoreNote nor a re-installed bar', async () => {
  const first = gate();
  const fade = gate();
  const changedXml =
    "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
    '<ows:Identifier>time</ows:Identifier>' +
    '<Domain>2026-09-22/2026-09-26/P1D</Domain>' +
    '<Size>1</Size></DimensionDomain></Domains>';
  await withSst(
    {
      sst: '2026-09-21',
      // call 1: the plain boot's axis (20-24, gated). call 2: the
      // re-activation whose axis drops 2026-09-21 (22-26, immediate). call
      // 3: a third activation whose own DescribeDomains never answers here;
      // it exists only to supersede call 2 (activate() aborts the previous
      // controller as its very first act, before any await of its own).
      answer: async (call) => {
        if (call === 1) {
          await first.held;
          return domainsOk();
        }
        if (call === 2) return domainsOk(changedXml);
        return new Promise(() => {}); // never answers; only its abort matters
      }
    },
    async ({ map, log }) => {
      // Drive the linked frame to ready, as the sibling case does.
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      first.release();
      await settle();
      map.requestTile(frameSource('2026-09-21'), 'dated-1');
      map.loadTile(frameSource('2026-09-21'), 'dated-1', true);
      await activation;
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);

      // Re-activated with no deactivate between: the axis drops the
      // retained date, so the changed-axis branch starts its own step to
      // the newest frame. Its tile proof is given at once (so showFrame's
      // own first guard, line 408, is already satisfied and `buffering`
      // already flips false, same as a real step that reached the fade),
      // but the crossfade itself is held open by `fade`, so the step is
      // left suspended in showFrame's SECOND await when superseded below.
      globalThis.__rasterReadinessTest.crossfadeGate = fade.held;
      const reactivation = mod.activate(map);
      await settle();
      map.requestTile(frameSource('2026-09-26'), 'newest-1');
      map.loadTile(frameSource('2026-09-26'), 'newest-1', true);
      await settle();

      // Supersede outright: this activation's own `masterController.abort()`
      // fires before its own DescribeDomains is even sent.
      const third = mod.activate(map);
      await settle();

      // Now let the superseded step's held crossfade resolve: showFrame's
      // own second guard (line 431) sees the abort and returns; the write
      // this repair guards runs only after that, in the caller.
      fade.release();
      await settle();
      await reactivation;
      await settle();

      const stamp = timeBars.get(KEY)?.stamp;
      const detail = stamp?.detail ?? '';
      assert.doesNotMatch(
        detail,
        /buffering tiles/,
        `the superseded step's own crossfade wait was still open when it wrote: ${detail} (read ${describe(log.seen)})`
      );
      assert.doesNotMatch(
        detail,
        /Sep 21, 2026/,
        `the superseded fallback step wrote its stale note after being aborted: ${detail} (read ${describe(log.seen)})`
      );

      // Tear down the still-pending third activation cleanly.
      mod.deactivate(map);
      await third;
    }
  );
});

test('a DescribeDomains failure under a historical sst= link clears the link date and states the fallback before the latest frame may read live', async () => {
  const domains = gate();
  await withSst(
    {
      sst: '2026-09-21',
      answer: async () => (
        await domains.held,
        new Response('Synthetic outage', { status: 500, statusText: 'Internal Server Error' })
      )
    },
    async ({ map, log, warn }) => {
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      assert.equal(registry.getStatus(KEY), 'loading', `read ${describe(log.seen)} with the time axis still in flight`);
      domains.release();
      await activation;

      assert.equal(timeline.sstDate, null, 'sst= still names the date the layer could not show');
      assert.ok(
        !log.seen.some((e) => (e.status === 'ready' || e.status === 'degraded') && e.sst !== null),
        `read ${describe(log.seen)}: live while sst= named another date`
      );
      // The stated fallback: the latest frame, its own tile verdict, and a
      // stamp that names the linked date it could not show.
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
      const stamp = timeBars.get(KEY)?.stamp;
      assert.ok(stamp, 'no stamp states the fallback');
      assert.match(stamp.headline, /date unavailable/);
      assert.match(stamp.detail, /Sep 21, 2026/, `the stamp does not name the linked date: ${stamp.detail}`);
      assert.equal(timeBars.get(KEY)?.rail, undefined, 'a rail was offered with no time axis');
      // M0: exactly one warning, naming the source.
      assert.equal(warn.messages.length, 1, `warned ${JSON.stringify(warn.messages)}`);
      assert.match(warn.messages[0], /\[sst-anomaly\]/);
    }
  );
});

test('an sst= date outside the enumerated window clears the link and states the fallback, never live under the unlisted date', async () => {
  const domains = gate();
  await withSst(
    { sst: '2026-08-01', answer: async () => (await domains.held, domainsOk()) },
    async ({ map, log }) => {
      const activation = mod.activate(map);
      await settle();
      proveLatestFrame(map);
      assert.equal(registry.getStatus(KEY), 'loading', `read ${describe(log.seen)} with the time axis still in flight`);
      domains.release();
      await activation;

      assert.equal(timeline.sstDate, null, 'sst= still names a date the axis does not list');
      assert.ok(
        !log.seen.some((e) => (e.status === 'ready' || e.status === 'degraded') && e.sst !== null),
        `read ${describe(log.seen)}: live while sst= named another date`
      );
      assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
      const stamp = timeBars.get(KEY)?.stamp;
      assert.equal(stamp?.headline, 'Observed Sep 24, 2026');
      assert.match(stamp?.detail ?? '', /Aug 1, 2026/, `the stamp does not state the fallback: ${stamp?.detail}`);
      assert.ok(timeBars.get(KEY)?.rail, 'the rail is still offered over the enumerated window');
    }
  );
});

test('the fallback statement clears once the user steps to a frame', async () => {
  await withSst({ sst: '2026-08-01', answer: () => domainsOk() }, async ({ map }) => {
    await mod.activate(map);
    assert.match(timeBars.get(KEY)?.stamp.detail ?? '', /Aug 1, 2026/);
    timeBars.get(KEY).rail.onStep(2); // 2026-09-22
    map.requestTile(frameSource('2026-09-22'), 'f1');
    map.loadTile(frameSource('2026-09-22'), 'f1', true);
    await settle();
    assert.equal(timeBars.get(KEY)?.stamp.headline, 'Observed Sep 22, 2026');
    assert.doesNotMatch(timeBars.get(KEY)?.stamp.detail ?? '', /Aug 1, 2026/);
  });
});

for (const [name, body] of [
  ['a blank 200 body', ''],
  ['an HTML page at 200', '<!doctype html><html><body>maintenance</body></html>'],
  ['an XML body that lists no time step', '<Domains><DimensionDomain><Domain>not-a-range</Domain></DimensionDomain></Domains>']
]) {
  test(`${name} from DescribeDomains is no time axis: the link date is cleared and stated, never live under it`, async () => {
    const domains = gate();
    await withSst(
      { sst: '2026-09-21', answer: async () => (await domains.held, domainsOk(body)) },
      async ({ map, log }) => {
        const activation = mod.activate(map);
        await settle();
        proveLatestFrame(map);
        domains.release();
        await activation;
        assert.equal(timeline.sstDate, null);
        assert.ok(
          !log.seen.some((e) => (e.status === 'ready' || e.status === 'degraded') && e.sst !== null),
          `read ${describe(log.seen)}`
        );
        assert.ok(!log.seen.some((e) => e.status === 'no-data'), `read ${describe(log.seen)}: an unreadable axis is not a verified absence`);
        assert.match(timeBars.get(KEY)?.stamp.detail ?? '', /Sep 21, 2026/);
      }
    );
  });
}

test('a stalled DescribeDomains reaches its stated fallback inside the 10 s boot-idle budget (M8)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = gate(); // never released: only the request budget ends it
  await withSst({ answer: async () => (await never.held, domainsOk()) }, async ({ map, log }) => {
    const activation = mod.activate(map);
    await settle();
    proveLatestFrame(map);
    assert.equal(registry.getStatus(KEY), 'loading');
    t.mock.timers.tick(BOOT_IDLE_BUDGET_MS - 1);
    await settle();
    await activation;
    assert.match(
      timeBars.get(KEY)?.stamp.headline ?? '(no stamp)',
      /date unavailable/,
      'the time axis was still in flight at the boot-idle budget'
    );
    assert.equal(registry.getStatus(KEY), 'ready', `read ${describe(log.seen)}`);
  });
});

test('an abort during the DescribeDomains body read cancels the stream, writes nothing and leaves no listener', async () => {
  let cancelled = () => undefined;
  const streamCancelled = new Promise((resolve) => {
    cancelled = resolve;
  });
  const stalledBody = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<Domains><DimensionDomain><Domain>2026-09-2'));
        },
        cancel() {
          cancelled();
        }
      }),
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  await withSst({ sst: '2026-09-21', answer: stalledBody }, async ({ map, log, warn }) => {
    const activation = mod.activate(map);
    await settle();
    mod.deactivate(map);
    const mark = log.seen.length;
    const outcome = await Promise.race([
      streamCancelled.then(() => 'cancelled'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000).unref())
    ]);
    assert.equal(outcome, 'cancelled', 'the stalled body was never cancelled');
    await activation;
    await settle();
    assert.equal(log.seen.length, mark, `wrote ${describe(log.seen.slice(mark))} after the cancel`);
    assert.equal(map.listenerCount(), 0, 'a map listener outlived deactivate');
    assert.deepEqual(warn.messages, [], 'a cancel is silent');
  });
});

test('a late DescribeDomains answer after a re-activation superseded it changes nothing', async () => {
  const first = gate();
  const lateXml = DOMAINS_XML.replace('2026-09-20/2026-09-24', '2026-08-01/2026-08-05');
  await withSst(
    { answer: async (call) => (call === 1 ? (await first.held, domainsOk(lateXml)) : domainsOk()) },
    async ({ map }) => {
      const superseded = mod.activate(map);
      await settle();
      registry.setStatus(KEY, 'loading');
      await mod.activate(map);
      proveLatestFrame(map);
      assert.equal(registry.getStatus(KEY), 'ready');
      first.release();
      await superseded;
      await settle();
      assert.equal(timeBars.get(KEY)?.stamp.headline, 'Observed Sep 24, 2026', 'the superseded answer rewrote the axis');
      assert.equal(registry.getStatus(KEY), 'ready');
    }
  );
});
