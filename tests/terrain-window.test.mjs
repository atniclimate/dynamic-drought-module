import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeArrayBuffer} from 'geotiff';
import {PNG} from 'pngjs';
import {openLocalDem,readDemWindow,terrariumPng,decodeTerrariumTile,renderLocalDemTile} from '../scripts/lib/raster-dem-to-pmtiles.mjs';

test('frozen Terrarium encoder: one deflate strategy 0 Up-filter encode, lossless to whole metres',()=>{
  const size=16,values=new Float32Array(size*size);
  const fixed=[-85,0,6147,NaN,Infinity,-Infinity,-84.6,6146.5,183.2,-0.4,4387.1];
  for(let i=0;i<values.length;i++)values[i]=i<fixed.length?fixed[i]:((i*37)%3000)-80;
  const {data}=terrariumPng(values,size,size);
  const decoded=decodeTerrariumTile(data);
  for(let i=0;i<values.length;i++){
    const want=Number.isFinite(values[i])?Math.round(values[i]):0;
    assert.equal(decoded.elevationAtIndex(i),want===0?0:want,'pixel '+i);
  }
  // The recipe is the exact byte stream of this single encode (receipt key freeze).
  const png=new PNG({width:size,height:size});png.data.set(decoded.png.data);
  const frozen=PNG.sync.write(png,{colorType:6,inputColorType:6,deflateLevel:9,deflateStrategy:0,filterType:2});
  assert.deepEqual(Buffer.from(data),frozen);
});

test('land tiles sample the source bilinearly at each Web Mercator pixel centre',async()=>{
  // A field linear in lon and lat is reproduced exactly by bilinear sampling at the right place, so any
  // half-pixel or linear-latitude misplacement shows as metres (the pilot's Mount Jefferson regression).
  const directory=await mkdtemp(join(tmpdir(),'ddm-terrain-mercator-'));
  try{
    const n=360,values=new Float32Array(n*n),field=(lon,lat)=>-10000+20000*(lon+122)+30000*(45-lat);
    for(let j=0;j<n;j++)for(let i=0;i<n;i++)values[j*n+i]=field(-122+(i+0.5)/n,45-(j+0.5)/n);
    const path=join(directory,'linear.tif');
    await writeFile(path,Buffer.from(writeArrayBuffer(values,{width:n,height:n,BitsPerSample:[32],SampleFormat:[3],
      ModelPixelScale:[1/n,1/n,0],ModelTiepoint:[0,0,0,-122,45,0],GTModelTypeGeoKey:2,GeographicTypeGeoKey:4269})));
    const z=10,x=Math.floor((-121.5+180)/360*1024),y=Math.floor((1-Math.asinh(Math.tan(44.5*Math.PI/180))/Math.PI)/2*1024);
    const {data}=await renderLocalDemTile({z,x,y,kind:'land',sources:[{path}]},{maxSourcePixels:n*n,maxTileBytes:2e6});
    const tile=decodeTerrariumTile(data),world=1024*512;
    let checked=0,worst=0;
    for(let r=0;r<512;r+=7)for(let c=0;c<512;c+=7){
      const lon=(x*512+c+0.5)/world*360-180,lat=180/Math.PI*Math.atan(Math.sinh(Math.PI-2*Math.PI*(y*512+r+0.5)/world));
      if(lon<-122+1/n||lon>-121-1/n||lat<44+1/n||lat>45-1/n)continue;
      worst=Math.max(worst,Math.abs(tile.elevationAtIndex(r*512+c)-field(lon,lat)));checked++;
    }
    assert.ok(checked>1000,'checked '+checked);
    assert.ok(worst<=0.6,'worst pixel off by '+worst+' m');
  }finally{await rm(directory,{recursive:true,force:true});}
});

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

test('source no-data cells read as 0 m and are not blended into valid neighbours',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ddm-terrain-nodata-'));
  let source;
  try{
    const path=join(directory,'nodata.tif');
    await writeFile(path,Buffer.from(writeArrayBuffer(new Float32Array([10,11,-9999,21,12,13,22,23]),{
      width:4,height:2,BitsPerSample:[32],SampleFormat:[3],GDAL_NODATA:'-9999',
      ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,-120,48,0],GTModelTypeGeoKey:2,GeographicTypeGeoKey:4326
    })));
    source=await openLocalDem(path);
    const out=await readDemWindow(source.image,{bbox:[-120,46,-116,48],width:6,height:4,nodata:source.nodata});
    assert.equal(source.nodata,-9999);
    assert.equal(out[0][3],0);
    assert.ok(Math.min(...out[0])>=0,'no pixel below the 0 m no-data value');
  }finally{await source?.close();await rm(directory,{recursive:true,force:true});}
});

test('the pixel-centre sampler reads source no-data as 0 m before blending, so no tile pixel goes below 0',async()=>{
  // Blending -9999 into 1000 m neighbours would give negative pixels well above the -100000 floor.
  const directory=await mkdtemp(join(tmpdir(),'ddm-terrain-centre-nodata-'));
  try{
    const n=60,values=new Float32Array(n*n).fill(1000);
    for(let j=27;j<33;j++)for(let i=27;i<36;i++)values[j*n+i]=-9999;
    const path=join(directory,'nodata.tif');
    await writeFile(path,Buffer.from(writeArrayBuffer(values,{width:n,height:n,BitsPerSample:[32],SampleFormat:[3],GDAL_NODATA:'-9999',
      ModelPixelScale:[1/n,1/n,0],ModelTiepoint:[0,0,0,-122,45,0],GTModelTypeGeoKey:2,GeographicTypeGeoKey:4269})));
    const z=10,x=Math.floor((-121.5+180)/360*1024),y=Math.floor((1-Math.asinh(Math.tan(44.5*Math.PI/180))/Math.PI)/2*1024);
    const {data}=await renderLocalDemTile({z,x,y,kind:'land',sources:[{path}]},{maxSourcePixels:n*n,maxTileBytes:2e6});
    const tile=decodeTerrariumTile(data);
    let min=Infinity,zeros=0,full=0;
    for(let i=0;i<512*512;i++){const v=tile.elevationAtIndex(i);min=Math.min(min,v);if(v===0)zeros++;if(v===1000)full++;}
    assert.ok(min>=0,'lowest pixel '+min+' m');
    assert.ok(zeros>100&&full>100,'the no-data block reads 0 m inside 1000 m ground: '+zeros+' zero, '+full+' full');
  }finally{await rm(directory,{recursive:true,force:true});}
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
