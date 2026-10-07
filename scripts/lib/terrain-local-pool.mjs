import {Worker} from 'node:worker_threads';
import {open,readFile,stat,unlink,link,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,isAbsolute,join} from 'node:path';
import {zxyToTileId} from './pmtiles-writer.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=n=>Number.isSafeInteger(n)&&n>0;
async function writeSynced(handle,bytes){
  let failed=false;
  try{await handle.writeFile(bytes);await handle.sync();}
  catch(error){failed=true;throw error;}
  finally{try{await handle.close();}catch(error){if(!failed)throw error;}}
}
const absent=async path=>{try{await stat(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}};
async function verifySource(source,limits,signal){
  const owner=new AbortController(),abort=()=>owner.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>owner.abort(Error('Local source verification deadline')),limits.jobTimeoutMs);
  try{
    signal.throwIfAborted();
    const before=await stat(source.path);
    if(!before.isFile()||before.size>limits.maxSourceBytes)throw Error('Local source byte allowance');
    const hash=createHash('sha256');let bytes=0;
    for await(const part of createReadStream(source.path,{highWaterMark:limits.sourceReadBufferBytes,signal:owner.signal})){
      bytes+=part.length;if(bytes>limits.maxSourceBytes)throw Error('Local source byte allowance');hash.update(part);
    }
    owner.signal.throwIfAborted();
    const after=await stat(source.path);
    if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash.digest('hex')!==source.sha256)throw Error('Local source receipt mismatch');
    return {path:source.path,size:after.size,mtimeMs:after.mtimeMs};
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
async function stored(store,job,key,maxTileBytes,maxReceiptBytes){
  const path=join(store,job.tileId+'.png'),receiptPath=path+'.json';
  const noPng=await absent(path),noReceipt=await absent(receiptPath);
  if(noPng&&noReceipt)return null;
  if(noPng||noReceipt)throw Error('Incomplete existing terrain tile; explicit recovery required');
  const info=await stat(path),receiptInfo=await stat(receiptPath);
  if(info.size>maxTileBytes||receiptInfo.size>maxReceiptBytes)throw Error('Stored tile receipt allowance');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  if(receipt.key!==key||receipt.tileId!==job.tileId||receipt.bytes!==info.size)throw Error('Stored tile recipe mismatch');
  const bytes=await readFile(path);
  if(digest(bytes)!==receipt.sha256)throw Error('Stored tile SHA mismatch');
  return {tileId:job.tileId,path,sha256:receipt.sha256};
}
async function publish(store,job,key,bytes,signal,maxReceiptBytes){
  const path=join(store,job.tileId+'.png'),receiptPath=path+'.json';
  const pending=path+'.pending',receiptPending=receiptPath+'.pending';
  const owned=[];let complete=false,failed=false;
  try{
    signal.throwIfAborted();
    const payload=await open(pending,'wx');owned.push(pending);
    await writeSynced(payload,bytes);
    const receipt={key,tileId:job.tileId,bytes:bytes.length,sha256:digest(bytes)};
    const encodedReceipt=JSON.stringify(receipt)+'\n';
    if(Buffer.byteLength(encodedReceipt)>maxReceiptBytes)throw Error('Terrain receipt byte allowance');
    const handle=await open(receiptPending,'wx');owned.push(receiptPending);
    await writeSynced(handle,encodedReceipt);
    signal.throwIfAborted();
    await link(pending,path);owned.push(path);
    signal.throwIfAborted();
    await link(receiptPending,receiptPath);owned.push(receiptPath);
    signal.throwIfAborted();complete=true;
    return {tileId:job.tileId,path,sha256:receipt.sha256};
  }catch(error){failed=true;throw error;}finally{
    const failures=[];
    for(const file of owned)if(!complete||file.endsWith('.pending'))try{await unlink(file);}catch(e){failures.push(e);}
    if(!failed&&failures.length)throw new AggregateError(failures,'Terrain tile publication cleanup failed');
  }
}
/**
 * Local-only pool. Sources must remain immutable for this invocation; their
 * complete hashes are checked before workers and size/mtime after workers.
 * Completed per-tile receipts are reusable; unreceipted files never count.
 * No source failure is converted into a synthetic ocean tile.
 */
export async function buildLocalTerrainStore({storePath,jobs,recipe,limits,signal,
  workerUrl=new URL('./terrain-tile-worker.mjs',import.meta.url)}){
  for(const key of ['workers','jobTimeoutMs','maxJobs','maxSourcesPerTile','maxSourceBytes','sourceReadBufferBytes','maxSourcePixels','maxTileBytes','maxReceiptBytes']){
    if(!positive(limits?.[key]))throw Error('Required terrain pool allowance: '+key);
  }
  if(limits.jobTimeoutMs>2147483647)throw Error('Terrain deadline exceeds timer range');
  if(typeof recipe!=='string'||!recipe.trim()||!Array.isArray(jobs)||!jobs.length||jobs.length>limits.maxJobs)throw Error('Invalid terrain job plan');
  if(!isAbsolute(storePath))throw Error('Tile store must be an explicit absolute path');
  const normalized=jobs.map(job=>{
    if(![job.z,job.x,job.y].every(n=>Number.isSafeInteger(n)&&n>=0)||job.z>26||job.x>=2**job.z||job.y>=2**job.z)throw Error('Invalid tile coordinates');
    if(!['land','ocean'].includes(job.kind)||!Array.isArray(job.sources)||job.sources.length>limits.maxSourcesPerTile||
      (job.kind==='ocean'?job.sources.length!==0:job.sources.length===0))throw Error('Explicit land/ocean source plan required');
    const sources=job.sources.map(source=>{
      if(!isAbsolute(source.path)||!(/^[a-f0-9]{64}$/).test(source.sha256))throw Error('Local source receipt required');
      return {path:resolve(source.path),sha256:source.sha256};
    });
    return {z:job.z,x:job.x,y:job.y,tileId:zxyToTileId(job.z,job.x,job.y),kind:job.kind,sources};
  });
  if(normalized.some((job,i)=>i>0&&job.tileId<=normalized[i-1].tileId))throw Error('Terrain plan must be strictly tile-id sorted');
  if(!(workerUrl instanceof URL)||workerUrl.protocol!=='file:')throw Error('Terrain worker must be local');
  const implementation=createHash('sha256');
  for(const url of [new URL('./raster-dem-to-pmtiles.mjs',import.meta.url),new URL('./terrain-local-pool.mjs',import.meta.url),workerUrl,new URL('../../package-lock.json',import.meta.url)])implementation.update(await readFile(url));
  const implementationSha256=implementation.digest('hex');
  const owner=new AbortController(),cancel=()=>owner.abort(signal.reason);
  signal?.throwIfAborted();signal?.addEventListener('abort',cancel,{once:true});
  const store=resolve(storePath),workers=[];let lock,failed=false;
  try{
    await mkdir(store,{recursive:true});
    lock=await open(join(store,'.writer.lock'),'wx');
    const unique=new Map();
    for(const job of normalized)for(const source of job.sources){
      const previous=unique.get(source.path);
      if(previous&&previous.sha256!==source.sha256)throw Error('Conflicting source receipts');
      unique.set(source.path,source);
    }
    const sourceStats=[];
    for(const source of unique.values())sourceStats.push(await verifySource(source,limits,owner.signal));
    const keys=normalized.map(job=>digest(JSON.stringify({version:1,recipe,implementationSha256,tileSize:512,job})));
    const records=new Array(normalized.length),pending=[];
    for(let i=0;i<normalized.length;i++){
      owner.signal.throwIfAborted();
      records[i]=await stored(store,normalized[i],keys[i],limits.maxTileBytes,limits.maxReceiptBytes);
      if(!records[i])pending.push(i);
    }
    let cursor=0,rendered=0;
    function run(worker,job,id){
      return new Promise((resolve,reject)=>{
        let settled=false,started=false;
        function finish(error,data){if(settled)return;settled=true;clearTimeout(timer);owner.signal.removeEventListener('abort',abort);
          worker.off('message',message);worker.off('error',errorEvent);worker.off('exit',exit);
          if(error){const failure=error instanceof Error?error:new Error(String(error));failure.workerStarted=started;reject(failure);}else resolve(data);}
        const abort=()=>finish(owner.signal.reason??Error('Terrain pool aborted'));
        const errorEvent=error=>finish(error),exit=code=>finish(Error('Terrain worker exited '+code));
        function message(reply){
          if(reply?.id!==id)return finish(Error('Unexpected terrain worker reply'));
          if(reply.type==='started'){started=true;return;}
          if(reply.type!=='result'||!(reply.bytes instanceof Uint8Array)||reply.bytes.length<1||reply.bytes.length>limits.maxTileBytes){
            return finish(Error(reply?.error??'Invalid terrain worker result'));
          }
          finish(null,reply.bytes);
        }
        const timer=setTimeout(()=>finish(Error('Terrain worker deadline')),limits.jobTimeoutMs);
        owner.signal.addEventListener('abort',abort,{once:true});worker.on('message',message);worker.on('error',errorEvent);worker.on('exit',exit);
        if(owner.signal.aborted)return abort();
        try{worker.postMessage({id,job,maxSourcePixels:limits.maxSourcePixels,maxTileBytes:limits.maxTileBytes});}catch(e){finish(e);}
      });
    }
    async function loop(worker){
      while(cursor<pending.length){
        owner.signal.throwIfAborted();const index=pending[cursor++];
        const bytes=await run(worker,normalized[index],index);
        owner.signal.throwIfAborted();
        records[index]=await publish(store,normalized[index],keys[index],bytes,owner.signal,limits.maxReceiptBytes);rendered++;
      }
    }
    for(let i=0;i<Math.min(limits.workers,pending.length);i++){
      // GeoTIFF 3.0.5 imports web-worker 1.5.0. In a native thread that
      // package destructures workerData before its no-mod native fallback.
      const worker=new Worker(workerUrl,{trackUnmanagedFds:true,workerData:{}});
      worker.on('error',error=>owner.abort(error));
      workers.push(worker);
    }
    const tasks=workers.map(loop);
    try{await Promise.all(tasks);}catch(e){owner.abort(e);await Promise.allSettled(tasks);throw e;}
    for(const row of sourceStats){const now=await stat(row.path);if(now.size!==row.size||now.mtimeMs!==row.mtimeMs)throw Error('Local mirror changed during bake');}
    owner.signal.throwIfAborted();
    return {records,plannedTileIds:normalized.map(job=>job.tileId),rendered,reused:normalized.length-rendered,workers:workers.length};
  }catch(e){failed=true;owner.abort(e);throw e;}
  finally{
    signal?.removeEventListener('abort',cancel);
    const cleanup=await Promise.allSettled(workers.map(worker=>worker.terminate()));
    if(lock){try{await lock.close();}catch(e){cleanup.push({status:'rejected',reason:e});}
      try{await unlink(join(store,'.writer.lock'));}catch(e){cleanup.push({status:'rejected',reason:e});}}
    if(!failed&&cleanup.some(row=>row.status==='rejected'))throw new AggregateError(cleanup.filter(row=>row.status==='rejected').map(row=>row.reason),'Terrain pool cleanup failed');
  }
}
