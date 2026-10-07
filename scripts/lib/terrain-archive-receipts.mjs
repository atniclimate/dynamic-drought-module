import { createHash } from 'node:crypto';
export const TERRAIN_ORIGIN = 'https://atniclimate.github.io';
const SHA = /^[a-f0-9]{64}$/i;
const EXPOSE = ['content-range','etag','content-length','accept-ranges'];
const positive = n => Number.isSafeInteger(n) && n > 0;
export function terrainExpectations(expected, limits) {
  if (![limits.maxSamples,limits.maxRangeBytes,limits.maxTotalBytes].every(positive)) throw new Error('Invalid terrain receipt limits');
  if (!expected || !/^[a-z0-9][a-z0-9._-]*\.pmtiles$/i.test(expected.key) ||
    typeof expected.issuer !== 'string' || !expected.issuer.trim() || !positive(expected.bytes) ||
    !SHA.test(expected.sha256) || !/^[a-f0-9]{254}$/i.test(expected.headerHex)) throw new Error('Incomplete expected terrain artifact');
  const header = Buffer.from(expected.headerHex,'hex');
  if (header.subarray(0,7).toString('ascii') !== 'PMTiles' || header[7] !== 3) throw new Error('Invalid PMTiles v3 header');
  const tileOffset = header.readBigUInt64LE(56), tileLength = header.readBigUInt64LE(64);
  if (tileOffset < 127n || tileLength <= 0n || tileOffset + tileLength !== BigInt(expected.bytes)) throw new Error('Archive tile-data-last extent mismatch');
  // Existing writer/probe v3 layout: root, metadata, leaf directories, tile data.
  let end=127n;
  for(const [offset,length] of [[8,16],[24,32],[40,48]]) {
    const start=header.readBigUInt64LE(offset),size=header.readBigUInt64LE(length);
    if(start<end || start+size>tileOffset) throw new Error('Archive section layout mismatch');
    end=start+size;
  }
  if(header[100]>header[101] || header[101]>30) throw new Error('Invalid archive zooms');
  const bounds=[102,106,110,114].map(offset=>header.readInt32LE(offset)/1e7);
  if(bounds[0]<-180 || bounds[2]>180 || bounds[1]<-90 || bounds[3]>90 || bounds[0]>=bounds[2] || bounds[1]>=bounds[3]) throw new Error('Invalid archive bounds');
  if (!Array.isArray(expected.samples) || !expected.samples.length || expected.samples.length>limits.maxSamples) throw new Error('Missing or excessive tile samples');
  const ranges=[{offset:0,length:127,sha256:createHash('sha256').update(header).digest('hex')}];
  const seen=new Set();let total=127;
  for(const sample of expected.samples) {
    if(!Number.isSafeInteger(sample.offset) || !positive(sample.length) || !SHA.test(sample.sha256) ||
      BigInt(sample.offset)<tileOffset || BigInt(sample.offset)+BigInt(sample.length)>BigInt(expected.bytes)) throw new Error('Invalid tile sample');
    const key=sample.offset+':'+sample.length;if(seen.has(key))throw new Error('Duplicate tile sample');seen.add(key);
    ranges.push({offset:sample.offset,length:sample.length,sha256:sample.sha256.toLowerCase()});total+=sample.length;
  }
  if(!Number.isSafeInteger(total) || total>limits.maxTotalBytes || ranges.some(r=>r.length>limits.maxRangeBytes)) throw new Error('Terrain range allowance exceeded');
  return {ranges,bounds,minZoom:header[100],maxZoom:header[101]};
}
export function evaluateTerrainReceipt(expected, receipt, limits) {
  const {ranges}=terrainExpectations(expected,limits);const reasons=[];
  if(!receipt || typeof receipt!=='object')return {ok:false,reasons:['receipt']};
  try{
    const url=new URL(receipt.url);
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/'+expected.key))reasons.push('url');
  }catch{reasons.push('url');}
  // Bind the declared expected artifact. Sample reads do not verify its full hash.
  if(typeof receipt.expectedArchiveSha256!=='string' || receipt.expectedArchiveSha256.toLowerCase()!==expected.sha256.toLowerCase())reasons.push('expected-artifact');
  if(receipt.error!==undefined)reasons.push('error');
  if(receipt.origin!==TERRAIN_ORIGIN)reasons.push('origin');
  if(!Array.isArray(receipt.ranges) || receipt.ranges.length!==ranges.length)return {ok:false,reasons:[...reasons,'range-count']};
  let etag;
  ranges.forEach((range,index)=>{
    const row=receipt.ranges[index],prefix='range-'+index+':';
    if(!row || row.offset!==range.offset || row.length!==range.length){reasons.push(prefix+'identity');return;}
    const headers=Object.fromEntries(Object.entries(row.headers??{}).map(([k,v])=>[k.toLowerCase(),String(v).trim()]));
    if(row.error || row.status!==206)reasons.push(prefix+'status');
    if(headers['content-range']!==`bytes ${range.offset}-${range.offset+range.length-1}/${expected.bytes}`)reasons.push(prefix+'content-range');
    if(headers['content-length']!==String(range.length) || row.bytes!==range.length)reasons.push(prefix+'size');
    if(headers['access-control-allow-origin']!=='*' && headers['access-control-allow-origin']!==TERRAIN_ORIGIN)reasons.push(prefix+'allow-origin');
    const exposed=new Set((headers['access-control-expose-headers']??'').toLowerCase().split(',').map(v=>v.trim()));
    if(EXPOSE.some(name=>!exposed.has(name)))reasons.push(prefix+'expose');
    if(headers['accept-ranges']?.toLowerCase()!=='bytes')reasons.push(prefix+'accept-ranges');
    if(headers['content-encoding'] && headers['content-encoding'].toLowerCase()!=='identity')reasons.push(prefix+'content-encoding');
    if(!headers.etag || (etag!==undefined && headers.etag!==etag))reasons.push(prefix+'etag');
    if(etag===undefined)etag=headers.etag;
    if(row.sha256?.toLowerCase()!==range.sha256)reasons.push(prefix+'sha256');
    if(index===0 && row.headerHex?.toLowerCase()!==expected.headerHex.toLowerCase())reasons.push(prefix+'header');
  });
  return {ok:reasons.length===0,reasons};
}
/** No default URL or budget. One total deadline owns headers AND all range bodies. */
export async function collectTerrainReceipt(url,expected,limits,{signal,fetchImpl=fetch}={}) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
    !parsed.pathname.endsWith('/'+expected.key))throw new Error('Supply the final public HTTPS artifact URL without credentials/query/fragment');
  if(!positive(limits.timeoutMs) || limits.timeoutMs>2147483647)throw new Error('Invalid terrain verification deadline');
  const {ranges}=terrainExpectations(expected,limits);
  const controller=new AbortController();const abort=()=>controller.abort(new DOMException('Aborted','AbortError'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const started=performance.now();const timer=setTimeout(()=>controller.abort(new DOMException('Terrain verification deadline','TimeoutError')),limits.timeoutMs);
  const checkpoint=()=>{controller.signal.throwIfAborted();if(performance.now()-started>=limits.timeoutMs){controller.abort(new DOMException('Terrain verification deadline','TimeoutError'));controller.signal.throwIfAborted();}};
  const race=(work,discard)=>new Promise((resolve,reject)=>{
    let finished=false;const dispose=value=>{try{discard?.(value);}catch{}};
    const canceled=()=>{if(finished)return;finished=true;controller.signal.removeEventListener('abort',canceled);reject(controller.signal.reason);};
    controller.signal.addEventListener('abort',canceled,{once:true});
    if(controller.signal.aborted)canceled();
    Promise.resolve(work).then(value=>{if(finished){dispose(value);return;}finished=true;controller.signal.removeEventListener('abort',canceled);try{checkpoint();resolve(value);}catch(error){dispose(value);reject(error);}},error=>{if(finished)return;finished=true;controller.signal.removeEventListener('abort',canceled);reject(error);});
  });
  const receipt={url:parsed.href,origin:TERRAIN_ORIGIN,startedAt:new Date().toISOString(),expectedArchiveSha256:expected.sha256,ranges:[]};
  try {
    for(const range of ranges){
      checkpoint();let reader;
      const row={...range,status:0,headers:{},bytes:0,sha256:null};receipt.ranges.push(row);
      try{
        const response=await race(fetchImpl(parsed.href,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,
          headers:{Origin:TERRAIN_ORIGIN,Range:`bytes=${range.offset}-${range.offset+range.length-1}`,'Accept-Encoding':'identity'}}),response=>{void response.body?.cancel().catch(()=>{});});
        row.status=response.status;
        for(const name of [...EXPOSE,'access-control-allow-origin','access-control-expose-headers','content-encoding']){const value=response.headers.get(name);if(value!==null)row.headers[name]=value;}
        if(response.status!==206){void response.body?.cancel().catch(()=>{});throw new Error('Range request did not return 206');}
        if(!response.body)throw new Error('Missing range body');
        reader=response.body.getReader();const hash=createHash('sha256');const header=[];
        while(true){const next=await race(reader.read());if(next.done)break;
          row.bytes+=next.value.byteLength;if(row.bytes>range.length)throw new Error('Range body exceeded exact requested length');
          hash.update(next.value);if(range.offset===0)header.push(Buffer.from(next.value));
        }
        checkpoint();row.sha256=hash.digest('hex');if(range.offset===0)row.headerHex=Buffer.concat(header).toString('hex');
      }catch(error){row.error=error instanceof DOMException?error.name:String(error?.message??error);throw error;}
      finally{if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}}
    }
  } catch(error){receipt.error=error instanceof DOMException?error.name:String(error?.message??error);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();receipt.elapsedMs=performance.now()-started;}
  receipt.verdict=evaluateTerrainReceipt(expected,receipt,limits);return receipt;
}
