import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { PMTiles, bytesToHeader, tileIdToZxy } from 'pmtiles';

// Execute the real writer, with a filesystem-boundary fault seam. Normally all
// calls delegate to real files. No writer source is copied or rewritten.
const control = { before: undefined, after: undefined, events: undefined };
globalThis[Symbol.for('ddm.stream-writer.fs-test')] = control;
const fsShim = 'data:text/javascript,' + encodeURIComponent(`
import * as fs from 'node:fs/promises';
const control=globalThis[Symbol.for('ddm.stream-writer.fs-test')];
async function invoke(op,path,action){
 control.events?.push([op,String(path)]);
 await control.before?.(op,String(path));
 const result=await action();
 await control.after?.(op,String(path));
 return result;
}
export const readFile=fs.readFile;
export const unlink=path=>invoke('unlink',path,()=>fs.unlink(path));
export async function open(path,...args){
 const handle=await fs.open(path,...args);
 return new Proxy(handle,{get(target,key){
  const value=Reflect.get(target,key);
  return typeof value==='function'?(...a)=>invoke(String(key),path,()=>value.apply(target,a)):value;
 }});
}
`);
const writerUrl = new URL('../scripts/lib/pmtiles-stream-writer.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:fs/promises' && context.parentURL === writerUrl) return {url:fsShim,shortCircuit:true};
  return next(specifier,context);
}});
const { writeTerrainPmtiles } = await import(writerUrl);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await access(path); return true; } catch(error) { if(error.code==='ENOENT')return false;throw error; } };
const metadata = {
  encoding:'terrarium',tile_size:512,attribution:'Synthetic test product, not elevation evidence',
  retrieved:'2026-10-07',modifications:'Synthetic byte transport fixture',missing_cells:[]
};
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'ddm-stream-writer-'));
  t.after(async()=>{control.before=undefined;control.after=undefined;control.events=undefined;await rm(dir,{recursive:true,force:true});});
  return dir;
}
const base = (dir,plannedTileIds) => ({
  outputPath:join(dir,'archive.pmtiles'),plannedTileIds,minZoom:0,maxZoom:11,
  bounds:[-180,-85,180,85],center:[0,0,0],metadata,
  maxTiles:20000,maxTileBytes:4096,copyBufferBytes:137
});
async function record(dir,tileId,bytes,name=String(tileId)) {
  const path=join(dir,name+'.bin');await writeFile(path,bytes);
  return {tileId,path,sha256:sha(bytes)};
}
function decodeDirectory(bytes){
  let p=0;
  function read(){let value=0,m=1;for(;;){assert.ok(p<bytes.length);const b=bytes[p++];value+=(b&127)*m;if(b<128)return value;m*=128;assert.ok(Number.isSafeInteger(m));}}
  const count=read(),rows=[];let id=0;
  for(let i=0;i<count;i++){id+=read();rows.push({tileId:id});}
  for(const row of rows)row.runLength=read();
  for(const row of rows)row.length=read();
  for(let i=0;i<count;i++){const v=read();rows[i].offset=v===0&&i>0?rows[i-1].offset+rows[i-1].length:v-1;}
  assert.equal(p,bytes.length);return rows;
}
function inspect(bytes){
  const header=bytesToHeader(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+127));
  const root=decodeDirectory(gunzipSync(bytes.subarray(header.rootDirectoryOffset,header.rootDirectoryOffset+header.rootDirectoryLength)));
  const leaves=root.filter(row=>row.runLength===0).map(row=>decodeDirectory(gunzipSync(bytes.subarray(header.leafDirectoryOffset+row.offset,header.leafDirectoryOffset+row.offset+row.length))));
  return {header,root,leaves};
}
function readerFor(bytes,key='fixture',ranges=[]){
  return new PMTiles({getKey:()=>key,getBytes:async(offset,length)=>{
    ranges.push({offset,length});const b=bytes.subarray(offset,offset+length);
    return {data:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
  }});
}
async function walk(reader,expected){
  for(const [id,bytes]of expected){const got=await reader.getZxy(...tileIdToZxy(id));
    assert.ok(got,'planned tile '+id+' resolves');assert.deepEqual(Buffer.from(got.data),bytes,'tile '+id+' bytes');}
}

test('over6060 planned ids, every leaf boundary and nonadjacent dedup resolve through actual pmtiles reader',async t=>{
  const dir=await setup(t);
  let state=0x549ead;
  const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const pool=[];
  // Payloads deliberately test container byte transport, not PNG/elevation validity.
  for(let i=0;i<512;i++){const bytes=Buffer.alloc(1+rand()%3000);for(let j=0;j<bytes.length;j++)bytes[j]=rand()%256;
    const r=await record(dir,0,bytes,'content-'+i);pool.push({...r,bytes});}
  const ocean=await record(dir,0,Buffer.alloc(32),'synthetic-ocean');
  const expected=new Map(),records=[];let id=0;
  for(let i=0;i<12000;i++){id+=1+rand()%64;const source=i%7===0?{...ocean,bytes:Buffer.alloc(32)}:pool[rand()%pool.length];
    records.push({tileId:id,path:source.path,sha256:source.sha256});expected.set(id,source.bytes);}
  const options=base(dir,[...expected.keys()]);
  const result=await writeTerrainPmtiles({...options,tiles:(async function*(){yield*records;})()});
  const bytes=await readFile(options.outputPath),{header,root,leaves}=inspect(bytes);
  assert.ok(records.length>6060);assert.ok(leaves.length>1,'heterogeneous fixture must really require leaves');
  assert.ok(127+header.rootDirectoryLength<=16384);
  assert.equal(header.rootDirectoryOffset,127);
  assert.equal(header.jsonMetadataOffset,127+header.rootDirectoryLength);
  assert.equal(header.leafDirectoryOffset,header.jsonMetadataOffset+header.jsonMetadataLength);
  assert.equal(header.tileDataOffset,header.leafDirectoryOffset+header.leafDirectoryLength);
  assert.equal(header.tileDataOffset+header.tileDataLength,bytes.length,'tile data last');
  assert.equal(header.clustered,true);assert.equal(header.tileType,2);
  assert.equal(header.internalCompression,2);assert.equal(header.tileCompression,1);
  assert.equal(header.numAddressedTiles,records.length);assert.equal(header.numTileEntries,records.length);
  const unique=new Map([...expected.values()].map(b=>[sha(b),b]));
  assert.equal(header.numTileContents,unique.size);
  assert.equal(header.tileDataLength,[...unique.values()].reduce((sum,b)=>sum+b.length,0));
  assert.equal(result.bytes,bytes.length);assert.equal(result.headerHex,bytes.subarray(0,127).toString('hex'));
  assert.equal(result.addressedTiles,records.length);assert.equal(result.tileContents,unique.size);
  assert.equal(result.leafCount,leaves.length);
  const entries=leaves.flat();assert.deepEqual(entries.map(e=>e.tileId),[...expected.keys()]);
  const oceanEntries=entries.filter(e=>expected.get(e.tileId).equals(Buffer.alloc(32)));
  assert.ok(oceanEntries.length>1000);assert.equal(new Set(oceanEntries.map(e=>e.offset)).size,1,'ocean ids retained at one content offset');
  const ranges=[],reader=readerFor(bytes,'whole-walk',ranges);
  assert.deepEqual(await reader.getMetadata(),metadata);
  await walk(reader,expected);
  for(let i=0;i<leaves.length;i++){
    const boundary=[leaves[i][0],leaves[i].at(-1)];
    if(i>0)boundary.push(leaves[i-1].at(-1));
    if(i+1<leaves.length)boundary.push(leaves[i+1][0]);
    await walk(readerFor(bytes,'boundary-'+i),new Map(boundary.map(e=>[e.tileId,expected.get(e.tileId)])));
    assert.ok(ranges.some(r=>r.offset===header.leafDirectoryOffset+root[i].offset&&r.length===root[i].length),'leaf '+i+' fetched');
  }
  assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
  // Causal break-the-fix control: replace one planned ocean id with its absent
  // neighboring id while preserving valid sorted structure. The same read-back
  // walk must fail; no invented PNG/elevation assertion is involved.
  const k=records.findIndex((r,i)=>i>0&&i%7===0&&r.tileId+1<records[i+1]?.tileId);
  assert.ok(k>0);
  const omitted=records[k].tileId;
  const mutated=records.map((r,i)=>i===k?{...r,tileId:r.tileId+1}:r);
  const broken=base(dir,mutated.map(r=>r.tileId));broken.outputPath=join(dir,'missing-ocean.pmtiles');
  await writeTerrainPmtiles({...broken,tiles:mutated});
  const badReader=readerFor(await readFile(broken.outputPath),'missing-ocean');
  await assert.rejects(walk(badReader,new Map([[omitted,expected.get(omitted)]])),/planned tile/);
  t.diagnostic(JSON.stringify({tiles:records.length,leaves:leaves.length,rootBytes:header.rootDirectoryLength,unique:unique.size,bytes:bytes.length}));
});

test('missing, reordered, duplicate or extra planned ids refuse without publishing output',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('land')),ocean=await record(dir,2,Buffer.alloc(4)),c=await record(dir,3,Buffer.from('land2'));
  for(const [name,tiles]of [['missing-ocean',[a,c]],['short',[a,ocean]],['reordered',[ocean,a,c]],['duplicate',[a,a,c]],['extra',[a,ocean,c,{...c,tileId:4}]]]){
    const options={...base(dir,[1,2,3]),outputPath:join(dir,name+'.pmtiles')};
    await assert.rejects(writeTerrainPmtiles({...options,tiles}),/planned ids|Missing planned tile/);
    assert.equal(await exists(options.outputPath),false);assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
  }
});

test('SHA receipt, source I/O, payload cap, iterator error and owner abort leave no partial archive',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('first')),b=await record(dir,2,Buffer.from('second'));
  const owner=new AbortController();
  const cases=[
    {name:'sha',tiles:[a,{...b,sha256:'0'.repeat(64)}],pattern:/receipt mismatch/},
    {name:'missing-source',tiles:[a,{...b,path:join(dir,'absent')}],pattern:/ENOENT/},
    {name:'cap',tiles:[a,b],extra:{maxTileBytes:1},pattern:/allowance/},
    {name:'iterator',tiles:(async function*(){yield a;throw Error('producer failed');})(),pattern:/producer failed/},
    {name:'abort',tiles:(async function*(){yield a;owner.abort(new Error('owner stopped'));yield b;})(),extra:{signal:owner.signal},pattern:/owner stopped/}
  ];
  for(const row of cases){const options={...base(dir,[1,2]),...row.extra,outputPath:join(dir,row.name+'.pmtiles'),tiles:row.tiles};
    await assert.rejects(writeTerrainPmtiles(options),row.pattern);
    assert.equal(await exists(options.outputPath),false);assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);}
});

test('exclusive output and scratch guards preserve preexisting bytes',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('tile'));
  for(const kind of ['output','scratch']){
    const options={...base(dir,[1]),outputPath:join(dir,kind+'.pmtiles'),tiles:[a]};
    const held=options.outputPath+(kind==='scratch'?'.tile-data.tmp':'');
    await writeFile(held,'preserve me');
    await assert.rejects(writeTerrainPmtiles(options),/EEXIST/);
    assert.equal((await readFile(held)).toString(),'preserve me');
    if(kind==='output')assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
  }
});

test('malformed plan and incomplete provenance reject before creating scratch',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('tile'));
  for(const extra of [{plannedTileIds:[1,1]},{plannedTileIds:[-1]},{maxTiles:0},{metadata:{...metadata,modifications:''}},{metadata:{...metadata,tile_size:256}}]){
    const options={...base(dir,[1]),tiles:[a],...extra};
    await assert.rejects(writeTerrainPmtiles(options));
    assert.equal(await exists(options.outputPath),false);assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
  }
});

test('abort arriving during final sync rejects and removes owned output',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('tile')),owner=new AbortController();
  const options={...base(dir,[1]),tiles:[a],signal:owner.signal};
  const reason=new Error('aborted during sync');
  control.after=(op,path)=>{if(op==='sync'&&path===options.outputPath)owner.abort(reason);};
  await assert.rejects(writeTerrainPmtiles(options),error=>error===reason);
  assert.equal(await exists(options.outputPath),false);assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
});

test('write error remains primary while every cleanup is attempted despite close error',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('tile'));
  const options={...base(dir,[1]),tiles:[a]},primary=new Error('injected output write failure');
  control.events=[];
  control.before=(op,path)=>{if(op==='write'&&path===options.outputPath)throw primary;};
  // Throw after the real close so test injection itself does not leak a handle.
  control.after=(op,path)=>{if(op==='close'&&path===options.outputPath)throw Error('injected close failure');};
  await assert.rejects(writeTerrainPmtiles(options),error=>error===primary);
  assert.ok(control.events.some(([op,path])=>op==='close'&&path===options.outputPath+'.tile-data.tmp'));
  assert.ok(control.events.some(([op,path])=>op==='unlink'&&path===options.outputPath));
  assert.equal(await exists(options.outputPath),false);assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
});

test('successful payload with cleanup failure reports error and still closes/removes scratch',async t=>{
  const dir=await setup(t),a=await record(dir,1,Buffer.from('tile'));
  const options={...base(dir,[1]),tiles:[a]};
  control.after=(op,path)=>{if(op==='close'&&path===options.outputPath)throw Error('injected close failure');};
  await assert.rejects(writeTerrainPmtiles(options),error=>error instanceof AggregateError&&error.errors.some(e=>/close failure/.test(e.message)));
  assert.equal(await exists(options.outputPath+'.tile-data.tmp'),false);
  assert.equal(await exists(options.outputPath),true,'complete archive remains, but cleanup failure is not success');
});
