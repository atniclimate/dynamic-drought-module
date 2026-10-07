import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){
  if(context.parentURL?.includes('/src/util/perimeter-measures.ts') && specifier==='./polygon-clip-validation')
    return next('./polygon-clip-validation.ts',context);
  return next(specifier,context);
}});
const {measurePerimeterGeometry,PerimeterMeasurementError}=await import('../src/util/perimeter-measures.ts');
const limits={maxVertices:1000,maxSegmentTests:10000};
const ring=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
const polygon=(...rings)=>({type:'Polygon',coordinates:rings});
const rad=Math.PI/180;
const radius=6371008.8;
// Analytic spherical latitude-strip rectangle, independent of the ring loop.
const rectangleArea=(w,s,e,n)=>radius**2*(e-w)*rad*2*Math.cos((n+s)*rad/2)*Math.sin((n-s)*rad/2);
const near=(a,b,relative=1e-12)=>assert.ok(Math.abs(a-b)<=Math.abs(b)*relative,`${a} != ${b}`);

test('equatorial rectangle matches analytic sphere area and independently specified edge lengths',()=>{
  const input=polygon(ring(0,0,1,1));const before=structuredClone(input);
  const result=measurePerimeterGeometry(input,limits);
  near(result.areaM2,rectangleArea(0,0,1,1));
  // Two meridians, one equatorial edge, one latitude-1 great-circle chord.
  const top=radius*Math.acos(Math.sin(rad)**2+Math.cos(rad)**2*Math.cos(rad));
  near(result.components[0].perimeterM,3*radius*rad+top,1e-10);
  assert.deepEqual(input,before);
});
test('BC-sized rectangle is invariant under winding, ring start and longitude translation',()=>{
  const original=ring(-120,49,-119.99,49.01);
  const first=measurePerimeterGeometry(polygon(original),limits);
  near(first.areaM2,rectangleArea(-120,49,-119.99,49.01));
  for(const reverse of [false,true])for(let start=0;start<4;start++){
    let points=original.slice(0,-1);if(reverse)points.reverse();
    points=points.slice(start).concat(points.slice(0,start));points.push(points[0]);
    assert.deepEqual(measurePerimeterGeometry(polygon(points),limits),first);
  }
  const translated=original.map(([x,y])=>[x+120,y]);
  assert.deepEqual(measurePerimeterGeometry(polygon(translated),limits),first);
});
test('holes subtract area but add boundary length; disconnected components remain separate',()=>{
  const outer=ring(-120,49,-119.9,49.1),hole=ring(-119.98,49.02,-119.96,49.04);
  const a=measurePerimeterGeometry(polygon(outer),limits);
  const h=measurePerimeterGeometry(polygon(hole),limits);
  const donut=measurePerimeterGeometry(polygon(outer,hole),limits);
  near(donut.areaM2,a.areaM2-h.areaM2);
  near(donut.components[0].perimeterM,a.components[0].perimeterM+h.components[0].perimeterM);
  const island=ring(-119.975,49.025,-119.965,49.035);
  const i=measurePerimeterGeometry(polygon(island),limits);
  const multi=measurePerimeterGeometry({type:'MultiPolygon',coordinates:[[outer,hole],[island]]},limits);
  assert.equal(multi.components.length,2);
  near(multi.areaM2,donut.areaM2+i.areaM2);
  assert.deepEqual(multi.components[0],donut.components[0]);
  assert.deepEqual(multi.components[1],i.components[0]);
});
test('strict topology and caller caps are enforced, never measured as empty',()=>{
  assert.throws(()=>measurePerimeterGeometry(polygon([[0,0],[2,2],[0,2],[2,0],[0,0]]),limits));
  assert.throws(()=>measurePerimeterGeometry(polygon(ring(179,0,-179,1)),limits));
  assert.throws(()=>measurePerimeterGeometry(polygon(ring(0,0,1,1)),{...limits,maxVertices:4}));
  assert.throws(()=>measurePerimeterGeometry({type:'MultiPolygon',coordinates:[]},limits));
});
test('a tiny valid planar polygon whose spherical area underflows is undetermined',()=>{
  assert.throws(()=>measurePerimeterGeometry(polygon(ring(0,0,1e-200,1e-200)),limits),
    error=>error instanceof PerimeterMeasurementError);
  const small=measurePerimeterGeometry(polygon(ring(-120,49,-119.999999,49.000001)),limits);
  assert.ok(small.areaM2>0 && small.areaM2<1);
  near(small.areaM2,rectangleArea(-120,49,-119.999999,49.000001));
});

test('concave L and triangular rings match independent closed-form model areas',()=>{
  const l=polygon([[-120,49],[-119.8,49],[-119.8,49.1],[-119.9,49.1],[-119.9,49.2],[-120,49.2],[-120,49]]);
  near(measurePerimeterGeometry(l,limits).areaM2,
    rectangleArea(-120,49,-119.9,49.2)+rectangleArea(-119.9,49,-119.8,49.1));
  const triangle=polygon([[-120,49],[-119.8,49],[-120,49.2],[-120,49]]);
  // Half a strip under the adopted longitude/sine model, not exact spherical excess.
  near(measurePerimeterGeometry(triangle,limits).areaM2,rectangleArea(-120,49,-119.8,49.2)/2);
});

test('two holes have independently specified area/boundary length and order-invariant totals',()=>{
  const bounds=[[-120,49,-119,50],[-119.9,49.1,-119.7,49.3],[-119.4,49.6,-119.2,49.8]];
  const rings=bounds.map(b=>ring(...b));
  const arc=(latitude,span)=>radius*Math.acos(Math.sin(latitude*rad)**2+Math.cos(latitude*rad)**2*Math.cos(span*rad));
  const rectangleBoundary=([w,s,e,n])=>2*radius*(n-s)*rad+arc(s,e-w)+arc(n,e-w);
  const expectedArea=rectangleArea(...bounds[0])-rectangleArea(...bounds[1])-rectangleArea(...bounds[2]);
  const expectedBoundary=bounds.reduce((total,b)=>total+rectangleBoundary(b),0);
  const first=measurePerimeterGeometry(polygon(...rings),limits);
  near(first.areaM2,expectedArea);
  near(first.components[0].perimeterM,expectedBoundary,1e-9);
  const rotate=r=>[r[2],r[3],r[0],r[1],r[2]];
  assert.deepEqual(measurePerimeterGeometry(polygon(rings[0].toReversed(),rotate(rings[2]),rings[1].toReversed()),limits),first);
  const island=[ring(-119.85,49.15,-119.75,49.25)];
  const multi={type:'MultiPolygon',coordinates:[rings,island]};
  const result=measurePerimeterGeometry(multi,limits);
  const swapped=measurePerimeterGeometry({...multi,coordinates:[island,rings]},limits);
  assert.equal(result.areaM2,swapped.areaM2);
  assert.deepEqual(result.components,swapped.components.toReversed());
});
