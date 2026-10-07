import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CPC_SEASONAL_CLASSES, CPC_RENDERER_COLORS, CPC_OUTLINE, cpcSeasonalPolygons, cpcSeasonalBody } from './cpc-seasonal-polygon-fixtures.mjs';
// Same Node type-stripping/extension resolution seam as existing pure tests.
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.endsWith('.ts')&&
    existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL)))) return nextResolve(specifier+'.ts',context);
  return nextResolve(specifier,context);
}});
const {parseArcGisPolygonFeatureCollection:parse}=await import('../src/config/wildfire-presentation.ts');
const read=value=>parse(value,'CPC seasonal fixture');
test('synthetic 17-class Polygon/MultiPolygon payload preserves raw values and issuer clocks',()=>{
  const body=cpcSeasonalPolygons();
  const result=read(body);
  assert.equal(result.truncated,false);
  assert.equal(result.collection.features.length,17);
  assert.equal(new Set(CPC_SEASONAL_CLASSES.map(row=>row.label)).size,17);
  assert.deepEqual(result.collection,body);
  assert.deepEqual(new Set(result.collection.features.map(f=>f.geometry.type)),new Set(['Polygon','MultiPolygon']));
  assert.equal(result.collection.features[16].properties.cat,'EC');
  assert.deepEqual(CPC_OUTLINE,{color:[110,110,110,255],width:1});
  for(const kind of ['precip','temp']) {
    assert.equal(CPC_RENDERER_COLORS[kind].length,17);
    assert.equal(CPC_RENDERER_COLORS[kind][16][3],0);
    assert.ok(CPC_RENDERER_COLORS[kind].slice(0,16).every(color=>color[3]===255));
  }
  // Transparent EC is still a geometry feature, not dropped as empty data.
  assert.equal(read({type:'FeatureCollection',features:[body.features[16]]}).collection.features.length,1);
});
test('valid empty and transfer-limited collections remain distinguishable',()=>{
  assert.deepEqual(read(cpcSeasonalBody('emptyCollection')),{collection:{type:'FeatureCollection',features:[]},truncated:false});
  assert.equal(read(cpcSeasonalBody('partial')).truncated,true);
  const partial=read(cpcSeasonalBody('partialEmpty'));
  assert.equal(partial.truncated,true);
  assert.equal(partial.collection.features.length,0);
  assert.equal(read({...cpcSeasonalPolygons(),exceededTransferLimit:false}).truncated,false);
  assert.throws(()=>read({...cpcSeasonalPolygons(),exceededTransferLimit:'true'}));
});
for(const arm of ['emptyObject','noFeatures','arcgisError','lbEnvelope','attributeOnly'])
  test(`rejects ${arm} rather than claiming zero polygons`,()=>assert.throws(()=>read(cpcSeasonalBody(arm))));
for(const [name,body] of [['emptyBody',''],['truncatedJson','{"type":"FeatureCollection","features":['],['htmlAt200','<html>failure</html>']])
  test(`JSON boundary rejects ${name}`,()=>assert.throws(()=>read(JSON.parse(body))));
for(const geometry of [null,{type:'Point',coordinates:[-120,40]},
  {type:'Polygon',coordinates:[]},{type:'MultiPolygon',coordinates:[]},
  {type:'Polygon',coordinates:[[[-120,40],[-119,40],[-119,41],[-120,41]]]},
  {type:'Polygon',coordinates:[[[-120,40],[-119,40],[NaN,41],[-120,40]]]}])
  test(`rejects invalid geometry ${JSON.stringify(geometry)}`,()=>{
    const body=cpcSeasonalPolygons();body.features[0].geometry=geometry;
    assert.throws(()=>read(body));
  });
test('one malformed member cannot silently become a partial successful collection',()=>{
  const body=cpcSeasonalPolygons();body.features[16].geometry=null;
  assert.throws(()=>read({...body,exceededTransferLimit:true}));
});
test('unknown category stays unknown through generic parsing',()=>{
  const body=cpcSeasonalPolygons();body.features[0].properties.cat='future-issuer-category';
  assert.equal(read(body).collection.features[0].properties.cat,'future-issuer-category');
});
