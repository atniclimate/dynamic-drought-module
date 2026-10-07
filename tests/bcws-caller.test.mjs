import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
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
test('actual source/layers and registry publish only after complete valid response; raw initial clocks remain distinct', async () => {
  const value = collection([1,2]); value.features[1].properties.FIRE_STATUS = null;
  const states = []; const unbind = registry.on('status-change', (layer, status) => { if (layer === key) states.push(status); });
  try { await setup(async () => response(value), async (caller,map) => {
    const start = Date.now(); await caller.activate(map);
    assert.deepEqual(states, ['loading','ready']); assert.equal(map.layers.size, 2);
    assert.deepEqual(map.getSource(key).data, valueWithoutCollectionProperties(value));
    const snapshot = caller.getSnapshot(); assert.equal(snapshot.complete, true);
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
  await setup(async () => response(page++ ? collection(Array.from({length:237},(_,i)=>1001+i)) :
    collection(Array.from({length:1000},(_,i)=>1+i), true)), async (caller,map) => {
    await caller.activate(map); assert.equal(page,2); assert.equal(registry.getStatus(key),'ready');
    assert.equal(map.getSource(key).data.features.length,1237);
  });
});
test('complete empty clears old rendering and is no-data with an answered retrieval clock', async () => {
  let page = 0;
  await setup(async () => response(page++ ? collection([]) : collection([1])), async (caller,map) => {
    await caller.activate(map); await caller.refresh();
    assert.equal(registry.getStatus(key),'no-data'); assert.equal(map.sources.size,0); assert.equal(map.layers.size,0);
    assert.equal(caller.getSnapshot().reason,'answered'); assert.equal(typeof caller.getSnapshot().retrievedAt,'number');
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
test('world-wrap views use BC coverage correctly and off-coverage pan clears old source', async () => {
  const urls = [];
  await setup(async url => { urls.push(new URL(url)); return response(collection([1])); }, async (caller,map) => {
    map.setBounds([220,48,250,55]); await caller.activate(map);
    assert.equal(urls[0].searchParams.get('geometry'),'-139.5,48,-113.5,55');
    map.setBounds([170,48,-170,55]); await caller.refresh();
    assert.equal(urls.length,1); assert.equal(map.sources.size,0); assert.equal(caller.getSnapshot().reason,'off-coverage');
  });
});
test('partial polygons render with degraded while an incomplete empty read is error', async () => {
  for (const ids of [[1],[]]) {
    let calls = 0;
    await setup(async () => calls++ ? new Response('',{status:503}) : response(collection(ids,true)), async (caller,map) => {
      await caller.activate(map); assert.equal(registry.getStatus(key),ids.length?'degraded':'error');
      assert.equal(caller.getSnapshot().complete,false);
      assert.equal(map.sources.size,ids.length?1:0);
      if (!ids.length) assert.equal(caller.getSnapshot().retrievedAt,null);
    });
  }
});
for (const [label,value] of [
  ['semantic error at 200',{error:{code:400}}],
  ['bad geometry',{type:'FeatureCollection',features:[{...feature(1),geometry:null}]}],
  ['missing FIRE_STATUS',{type:'FeatureCollection',features:[{...feature(1),properties:{OBJECTID:1}}]}]
]) test(label+' is unavailable and publishes no polygons', async () => {
  await setup(async () => response(value), async (caller,map) => {
    await caller.activate(map); assert.equal(registry.getStatus(key),'error');
    assert.equal(map.sources.size,0); assert.equal(map.layers.size,0);
    assert.equal(caller.getSnapshot().retrievedAt,null);
  });
});
test('superseding request owns publication when an old fetch ignores cancellation', async () => {
  const first = deferred(); const entered = deferred(); let calls = 0;
  await setup(async () => { if (!calls++) { entered.resolve(); return first.promise; } return response(collection([2])); }, async (caller,map) => {
    const older = caller.activate(map); await entered.promise;
    map.setBounds([-124,49,-118,51]); await caller.refresh();
    first.resolve(response(collection([1]))); await older;
    assert.equal(map.getSource(key).data.features[0].properties.OBJECTID,2);
    assert.equal(registry.getStatus(key),'ready');
  });
});
test('cancelActivation aborts a stalled body synchronously; deactivate removes layers/listeners and late work cannot revive status', async () => {
  const headers = deferred(); let signal; let cancelled = false;
  await setup(async (_url,init) => { signal=init.signal; headers.resolve(); return new Response(new ReadableStream({cancel(){cancelled=true;}})); }, async (caller,map) => {
    const pending = caller.activate(map); await headers.promise;
    caller.cancelActivation(); assert.equal(signal.aborted,true);
    caller.deactivate(); registry.deactivate(key);
    await pending; assert.equal(cancelled,true); assert.equal(registry.getStatus(key),undefined);
    assert.equal(map.sources.size,0); assert.equal(map.events.get('moveend').size,0); assert.equal(caller.getSnapshot(),null);
  });
});
test('deactivate before a cancellation-ignoring fetch resolves discards late response', async () => {
  const first = deferred(); const entered = deferred();
  await setup(async () => { entered.resolve(); return first.promise; }, async (caller,map) => {
    const pending = caller.activate(map); await entered.promise;
    caller.deactivate(); registry.deactivate(key);
    first.resolve(response(collection([1]))); await pending;
    assert.equal(map.sources.size,0); assert.equal(map.layers.size,0); assert.equal(registry.getStatus(key),undefined);
  });
});
test('stalled aggregate deadline settles unavailable without source publication', async () => {
  let cancelled=false;
  const config=configuration(); config.limits={...config.limits,totalTimeoutMs:25,pageTimeoutMs:1000};
  await setup(async () => new Response(new ReadableStream({cancel(){cancelled=true;}})), async (caller,map) => {
    await caller.activate(map); assert.equal(cancelled,true); assert.equal(registry.getStatus(key),'error'); assert.equal(map.sources.size,0);
  },config);
});
test('repeated activate keeps one listener/read, moveend refreshes, deactivate removes it', async () => {
  let calls=0;
  await setup(async () => {calls++;return response(collection([calls]));},async(caller,map)=>{
    await caller.activate(map); await caller.activate(map);
    assert.equal(calls,1); assert.equal(map.events.get('moveend').size,1);
    const ready=deferred(); const remove=registry.on('status-change',(layer,status)=>{if(layer===key&&status==='ready')ready.resolve();});
    try {map.emit('moveend');await ready.promise;} finally {remove();}
    assert.equal(calls,2); caller.deactivate(); assert.equal(map.events.get('moveend').size,0);
    map.emit('moveend');assert.equal(calls,2);
  });
});


test('reactivation retries failed reads and restores removed style resources through a fresh read', async () => {
  let calls=0;
  await setup(async()=> ++calls === 1 ? new Response('',{status:503}) : response(collection([calls])), async(caller,map)=>{
    await caller.activate(map); assert.equal(registry.getStatus(key),'error');
    await caller.activate(map); assert.equal(calls,2); assert.equal(registry.getStatus(key),'ready');
    map.layers.clear(); map.sources.clear();
    await caller.activate(map); assert.equal(calls,3); assert.equal(map.layers.size,2); assert.equal(map.sources.size,1);
  });
});
test('byte and vertex rejection are error, never clean no-data or partial publication', async () => {
  for(const limit of [{maxPageBytes:1},{maxVertices:3}]) {
    const config=configuration(); config.limits={...config.limits,...limit};
    await setup(async()=>response(collection([1])),async(caller,map)=>{
      await caller.activate(map);assert.equal(registry.getStatus(key),'error');
      assert.equal(caller.getSnapshot().complete,false);assert.equal(map.sources.size,0);assert.equal(caller.getSnapshot().retrievedAt,null);
    },config);
  }
});
