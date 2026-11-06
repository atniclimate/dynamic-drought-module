import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
// The layer module's peripheral imports (the click coordinator and the legend
// panel need a DOM); the caller under test touches neither.
const stubs = {
  '/map/interaction-coordinator': 'export function registerClickTarget(){}',
  '/ui/legend-registry': 'export const LEGEND_ORDER={surface:1,event:2}; export function showLegend(){} export function hideLegend(){} export function renderSwatchLegend(){}'
};
registerHooks({ resolve(specifier, context, nextResolve) {
  const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
  if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { registry } = await import('../src/state/registry.ts');
const moduleUnderTest = () => import('../src/layers/bcws-fires.ts');
const key = 'bcws-fires';
const feature = (id, status = 'Being Held') => ({ type: 'Feature', properties: {
  OBJECTID: id, FIRE_NUMBER: 'K00001', FIRE_YEAR: 2025, VERSION_NUMBER: id,
  FIRE_STATUS: status, TRACK_DATE: 1787295600000, LOAD_DATE: 1787382000000
}, geometry: { type: 'Polygon', coordinates: [[[-120,49],[-119,49],[-119,50],[-120,49]]] } });
const collection = (ids, incomplete = false) => ({ type: 'FeatureCollection', properties: { exceededTransferLimit: incomplete }, features: ids.map(id => feature(id)) });
const response = value => new Response(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const isCount = url => new URL(String(url)).searchParams.get('returnCountOnly') === 'true';
/** Answer the read's two whole-table counts (a steady table), and hand every other request to `reads`. */
const serve = (reads, count = 319) => async (url, init) => isCount(url) ? response({ count }) : reads(url, init);
function fakeMap(initial = [-125,48,-116,50]) {
  let view = initial; const sources = new Map(); const layers = new Map(); const events = new Map();
  const map = {
    sources, layers, events,
    setBounds(value) { view = value; },
    getBounds() { return { getWest:()=>view[0], getSouth:()=>view[1], getEast:()=>view[2], getNorth:()=>view[3] }; },
    getSource(id) { return sources.get(id); },
    addSource(id, specification) { sources.set(id, { data: specification.data, setData(data) { this.data = data; } }); },
    removeSource(id) { sources.delete(id); },
    getLayer(id) { return layers.get(id); },
    addLayer(layer) { layers.set(layer.id, layer); },
    removeLayer(id) { layers.delete(id); },
    on(event, listener) { const handlers = events.get(event) ?? new Set(); handlers.add(listener); events.set(event, handlers); },
    off(event, listener) { events.get(event)?.delete(listener); },
    emit(event) { for (const listener of events.get(event) ?? []) listener(); }
  }; return map;
}
const configuration = overrides => ({
  endpoint: 'https://fixture.invalid/query',
  coverage: [-139.5,48,-113.5,60],
  // Fixture-only inputs. No production resource values or issuer palette is adopted here.
  limits: { pageSize: 1000, pageLimit: 10, pageTimeoutMs: 200, totalTimeoutMs: 500,
    maxPageBytes: 2000000, maxTotalBytes: 4000000, maxVertices: 50000 },
  fillPaint: { 'fill-color':'#ff0000', 'fill-opacity':0.1 },
  linePaint: { 'line-color':'#000000', 'line-width':1 },
  refreshDebounceMs: 5,
  ...overrides
});
async function setup(fetcher, body, overrides) {
  const { createBcwsCaller } = await moduleUnderTest();
  const previous = globalThis.fetch; globalThis.fetch = fetcher;
  const caller = createBcwsCaller(configuration(overrides)); const map = fakeMap();
  registry.activate(key);
  try { await body(caller, map); }
  finally { caller.deactivate(); registry.deactivate(key); globalThis.fetch = previous; }
}
const withoutStageClass = data => ({ type: 'FeatureCollection', features: data.features.map(f => {
  const { ddm_stage_class: _cls, ...properties } = f.properties; return { ...f, properties };
}) });
test('actual source/layers and registry publish only after complete valid response; raw initial clocks remain distinct', async () => {
  const value = collection([1,2]); value.features[1].properties.FIRE_STATUS = null;
  const states = []; const unbind = registry.on('status-change', (layer, status) => { if (layer === key) states.push(status); });
  try { await setup(serve(async () => response(value)), async (caller,map) => {
    const start = Date.now(); await caller.activate(map);
    assert.deepEqual(states, ['loading','ready']); assert.equal(map.layers.size, 2);
    assert.deepEqual(withoutStageClass(map.getSource(key).data), valueWithoutCollectionProperties(value));
    // The map source alone carries the stage class the paint reads; the snapshot keeps the raw record.
    assert.deepEqual(map.getSource(key).data.features.map(f => f.properties.ddm_stage_class), ['active', 'unknown']);
    const snapshot = caller.getSnapshot(); assert.equal(snapshot.complete, true);
    assert.equal('ddm_stage_class' in snapshot.collection.features[0].properties, false);
    assert.ok(snapshot.retrievedAt >= start); assert.ok(snapshot.retrievedAt <= Date.now());
    assert.equal(snapshot.collection.features[0].properties.FIRE_YEAR, 2025);
    assert.equal(snapshot.collection.features[0].properties.TRACK_DATE, 1787295600000);
    assert.equal(snapshot.collection.features[0].properties.LOAD_DATE, 1787382000000);
    assert.equal(snapshot.collection.features[1].properties.FIRE_STATUS, null);
    assert.equal('observedAt' in snapshot, false); assert.equal('discoveredAt' in snapshot, false);
  }); } finally { unbind(); }
});
function valueWithoutCollectionProperties(value) { return { type:'FeatureCollection', features:value.features }; }
test('full real paging through caller commits 1000+237 records once settled', async () => {
  let page = 0;
  await setup(serve(async () => response(page++ ? collection(Array.from({length:237},(_,i)=>1001+i)) :
    collection(Array.from({length:1000},(_,i)=>1+i), true))), async (caller,map) => {
    await caller.activate(map); assert.equal(page,2); assert.equal(registry.getStatus(key),'ready');
    assert.equal(map.getSource(key).data.features.length,1237);
  });
});
test('the production read is one page: a view that needs a second reads live (partial), never complete', async () => {
  const { BCWS_READ_LIMITS } = await import('../src/util/bcws-perimeter-read.ts');
  let pages = 0;
  await setup(serve(async () => { pages++; return response(collection(Array.from({length:1000},(_,i)=>1+i), true)); }), async (caller,map) => {
    await caller.activate(map); assert.equal(pages,1); assert.equal(registry.getStatus(key),'degraded');
    assert.equal(caller.getSnapshot().complete,false);
  }, { limits: BCWS_READ_LIMITS });
});
test('complete empty clears old rendering and is no-data with an answered retrieval clock', async () => {
  let page = 0;
  await setup(serve(async () => response(page++ ? collection([]) : collection([1]))), async (caller,map) => {
    await caller.activate(map);
    map.setBounds([-124,49,-117,51]); await caller.refresh();
    assert.equal(registry.getStatus(key),'no-data'); assert.equal(map.sources.size,0); assert.equal(map.layers.size,0);
    assert.equal(caller.getSnapshot().reason,'answered'); assert.equal(typeof caller.getSnapshot().retrievedAt,'number');
  });
});
test('a reload during the read (the two whole-table counts disagree) is never complete, so an emptied layer is unavailable, not no-data', async () => {
  for (const ids of [[], [1]]) {
    let counts = 0;
    await setup(async url => isCount(url) ? response({ count: counts++ ? 319 : 0 }) : response(collection(ids)), async (caller,map) => {
      await caller.activate(map);
      assert.equal(caller.getSnapshot().complete,false); assert.equal(caller.getSnapshot().reason,'incomplete');
      assert.equal(registry.getStatus(key), ids.length ? 'degraded' : 'error');
    });
  }
  // A count that fails or does not parse is the same: no proof, no completeness.
  await setup(async url => isCount(url) ? new Response('',{status:503}) : response(collection([1])), async (caller,map) => {
    await caller.activate(map); assert.equal(caller.getSnapshot().complete,false);
  });
});
test('off static coverage makes zero requests and records coverage reason, not a fabricated retrieval', async () => {
  let calls = 0;
  await setup(async () => { calls++; return response(collection([1])); }, async (caller,map) => {
    map.setBounds([-100,30,-90,40]); await caller.activate(map);
    assert.equal(calls,0); assert.equal(registry.getStatus(key),'no-data');
    assert.equal(caller.getSnapshot().reason,'off-coverage'); assert.equal(caller.getSnapshot().retrievedAt,null);
    assert.equal(map.sources.size,0);
  });
});
test('the query is the overscanned view envelope cut to the coverage (DDM-P1-T06), world-wrap views included; an off-coverage pan clears the old source', async () => {
  const urls = [];
  await setup(serve(async url => { urls.push(new URL(url)); return response(collection([1])); }), async (caller,map) => {
    map.setBounds([220,48,250,55]); await caller.activate(map);
    // [220,48,250,55] overscans by a quarter each side to [212.5,46.25,257.5,56.75], wraps to -147.5..-102.5, then is cut.
    assert.equal(urls[0].searchParams.get('geometry'),'-139.5,48,-113.5,56.75');
    map.setBounds([170,48,-170,55]); await caller.refresh();
    assert.equal(urls.length,1); assert.equal(map.sources.size,0); assert.equal(caller.getSnapshot().reason,'off-coverage');
  });
});
test('a pan inside the answered envelope reuses it with no request; leaving it re-queries after the debounce', async () => {
  let calls = 0;
  await setup(serve(async () => { calls++; return response(collection([calls])); }), async (caller,map) => {
    map.setBounds([-124,49,-120,51]); await caller.activate(map); assert.equal(calls,1);
    map.setBounds([-123.5,49.2,-119.5,51.2]); map.emit('moveend'); map.emit('moveend');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls,1,'covered by the overscanned answer'); assert.equal(registry.getStatus(key),'ready');
    const ready = deferred(); const remove = registry.on('status-change',(layer,status)=>{ if (layer===key && status==='ready') ready.resolve(); });
    try { map.setBounds([-118,55,-114,57]); map.emit('moveend'); map.emit('moveend'); await ready.promise; } finally { remove(); }
    assert.equal(calls,2,'two moveends inside the debounce make one read');
  });
});
test('partial polygons render with degraded while an incomplete empty read is error', async () => {
  for (const ids of [[1],[]]) {
    let calls = 0;
    await setup(serve(async () => calls++ ? new Response('',{status:503}) : response(collection(ids,true))), async (caller,map) => {
      await caller.activate(map); assert.equal(registry.getStatus(key),ids.length?'degraded':'error');
      assert.equal(caller.getSnapshot().complete,false);
      assert.equal(map.sources.size,ids.length?1:0);
      if (!ids.length) assert.equal(caller.getSnapshot().retrievedAt,null);
    });
  }
});
test('a failed re-query keeps the last answer\'s honest status while that answer still covers the view (DDM-P1-T06 clause 4)', async () => {
  let calls = 0;
  await setup(serve(async () => calls++ ? new Response('',{status:503}) : response(collection([1]))), async (caller,map) => {
    map.setBounds([-124,49,-120,51]); await caller.activate(map);
    await caller.refresh(); assert.equal(calls,1,'a fresh covering answer needs no request');
  });
  calls = 0;
  await setup(serve(async () => calls++ ? new Response('',{status:503}) : response(collection([1]))), async (caller,map) => {
    map.setBounds([-124,49,-120,51]); await caller.activate(map);
    await caller.refresh(); assert.equal(calls,2,'a stale answer re-queries');
    assert.equal(registry.getStatus(key),'ready','the covering answer still stands'); assert.equal(map.sources.size,1);
    map.setBounds([-118,55,-114,57]); await caller.refresh();
    assert.equal(registry.getStatus(key),'error','a view it does not cover is unavailable'); assert.equal(map.sources.size,0);
  }, { reuseMs: -1 });
});
for (const [label,value] of [
  ['semantic error at 200',{error:{code:400}}],
  ['bad geometry',{type:'FeatureCollection',features:[{...feature(1),geometry:null}]}],
  ['missing FIRE_STATUS',{type:'FeatureCollection',features:[{...feature(1),properties:{OBJECTID:1}}]}]
]) test(label+' is unavailable and publishes no polygons', async () => {
  await setup(serve(async () => response(value)), async (caller,map) => {
    await caller.activate(map); assert.equal(registry.getStatus(key),'error');
    assert.equal(map.sources.size,0); assert.equal(map.layers.size,0);
    assert.equal(caller.getSnapshot().retrievedAt,null);
  });
});
test('superseding request owns publication when an old fetch ignores cancellation', async () => {
  const first = deferred(); const entered = deferred(); let calls = 0;
  await setup(serve(async () => { if (!calls++) { entered.resolve(); return first.promise; } return response(collection([2])); }), async (caller,map) => {
    const older = caller.activate(map); await entered.promise;
    map.setBounds([-124,49,-118,51]); await caller.refresh();
    first.resolve(response(collection([1]))); await older;
    assert.equal(map.getSource(key).data.features[0].properties.OBJECTID,2);
    assert.equal(registry.getStatus(key),'ready');
  });
});
test('cancelActivation aborts a stalled body synchronously; deactivate removes layers/listeners and late work cannot revive status', async () => {
  const headers = deferred(); let signal; let cancelled = false;
  await setup(serve(async (_url,init) => { signal=init.signal; headers.resolve(); return new Response(new ReadableStream({cancel(){cancelled=true;}})); }), async (caller,map) => {
    const pending = caller.activate(map); await headers.promise;
    caller.cancelActivation(); assert.equal(signal.aborted,true);
    caller.deactivate(); registry.deactivate(key);
    await pending; assert.equal(cancelled,true); assert.equal(registry.getStatus(key),undefined);
    assert.equal(map.sources.size,0); assert.equal(map.events.get('moveend').size,0); assert.equal(caller.getSnapshot(),null);
  });
});
test('deactivate before a cancellation-ignoring fetch resolves discards late response', async () => {
  const first = deferred(); const entered = deferred();
  await setup(serve(async () => { entered.resolve(); return first.promise; }), async (caller,map) => {
    const pending = caller.activate(map); await entered.promise;
    caller.deactivate(); registry.deactivate(key);
    first.resolve(response(collection([1]))); await pending;
    assert.equal(map.sources.size,0); assert.equal(map.layers.size,0); assert.equal(registry.getStatus(key),undefined);
  });
});
test('stalled aggregate deadline settles unavailable without source publication', async () => {
  let cancelled=false;
  const config=configuration(); config.limits={...config.limits,totalTimeoutMs:25,pageTimeoutMs:1000};
  await setup(serve(async () => new Response(new ReadableStream({cancel(){cancelled=true;}}))), async (caller,map) => {
    await caller.activate(map); assert.equal(cancelled,true); assert.equal(registry.getStatus(key),'error'); assert.equal(map.sources.size,0);
  },config);
});
test('repeated activate keeps one listener/read, moveend refreshes, deactivate removes it', async () => {
  let calls=0;
  await setup(serve(async () => {calls++;return response(collection([calls]));}),async(caller,map)=>{
    await caller.activate(map); await caller.activate(map);
    assert.equal(calls,1); assert.equal(map.events.get('moveend').size,1);
    const ready=deferred(); const remove=registry.on('status-change',(layer,status)=>{if(layer===key&&status==='ready')ready.resolve();});
    try {map.setBounds([-118,55,-114,57]); map.emit('moveend');await ready.promise;} finally {remove();}
    assert.equal(calls,2); caller.deactivate(); assert.equal(map.events.get('moveend').size,0);
    map.emit('moveend');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,2);
  });
});


test('reactivation retries failed reads and restores removed style resources through a fresh read', async () => {
  let calls=0;
  await setup(serve(async()=> ++calls === 1 ? new Response('',{status:503}) : response(collection([calls]))), async(caller,map)=>{
    await caller.activate(map); assert.equal(registry.getStatus(key),'error');
    await caller.activate(map); assert.equal(calls,2); assert.equal(registry.getStatus(key),'ready');
    map.layers.clear(); map.sources.clear();
    await caller.activate(map); assert.equal(calls,3); assert.equal(map.layers.size,2); assert.equal(map.sources.size,1);
  });
});
test('byte and vertex rejection are error, never clean no-data or partial publication', async () => {
  for(const limit of [{maxPageBytes:1},{maxVertices:3}]) {
    const config=configuration(); config.limits={...config.limits,...limit};
    await setup(serve(async()=>response(collection([1]))),async(caller,map)=>{
      await caller.activate(map);assert.equal(registry.getStatus(key),'error');
      assert.equal(caller.getSnapshot().complete,false);assert.equal(map.sources.size,0);assert.equal(caller.getSnapshot().retrievedAt,null);
    },config);
  }
});
test('the production read sends the drift-checked field list, the stage whitelist where clause stays the three active stages', async () => {
  const { BCWS_OUT_FIELDS, BCWS_ACTIVE_STAGES, BCWS_ACTIVE_WHERE, bcwsStatusClass, readBcwsPerimeters } = await import('../src/util/bcws-perimeter-read.ts');
  for (const stage of BCWS_ACTIVE_STAGES) assert.equal(bcwsStatusClass(stage), 'active');
  assert.equal(BCWS_ACTIVE_WHERE, "FIRE_STATUS IN ('Out of Control','Being Held','Under Control')");
  const urls = []; const previous = globalThis.fetch;
  globalThis.fetch = serve(async url => { urls.push(new URL(url)); return response(collection([1])); });
  try {
    await readBcwsPerimeters({ ...configuration().limits, endpoint: 'https://fixture.invalid/query', signal: new AbortController().signal, where: BCWS_ACTIVE_WHERE });
  } finally { globalThis.fetch = previous; }
  assert.equal(urls[0].searchParams.get('outFields'), BCWS_OUT_FIELDS.join(','));
  assert.equal(urls[0].searchParams.get('where'), BCWS_ACTIVE_WHERE);
});
