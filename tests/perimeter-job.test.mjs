import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { fingerprintPerimeter } = await import('../src/util/perimeter-fingerprints.ts');
const { runPerimeterJob } = await import('../src/util/perimeter-job.ts');
const { groupPerimetersInWorker } = await import('../src/util/perimeter-job-client.ts');
const validation = { maxVertices: 1000, maxSegmentTests: 100000 };
const limits = { maxInputChars: 100000, maxTotalVertices: 2000, maxCandidatePairs: 20,
  fingerprint: { geometry: validation, maxNodes: 10000, maxDepth: 30, maxChars: 50000 },
  kernel: { maxVersions: 20, maxRecords: 20, maxPairChecks: 500, maxIdentityChars: 150000, maxComponentsPerPair: 20 },
  clip: { input: validation, output: validation } }; // synthetic allowances, not production defaults
const ring = (x,y,w=1,h=1) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
const polygon = (...rings) => ({ type:'Polygon', coordinates:rings });
const record = (issuer,geometry,properties) => ({issuer,geometry,properties});
const a = geometry => record('nifc',geometry,{attr_UniqueFireIdentifier:'2026-A'});
const b = geometry => record('bcws',geometry,{FIRE_YEAR:2025,FIRE_NUMBER:'B',VERSION_NUMBER:1});
const json = rows => JSON.stringify(rows);
test('canonical full geometry preserves holes/components and exact attribute revisions', () => {
  const outer=ring(0,0,10,10), h1=ring(1,1), h2=ring(4,4), island=ring(20,20);
  const shift = r => [...r.slice(2,-1),...r.slice(0,2),r[2]].reverse();
  const g={type:'MultiPolygon',coordinates:[[outer,h1,h2],[island]]};
  const equivalent={type:'MultiPolygon',coordinates:[[shift(island)],[shift(outer),shift(h2),shift(h1)]]};
  const first=fingerprintPerimeter(g,{VERSION_NUMBER:1,name:'a',nested:{b:2,a:1}},limits.fingerprint);
  const reordered=fingerprintPerimeter(equivalent,{nested:{a:1,b:2},name:'a',VERSION_NUMBER:1},limits.fingerprint);
  assert.equal(first.geometryFingerprint,reordered.geometryFingerprint);
  assert.equal(first.revisionFingerprint,reordered.revisionFingerprint);
  assert.notEqual(first.revisionFingerprint,fingerprintPerimeter(g,{VERSION_NUMBER:2,name:'a',nested:{b:2,a:1}},limits.fingerprint).revisionFingerprint);
  assert.notEqual(first.geometryFingerprint,fingerprintPerimeter({type:'MultiPolygon',coordinates:[[outer,h1],[island]]},{},limits.fingerprint).geometryFingerprint);
  const zero=fingerprintPerimeter(polygon(ring(0,0)),{n:0},limits.fingerprint);
  const neg=polygon(ring(0,0));neg.coordinates[0][0][0]=-0;neg.coordinates[0][4][0]=-0;
  assert.equal(zero.geometryFingerprint,fingerprintPerimeter(neg,{n:0},limits.fingerprint).geometryFingerprint);
  assert.notEqual(zero.revisionFingerprint,fingerprintPerimeter(neg,{n:-0},limits.fingerprint).revisionFingerprint);
});
test('fingerprint rejects unsupported attributes and exhausted caller allowances', () => {
  const g=polygon(ring(0,0)); const cyclic={};cyclic.self=cyclic;
  for(const p of [cyclic,{x:NaN},{x:undefined},{x:1n},{x:new Date()}]) assert.throws(()=>fingerprintPerimeter(g,p,limits.fingerprint));
  const getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){assert.fail('getter executed');}});
  assert.throws(()=>fingerprintPerimeter(g,getter,limits.fingerprint),/Non-JSON/);
  for(const setting of [{maxChars:10},{maxNodes:2},{maxDepth:1}]) assert.throws(()=>fingerprintPerimeter(g,{}, {...limits.fingerprint,...setting}));
});
test('actual strict clip plus spherical measurement links containment and retains raw positions', async () => {
  const rows=[a(polygon(ring(-120,45,.1,.1))),b(polygon(ring(-119.98,45.02,.02,.02)))];
  const result=await runPerimeterJob(json([...rows,rows[0]]),limits);
  assert.equal(result.graph.groups.length,1);assert.equal(result.graph.complete,true);
  assert.equal(result.graph.versions.find(v=>v.issuer==='bcws').fireYear,null);
  assert.deepEqual(result.sources.find(v=>v.indices.length===2).indices,[0,2]);
  const reversed=await runPerimeterJob(json(rows.reverse()),limits);
  assert.deepEqual(result.graph.groups,reversed.graph.groups);
});
test('issuer/year/zero-area-box filters do not load clipper; positive boxes are not proof', async () => {
  let loads=0;const forbidden=async()=>{loads++;assert.fail('clipper loaded without candidate');};
  await runPerimeterJob(json([a(polygon(ring(0,0))),a(polygon(ring(0,0)))]),limits,forbidden);
  const disjoint=await runPerimeterJob(json([a(polygon(ring(0,0))),b(polygon(ring(1,0)))]),limits,forbidden);
  assert.equal(disjoint.graph.groups.length,2);assert.equal(disjoint.graph.complete,true);assert.equal(loads,0);
  // Positive overlapping boxes, actual disjoint interiors on opposite sides of y=x.
  const left=polygon([[0,0],[2,0],[0,2],[0,0]]);
  const right=polygon([[2,2],[2,.5],[.5,2],[2,2]]);
  const actual=await runPerimeterJob(json([a(left),b(right)]),limits);
  assert.equal(actual.graph.groups.length,2);assert.equal(actual.graph.complete,true);
});
test('failed pair evidence is incomplete, and whole-job bounds never yield exact partial output', async () => {
  const rows=[a(polygon(ring(0,0))),b(polygon(ring(.1,.1)))];
  const uncertain=await runPerimeterJob(json(rows),limits,async()=>()=>{throw new Error('numerical refusal');});
  assert.equal(uncertain.graph.groups.length,2);assert.equal(uncertain.graph.complete,false);assert.equal(uncertain.graph.unresolvedPairs.length,1);
  await assert.rejects(runPerimeterJob(json(rows),{...limits,maxTotalVertices:5}));
  await assert.rejects(runPerimeterJob(json(rows),{...limits,maxInputChars:10}));
  const third=record('nifc',polygon(ring(.2,.2)),{attr_UniqueFireIdentifier:'2026-C'});
  await assert.rejects(runPerimeterJob(json([...rows,third]),{...limits,maxCandidatePairs:1}));
});
function fakeWorker() {
  return {onmessage:null,onerror:null,onmessageerror:null,request:null,terminated:0,
    postMessage(request){this.request=request;},terminate(){this.terminated++;}};
}
test('whole-job client abort/deadline terminate worker and never become empty success', async () => {
  const worker=fakeWorker(),controller=new AbortController();
  const pending=groupPerimetersInWorker('[]',{signal:controller.signal,generation:1,deadlineMs:1000,limits,createWorker:()=>worker});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(worker.terminated,1);assert.equal(worker.onmessage,null);
  const stalled=fakeWorker();
  await assert.rejects(groupPerimetersInWorker('[]',{signal:new AbortController().signal,generation:2,deadlineMs:10,limits,createWorker:()=>stalled}),{name:'TimeoutError'});
  assert.equal(stalled.terminated,1);
});
test('whole-job consumer accepts matching generation only and preserves measured graph', async () => {
  const worker=fakeWorker();
  const result=await runPerimeterJob(json([a(polygon(ring(-120,45,.1,.1))),b(polygon(ring(-119.98,45.02,.02,.02)))]),limits);
  const pending=groupPerimetersInWorker('[]',{signal:new AbortController().signal,generation:4,deadlineMs:1000,limits,createWorker:()=>worker});
  worker.onmessage({data:{operation:'group-perimeters',generation:3,ok:true,result}});assert.equal(worker.terminated,0);
  worker.onmessage({data:{operation:'group-perimeters',generation:4,ok:true,result}});
  assert.deepEqual(await pending,result);assert.equal(worker.terminated,1);
  const failed=fakeWorker();const failure=groupPerimetersInWorker('[]',{signal:new AbortController().signal,generation:5,deadlineMs:1000,limits,createWorker:()=>failed});
  let prevented=false;failed.onerror({preventDefault(){prevented=true;}});
  await assert.rejects(failure,/failed/);assert.equal(prevented,true);assert.equal(failed.terminated,1);
});
