import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {writeArrayBuffer} from 'geotiff';
import {buildRasterDemTileStore,decodeTerrariumTile} from '../scripts/lib/raster-dem-to-pmtiles.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const limits={workers:2,jobTimeoutMs:10000,maxJobs:10,maxSourcesPerTile:1,maxSourceBytes:1048576,
  sourceReadBufferBytes:16384,maxSourcePixels:100,maxTileBytes:65536,maxReceiptBytes:4096};
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'ddm-local-terrain-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'source.tif');
  const bytes=Buffer.from(writeArrayBuffer(new Uint16Array([100,100,200,200,100,100,200,200]),{
    width:4,height:2,BitsPerSample:[16],SampleFormat:[1],GTModelTypeGeoKey:2,GeographicTypeGeoKey:4326,
    ModelPixelScale:[90,90,0],ModelTiepoint:[0,0,0,-180,90,0]
  }));
  await writeFile(path,bytes);
  const sources=[{path,sha256:sha(bytes)}];
  const jobs=[{z:0,x:0,y:0,kind:'ocean',sources:[]},
    {z:1,x:0,y:0,kind:'land',sources},{z:1,x:1,y:0,kind:'land',sources}];
  return {dir,path,bytes,options:{storePath:join(dir,'store'),jobs,recipe:'synthetic degree-window floor-ceil bilinear v1',limits}};
}
test('native workers render distinct local windows plus explicit ocean and resume verified receipts',async t=>{
  const {options}=await setup(t);
  const first=await buildRasterDemTileStore(options);
  assert.equal(first.rendered,3);assert.equal(first.reused,0);assert.equal(first.workers,2);
  assert.deepEqual(first.plannedTileIds,[0,1,4]);
  for(let i=0;i<first.records.length;i++){
    const row=first.records[i],bytes=await readFile(row.path);
    assert.equal(sha(bytes),row.sha256);
    const decoded=decodeTerrariumTile(bytes);
    assert.equal(decoded.png.width,512);assert.equal(decoded.png.height,512);
    assert.equal(decoded.elevationAtIndex(256*512+256),[0,100,200][i]);
  }
  const second=await buildRasterDemTileStore(options);
  assert.equal(second.rendered,0);assert.equal(second.reused,3);assert.equal(second.workers,0);
  assert.deepEqual(second.records,first.records);
  assert.equal(existsSync(join(options.storePath,'.writer.lock')),false);
});
test('source receipt drift and changed recipe are refused rather than reused or rendered as ocean',async t=>{
  const {path,bytes,options}=await setup(t);
  await buildRasterDemTileStore(options);
  await assert.rejects(buildRasterDemTileStore({...options,recipe:'different method'}),/recipe mismatch/);
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;await writeFile(path,changed);
  await assert.rejects(buildRasterDemTileStore(options),/source receipt mismatch/);
  assert.equal(existsSync(join(options.storePath,'.writer.lock')),false);
});
test('corrupt or incomplete saved tile is refused and existing payload preserved',async t=>{
  const {options}=await setup(t);
  const first=await buildRasterDemTileStore(options);
  const target=first.records[0].path;await writeFile(target,'corrupt');
  await assert.rejects(buildRasterDemTileStore(options),/recipe mismatch|SHA mismatch/);
  assert.equal((await readFile(target)).toString(),'corrupt');
  await rm(target+'.json');
  await assert.rejects(buildRasterDemTileStore(options),/Incomplete existing/);
});
test('actual worker source/decode limits fail without completed tile receipts',async t=>{
  const {options}=await setup(t);
  const selected={...options,jobs:[options.jobs[1]],limits:{...limits,maxSourcePixels:1}};
  await assert.rejects(buildRasterDemTileStore(selected),/source pixel allowance/);
  assert.deepEqual(await readdir(options.storePath),[]);
});
test('worker failure and unexpected exit release pool lock without tile publication',async t=>{
  const {dir,options}=await setup(t);
  for(const [name,body]of [
    ['failure',"import{parentPort}from'node:worker_threads';parentPort.on('message',({id})=>parentPort.postMessage({id,type:'error',error:'fixture worker failure'}));"],
    ['exit',"import{parentPort}from'node:worker_threads';parentPort.on('message',()=>process.exit(3));"]
  ]){
    const path=join(dir,name+'.mjs');await writeFile(path,body);
    const storePath=join(dir,name+'-store');
    await assert.rejects(buildRasterDemTileStore({...options,storePath,jobs:[options.jobs[0]],workerUrl:pathToFileURL(path)}),/fixture worker failure|worker exited/);
    assert.deepEqual(await readdir(storePath),[]);
  }
});
test('native busy worker deadline and owner abort terminate started work before returning', {timeout:15000},async t=>{
  const {dir,options}=await setup(t),path=join(dir,'busy.mjs'),marker=join(dir,'started');
  await writeFile(path,"import{parentPort}from'node:worker_threads';import{writeFileSync}from'node:fs';parentPort.on('message',({id})=>{writeFileSync(new URL('./started',import.meta.url),'started');parentPort.postMessage({id,type:'started'});for(;;){};});");
  const common={...options,jobs:[options.jobs[0]],workerUrl:pathToFileURL(path)};
  await assert.rejects(buildRasterDemTileStore({...common,limits:{...limits,jobTimeoutMs:1500}}),error=>/deadline/.test(error.message)&&error.workerStarted===true);
  assert.equal(existsSync(marker),true);assert.deepEqual(await readdir(options.storePath),[]);
  await rm(marker);
  const owner=new AbortController(),reason=new Error('owner cancelled after native start');
  const watch=setInterval(()=>{if(existsSync(marker))owner.abort(reason);},5);
  try{await assert.rejects(buildRasterDemTileStore({...common,signal:owner.signal}),error=>error===reason);}
  finally{clearInterval(watch);}
  assert.deepEqual(await readdir(options.storePath),[]);
});
test('explicit limits/plan and exclusive store ownership reject before work',async t=>{
  const {options}=await setup(t);
  await assert.rejects(buildRasterDemTileStore({...options,limits:{...limits,workers:0}}),/allowance/);
  await assert.rejects(buildRasterDemTileStore({...options,jobs:[options.jobs[1],options.jobs[1]]}),/strictly/);
  await assert.rejects(buildRasterDemTileStore({...options,jobs:[{...options.jobs[0],kind:'land'}]}),/source plan/);
  await buildRasterDemTileStore(options);
  const lock=join(options.storePath,'.writer.lock');await writeFile(lock,'existing owner');
  await assert.rejects(buildRasterDemTileStore(options),/EEXIST/);
  assert.equal((await readFile(lock)).toString(),'existing owner');
});
