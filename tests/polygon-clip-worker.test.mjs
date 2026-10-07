import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
    existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL)))) return nextResolve(specifier+'.ts',context);
  return nextResolve(specifier,context);
}});
const {intersectPolygons}=await import('../src/util/polygon-clip.ts');
const {clipPolygonPair}=await import('../src/util/polygon-clip-client.ts');
const {PolygonClipError}=await import('../src/util/polygon-clip-contract.ts');
const limits={input:{maxVertices:100,maxSegmentTests:1000},output:{maxVertices:100,maxSegmentTests:1000}};
const box=(a,b,c,d)=>({type:'Polygon',coordinates:[[[a,b],[c,b],[c,d],[a,d],[a,b]]]});
const area=m=>m.reduce((sum,p)=>sum+p.reduce((subtotal,r,i)=>{
  const a=Math.abs(r.slice(1).reduce((s,q,j)=>s+r[j][0]*q[1]-q[0]*r[j][1],0))/2;
  return subtotal+(i===0?a:-a);
},0),0);
const code=expected=>error=>error instanceof PolygonClipError && error.code===expected;

test('actual package wrapper: disjoint, point and edge contacts are empty',()=>{
  for(const b of [box(3,3,4,4),box(2,2,3,3),box(2,0,3,2)])
    assert.deepEqual(intersectPolygons(box(0,0,2,2),b,limits),[]);
});
test('actual package wrapper: containment, partial overlap and holes keep known geometry',()=>{
  assert.equal(area(intersectPolygons(box(0,0,4,4),box(1,1,3,3),limits)),4);
  assert.equal(area(intersectPolygons(box(0,0,4,4),box(3,1,5,3),limits)),2);
  const donut=box(0,0,4,4); donut.coordinates.push(box(1,1,3,3).coordinates[0]);
  assert.deepEqual(intersectPolygons(donut,box(1.2,1.2,2.8,2.8),limits),[]);
  const result=intersectPolygons(donut,box(-1,-1,5,5),limits);
  assert.equal(area(result),12); assert.equal(result[0].length,2);
});
test('invalid bow-tie never reaches vendor; valid control reaches it',()=>{
  let calls=0; const operation=()=>{calls++;return [];};
  assert.throws(()=>intersectPolygons({type:'Polygon',coordinates:[[[0,0],[2,2],[0,2],[2,0],[0,0]]]},box(-1,-1,3,3),limits,operation),code('invalid-input'));
  assert.equal(calls,0);
  assert.deepEqual(intersectPolygons(box(0,0,1,1),box(2,2,3,3),limits,operation),[]);
  assert.equal(calls,1);
});
test('throwing engine, malformed output, bow-tie output and output cap remain failures',()=>{
  const a=box(0,0,1,1);
  assert.throws(()=>intersectPolygons(a,a,limits,()=>{throw Error('vendor');}),code('operation-failed'));
  for(const value of [null,{},[[[[0,0],[2,2],[0,2],[2,0],[0,0]]]]])
    assert.throws(()=>intersectPolygons(a,a,limits,()=>value),code('invalid-output'));
  assert.throws(()=>intersectPolygons(a,a,{...limits,output:{...limits.output,maxVertices:4}},()=>[a.coordinates]),code('invalid-output'));
});
function fake(){
  return {onmessage:null,onerror:null,onmessageerror:null,terminations:0,request:null,
    postMessage(request){this.request=request;},terminate(){this.terminations++;}};
}
function start(worker,extra={}){
  return clipPolygonPair(box(0,0,1,1),box(0,0,1,1),{signal:new AbortController().signal,
    generation:7,deadlineMs:1000,limits,createWorker:()=>worker,...extra});
}
test('bridge success terminates once; stale generation cannot settle current job',async()=>{
  const w=fake(); const p=start(w);
  w.onmessage({data:{generation:6,ok:true,coordinates:[]}});
  assert.equal(w.terminations,0);
  w.onmessage({data:{generation:7,ok:true,coordinates:[box(0,0,1,1).coordinates]}});
  assert.equal(area(await p),1); assert.equal(w.terminations,1); assert.equal(w.onmessage,null);
});
test('bridge accepts actual empty result, never converts typed refusal to empty',async()=>{
  const w=fake(); const p=start(w); w.onmessage({data:{generation:7,ok:true,coordinates:[]}});
  assert.deepEqual(await p,[]);
  const bad=fake(); const rejected=start(bad); bad.onmessage({data:{generation:7,ok:false,code:'invalid-output',reason:'invalid-geometry'}});
  await assert.rejects(rejected,code('invalid-output')); assert.equal(bad.terminations,1);
});
test('pre-abort and oversized input never construct worker',async()=>{
  let calls=0; const controller=new AbortController(); controller.abort();
  await assert.rejects(start(fake(),{signal:controller.signal,createWorker:()=>{calls++;return fake();}}),{name:'AbortError'});
  await assert.rejects(start(fake(),{limits:{...limits,input:{...limits.input,maxVertices:4}},createWorker:()=>{calls++;return fake();}}),code('invalid-input'));
  assert.equal(calls,0);
});
test('abort terminates and suppresses a captured late success callback',async()=>{
  const w=fake(); const owner=new AbortController(); const p=start(w,{signal:owner.signal});
  const late=w.onmessage; owner.abort();
  late({data:{generation:7,ok:true,coordinates:[]}});
  await assert.rejects(p,{name:'AbortError'}); assert.equal(w.terminations,1);
});
test('silent worker deadline terminates and rejects rather than reporting empty',async()=>{
  const w=fake();
  await assert.rejects(start(w,{deadlineMs:20}),code('deadline'));
  assert.equal(w.terminations,1); assert.equal(w.onmessage,null);
});
test('worker errors, message errors, malformed and oversized replies fail and terminate',async()=>{
  for(const event of ['onerror','onmessageerror']){
    const w=fake();const p=start(w);w[event]({preventDefault(){}});
    await assert.rejects(p,code('operation-failed')); assert.equal(w.terminations,1);
  }
  for(const data of [null,{generation:7,ok:true,coordinates:null},{generation:7,ok:false,code:'invented',reason:'bad'}]){
    const w=fake();const p=start(w);w.onmessage({data});
    await assert.rejects(p,code('operation-failed')); assert.equal(w.terminations,1);
  }
  const w=fake();const p=start(w,{limits:{...limits,output:{...limits.output,maxVertices:4}}});
  w.onmessage({data:{generation:7,ok:true,coordinates:[box(0,0,1,1).coordinates]}});
  await assert.rejects(p,code('invalid-output'));assert.equal(w.terminations,1);
});
test('construction and postMessage failures settle without orphaning a worker',async()=>{
  await assert.rejects(start(fake(),{createWorker:()=>{throw Error('construct');}}),code('operation-failed'));
  const w=fake();w.postMessage=()=>{throw Error('clone');};
  await assert.rejects(start(w),code('operation-failed'));assert.equal(w.terminations,1);
});

test('actual wrapper refuses vendor input collapse at zero and at BC longitude',()=>{
  const examples=[box(0,0,1e-200,1e-200),box(0,0,Number.MIN_VALUE,Number.MIN_VALUE),
    box(-120,49,-120+2**-46,49.1)];
  for(const input of examples) for(const reverse of [false,true]){
    const a=structuredClone(input);if(reverse)a.coordinates[0].reverse();
    assert.throws(()=>intersectPolygons(a,a,limits),error=>code('invalid-input')(error) && error.reason==='numerical-uncertainty');
  }
  assert.equal(area(intersectPolygons(box(-120,49,-119.999,49.001),box(-120,49,-119.999,49.001),limits))>0,true);
});
test('empty vendor answer cannot hide positive overlap or ambiguous contact',()=>{
  const a=box(0,0,4,4);const b=box(1,1,3,3);
  const multi={type:'MultiPolygon',coordinates:[box(20,20,21,21).coordinates,a.coordinates]};
  for(const [left,right] of [[a,b],[b,a],[a,a],[box(0,1,4,2),box(1,0,2,4)],[multi,b],[b,multi]])
    assert.throws(()=>intersectPolygons(left,right,limits,()=>[]),error=>code('invalid-output')(error) && error.reason==='numerical-uncertainty');
  const donut=box(0,0,10,10);donut.coordinates.push(box(2,2,8,8).coordinates[0]);
  const island={type:'MultiPolygon',coordinates:[donut.coordinates,box(3,3,4,4).coordinates]};
  const hole=box(2,2,8,8);
  for(const [left,right] of [[island,hole],[hole,island]]){
    assert.throws(()=>intersectPolygons(left,right,limits,()=>[]),error=>code('invalid-output')(error) && error.reason==='numerical-uncertainty');
    assert.equal(area(intersectPolygons(left,right,limits)),1);
  }
});
test('empty certification has a causal operation cap and never converts exhaustion to empty',()=>{
  const a=box(0,0,4,4);const b=box(1,1,3,3);
  assert.throws(()=>intersectPolygons(a,b,{...limits,input:{...limits.input,maxSegmentTests:2}},()=>[]),
    error=>code('invalid-output')(error) && error.reason==='validation-limit');
});
test('actual shared-edge, point, hole-empty and overlap controls survive operand/winding reversal',()=>{
  const a=box(0,0,4,4);const donut=box(0,0,4,4);donut.coordinates.push(box(1,1,3,3).coordinates[0]);
  for(const [left,right,expected] of [[a,box(4,0,5,4),0],[a,box(4,4,5,5),0],
    [donut,box(1.2,1.2,2.8,2.8),0],[donut,box(1,1,3,3),0],[a,box(3,1,5,3),2]]){
    for(const [p,q] of [[left,right],[right,left]]) for(const reverse of [false,true]){
      const first=structuredClone(p);const second=structuredClone(q);
      if(reverse){first.coordinates.forEach(r=>r.reverse());second.coordinates.forEach(r=>r.reverse());}
      const result=intersectPolygons(first,second,limits);
      if(expected===0)assert.deepEqual(result,[]);else assert.equal(area(result),expected);
    }
  }
});
