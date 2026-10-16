import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

/**
 * The two live Tribal-geography layers (BIA AIAN-LAR Reservation Boundaries
 * and Census AIANNH Tribal Lands) at the national boot view. Audit 10 found
 * the BIA query asked for full-detail shapes (16 MB of JSON for the
 * contiguous US) and that both layers refetched on an ordinary pan, because
 * the cache was read by an exact bucketed key even when a cached envelope
 * still covered the view.
 *
 * Pinned here: both queries carry the half-pixel `maxAllowableOffset` for
 * the zoom bucket plus `geometryPrecision=5`; a pan the 25 percent overscan
 * still covers is served from the cache with no request; a new zoom bucket
 * fetches; returning to a cached view at the old bucket fetches nothing.
 *
 * Runs under plain `node --test` (Node 24 strips types) with the same
 * resolve hook as tests/hillshade-abort.test.mjs. No network: every request
 * is answered by a stand-in shape.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

// Imported before `window` exists: some transitive UI modules read browser
// globals at import time when they see one.
const LAYERS = {
  bia: await import('../src/layers/bia-reservations.ts'),
  aiannh: await import('../src/layers/aiannh.ts')
};

/** Debounce timers the modules schedule through `window.setTimeout`, run by hand. */
const pendingTimers = new Map();
let nextTimerId = 1;
globalThis.window = {};
globalThis.window.setTimeout = (fn) => {
  const id = nextTimerId++;
  pendingTimers.set(id, fn);
  return id;
};
globalThis.window.clearTimeout = (id) => {
  pendingTimers.delete(id);
};

function runPendingTimers() {
  const fns = [...pendingTimers.values()];
  pendingTimers.clear();
  for (const fn of fns) fn();
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const STAND_IN = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { LARID: 1, NAME: 'Stand-in', LARNAME: 'Stand-in' },
      geometry: { type: 'Polygon', coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]] }
    }
  ]
};

function installFetch(hostPattern) {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (!hostPattern.test(url)) {
      return Promise.reject(new Error(`unexpected egress from a node test: ${url}`));
    }
    urls.push(new URL(url));
    return Promise.resolve(
      new Response(JSON.stringify(STAND_IN), {
        status: 200,
        headers: { 'Content-Type': 'application/geo+json' }
      })
    );
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

/** The part of a MapLibre map the two layer modules touch. */
function fakeMap(view) {
  const sources = new Map();
  const layers = new Set();
  const handlers = new Map();
  return {
    view,
    getBounds: () => ({
      getWest: () => view.west,
      getSouth: () => view.south,
      getEast: () => view.east,
      getNorth: () => view.north
    }),
    getZoom: () => view.zoom,
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => {
      sources.set(id, { data: spec.data, setData(data) { this.data = data; } });
    },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => (layers.has(id) ? { id } : undefined),
    addLayer: (layer) => layers.add(layer.id),
    removeLayer: (id) => layers.delete(id),
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event),
    async moveTo(next) {
      Object.assign(view, next);
      handlers.get('moveend')?.();
      runPendingTimers();
      await settle();
    }
  };
}

const NATIONAL = { west: -125, south: 24, east: -66, north: 50, zoom: 4.3 };

async function exerciseLayer(layer, hostPattern) {
  const fetches = installFetch(hostPattern);
  const map = fakeMap({ ...NATIONAL });
  try {
    await layer.activate(map);
    await settle();
    assert.equal(fetches.urls.length, 1, 'the national boot view fetches once');
    const boot = fetches.urls[0].searchParams;
    assert.equal(boot.get('geometryPrecision'), '5');
    // Half a 512-pixel-tile pixel at zoom bucket 4: 360 / (512 * 16) / 2.
    assert.equal(boot.get('maxAllowableOffset'), '0.021973');

    await map.moveTo({ west: -123, east: -64 });
    assert.equal(fetches.urls.length, 1, 'a 2 degree pan inside the overscan is served from the cache');

    await map.moveTo({ west: -120.5, east: -61.5, south: 24.3, north: 50.3 });
    assert.equal(fetches.urls.length, 1, 'a 4.5 degree pan inside the overscan is served from the cache');

    await map.moveTo({ zoom: 5.1 });
    assert.equal(fetches.urls.length, 2, 'a new zoom bucket fetches at its own tolerance');
    assert.equal(fetches.urls[1].searchParams.get('maxAllowableOffset'), '0.010986');

    await map.moveTo({ ...NATIONAL, west: -124, east: -65 });
    assert.equal(fetches.urls.length, 2, 'a view the cached zoom-4 envelope covers fetches nothing');

    await map.moveTo({ west: -40, east: 19, zoom: 4.3 });
    assert.equal(fetches.urls.length, 3, 'a view outside every cached envelope fetches');
  } finally {
    layer.deactivate(map);
    fetches.restore();
  }
}

test('BIA Reservation Boundaries: generalized query and a covering-envelope cache', async () => {
  await exerciseLayer(LAYERS.bia, /biamaps\.geoplatform\.gov/);
});

test('Census AIANNH Tribal Lands: a covering-envelope cache on ordinary pans', async () => {
  await exerciseLayer(LAYERS.aiannh, /tigerweb\.geo\.census\.gov/);
});
