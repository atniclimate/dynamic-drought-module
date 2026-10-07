import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePolygonForClip, PolygonClipValidationError } from '../src/util/polygon-clip-validation.ts';

const limits={maxVertices:1000,maxSegmentTests:10000}; // Synthetic test allowances only.
const ring=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
const polygon=(...rings)=>({type:'Polygon',coordinates:rings});
const fails=(geometry,code='invalid-geometry',budget=limits)=>assert.throws(
  ()=>validatePolygonForClip(geometry,budget),
  error=>error instanceof PolygonClipValidationError && error.code===code);

test('valid simple polygon is copied unchanged, including reversed winding',()=>{
  for(const r of [ring(-124,48,-123,49),ring(-124,48,-123,49).reverse()]){
    const input=polygon(r); const original=structuredClone(input);
    const result=validatePolygonForClip(input,limits);
    assert.deepEqual(result,[original.coordinates]);
    result[0][0][0][0]=0;
    assert.deepEqual(input,original);
  }
});
test('bow-tie that vendor repairs is rejected; nearby simple quadrilateral is accepted',()=>{
  fails(polygon([[0,0],[2,2],[0,2],[2,0],[0,0]]));
  assert.equal(validatePolygonForClip(polygon(ring(0,0,2,2)),limits).length,1);
});
test('self-contact, zero area and adjacent backtracking are rejected',()=>{
  fails(polygon([[0,0],[2,0],[1,1],[2,2],[0,2],[1,1],[0,0]]));
  fails(polygon([[0,0],[1,0],[2,0],[0,0]]));
  fails(polygon([[0,0],[2,0],[1,0],[2,2],[0,2],[0,0]]));
});
test('strict hole is preserved; external, crossing, touching and nested holes fail',()=>{
  const outer=ring(0,0,10,10); const hole=ring(2,2,4,4);
  assert.deepEqual(validatePolygonForClip(polygon(outer,hole),limits),[[outer,hole]]);
  fails(polygon(outer,ring(12,2,14,4)));
  fails(polygon(outer,ring(9,2,11,4)));
  fails(polygon(outer,ring(0,2,2,4)));
  fails(polygon(outer,ring(2,2,8,8),ring(3,3,4,4)));
  fails(polygon(outer,ring(2,2,6,6),ring(4,4,8,8)));
});
test('disconnected components and an island in a hole survive; overlap/contact fail',()=>{
  const outer=ring(0,0,10,10); const hole=ring(2,2,8,8); const island=ring(3,3,4,4);
  const input={type:'MultiPolygon',coordinates:[[outer,hole],[island],[ring(12,0,13,1)]]};
  assert.deepEqual(validatePolygonForClip(input,limits),input.coordinates);
  fails({type:'MultiPolygon',coordinates:[[ring(0,0,2,2)],[ring(1,1,3,3)]]});
  fails({type:'MultiPolygon',coordinates:[[ring(0,0,2,2)],[ring(2,2,3,3)]]});
});
test('exact finite binary64 topology retains extremely thin nonzero geometry',()=>{
  for (const side of [1e-200,Number.MIN_VALUE]) {
    const r=ring(0,0,side,side);
    for (const points of [r,[...r].reverse()]) {
      const thin=polygon(points);
      assert.equal(side*side,0); // An ordinary double cross product loses this area.
      assert.deepEqual(validatePolygonForClip(thin,limits),[thin.coordinates]);
    }
  }
  fails(polygon([[0,0],[1,0],[1,0],[0,0],[0,0]]));
});
test('unclosed, duplicate, nonfinite, non-WGS84, wrapped and 3D inputs fail explicitly',()=>{
  fails(polygon([[0,0],[1,0],[1,1],[0,1]]));
  fails(polygon([[0,0],[1,0],[1,0],[1,1],[0,0]]));
  fails(polygon([[0,0],[NaN,0],[1,1],[0,0]]));
  fails(polygon(ring(181,0,182,1)));
  fails(polygon(ring(0,91,1,92)));
  fails(polygon(ring(-179,0,179,1)));
  fails(polygon([[0,0,0],[1,0,0],[1,1,0],[0,0,0]]));
  fails({type:'LineString',coordinates:[[0,0],[1,1]]});
  fails({type:'MultiPolygon',coordinates:[]});
});
test('closing coordinates count toward vertex bound, not just retained distinct positions',()=>{
  const input=polygon(ring(0,0,1,1));
  fails(input,'validation-limit',{...limits,maxVertices:4});
  assert.equal(validatePolygonForClip(input,{...limits,maxVertices:5}).length,1);
});
test('topology allowance is causal: same valid ring fails at one check and passes at two',()=>{
  const input=polygon(ring(0,0,1,1));
  fails(input,'validation-limit',{...limits,maxSegmentTests:1});
  assert.equal(validatePolygonForClip(input,{...limits,maxSegmentTests:2}).length,1);
});
test('limits must be supplied as positive safe integers',()=>{
  for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>validatePolygonForClip(polygon(ring(0,0,1,1)),{...limits,maxVertices:value}),RangeError);
    assert.throws(()=>validatePolygonForClip(polygon(ring(0,0,1,1)),{...limits,maxSegmentTests:value}),RangeError);
  }
});
