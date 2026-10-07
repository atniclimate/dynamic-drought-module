import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeArrayBuffer} from 'geotiff';
import {openLocalDem,readDemWindow} from '../scripts/lib/raster-dem-to-pmtiles.mjs';

test('two geographic windows of one local GeoTIFF read distinct source elevations',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ddm-terrain-window-'));
  let source;
  try{
    const path=join(directory,'gradient.tif');
    const values=new Uint16Array([10,11,20,21,12,13,22,23]);
    await writeFile(path,Buffer.from(writeArrayBuffer(values,{
      width:4,height:2,BitsPerSample:[16],SampleFormat:[1],
      ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,-120,48,0],GTModelTypeGeoKey:2,GeographicTypeGeoKey:4326
    })));
    source=await openLocalDem(path);
    const west=await readDemWindow(source.image,{bbox:[-120,46,-118,48],width:2,height:2});
    const east=await readDemWindow(source.image,{bbox:[-118,46,-116,48],width:2,height:2});
    assert.deepEqual([...west[0]],[10,11,12,13]);
    assert.deepEqual([...east[0]],[20,21,22,23]);
    await assert.rejects(readDemWindow(source.image,{bbox:[-130,46,-125,48],width:2,height:2}),/outside/);
    await assert.rejects(readDemWindow(source.image,{bbox:[-121,46,-118,48],width:3,height:2}),/caller must intersect/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(readDemWindow(source.image,{bbox:[-120,46,-118,48],width:2,height:2,signal:controller.signal}),{name:'AbortError'});
  }finally{await source?.close();await rm(directory,{recursive:true,force:true});}
});

test('window conversion rejects rotated or reversed axes instead of inventing geography',async()=>{
  const image={getOrigin:()=>[0,0,0],getResolution:()=>[1,1,0],getWidth:()=>4,getHeight:()=>2,
    readRasters(){assert.fail('invalid source reached raster read');}};
  await assert.rejects(readDemWindow(image,{bbox:[0,0,2,2],width:2,height:2}),/north-up/);
  const rotated={...image,getResolution:()=>[1,-1,0],getFileDirectory:()=>({getValue:()=>[1,0.1,0,0,0.1,-1,0,2,0,0,1,0,0,0,0,1]})};
  await assert.rejects(readDemWindow(rotated,{bbox:[0,0,2,2],width:2,height:2}),/north-up/);
});

test('local DEM accepts declared NAD83 geographic and refuses projected or unsupported CRS',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ddm-terrain-crs-'));
  try {
    for(const [name,keys,accepted]of [
      ['nad83',{GTModelTypeGeoKey:2,GeographicTypeGeoKey:4269},true],
      ['projected',{GTModelTypeGeoKey:1,GeographicTypeGeoKey:4269,ProjectedCSTypeGeoKey:26910},false],
      ['unsupported',{GTModelTypeGeoKey:2,GeographicTypeGeoKey:4322},false]
    ]){
      const path=join(directory,name+'.tif');
      await writeFile(path,Buffer.from(writeArrayBuffer(new Uint16Array([10,11,12,13]),{
        width:2,height:2,BitsPerSample:[16],SampleFormat:[1],ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,-120,48,0],...keys
      })));
      if(accepted){const source=await openLocalDem(path);await source.close();}
      else await assert.rejects(openLocalDem(path),/supported geographic GeoKeys/);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
