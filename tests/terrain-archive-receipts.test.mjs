import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { terrainExpectations,evaluateTerrainReceipt,collectTerrainReceipt,TERRAIN_ORIGIN } from '../scripts/lib/terrain-archive-receipts.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const limits={timeoutMs:1000,maxSamples:3,maxRangeBytes:1024,maxTotalBytes:2048}; // synthetic only
// Synthetic wire receipt, not a national bake or a decodable terrain archive.
const archive=Buffer.alloc(256);archive.write('PMTiles');archive[7]=3;
for(const offset of [8,24,40])archive.writeBigUInt64LE(127n,offset);
archive.writeBigUInt64LE(128n,56);archive.writeBigUInt64LE(128n,64);
archive[100]=0;archive[101]=11;
for(const [offset,value]of [[102,-125],[106,24.4],[110,-66.9],[114,49.5]])archive.writeInt32LE(Math.round(value*1e7),offset);
archive.set([1,2,3,4],128);
const expected={key:'synthetic-receipt.pmtiles',issuer:'Synthetic test only',bytes:archive.length,sha256:hash(archive),headerHex:archive.subarray(0,127).toString('hex'),
  samples:[{offset:128,length:4,sha256:hash(archive.subarray(128,132))}]};
const headers=range=>({'content-range':`bytes ${range.offset}-${range.offset+range.length-1}/${expected.bytes}`,
  'content-length':String(range.length),'etag':'"fixture-v1"','accept-ranges':'bytes','access-control-allow-origin':'*',
  'access-control-expose-headers':'Content-Range, ETag, Content-Length, Accept-Ranges'});
const fixture=()=>({url:'https://example.test/'+expected.key,expectedArchiveSha256:expected.sha256,origin:TERRAIN_ORIGIN,ranges:terrainExpectations(expected,limits).ranges.map(range=>({...range,status:206,bytes:range.length,headers:headers(range),
  ...(range.offset===0?{headerHex:expected.headerHex}:{})}))});
test('offline fixture passes and header bounds retain exact e7 interpretation',()=>{
  assert.deepEqual(evaluateTerrainReceipt(expected,fixture(),limits),{ok:true,reasons:[]});
  assert.deepEqual(terrainExpectations(expected,limits).bounds,[-125,24.4,-66.9,49.5]);
});
test('one changed header byte, served size mismatch and missing exposure each fail causally',()=>{
  const changed=fixture();const bytes=Buffer.from(changed.ranges[0].headerHex,'hex');bytes[126]^=1;
  changed.ranges[0].headerHex=bytes.toString('hex');changed.ranges[0].sha256=hash(bytes);
  assert.ok(evaluateTerrainReceipt(expected,changed,limits).reasons.includes('range-0:header'));
  const size=fixture();size.ranges[0].headers['content-range']='bytes 0-126/257';
  assert.ok(evaluateTerrainReceipt(expected,size,limits).reasons.includes('range-0:content-range'));
  const expose=fixture();delete expose.ranges[0].headers['access-control-expose-headers'];
  assert.ok(evaluateTerrainReceipt(expected,expose,limits).reasons.includes('range-0:expose'));
  assert.throws(()=>terrainExpectations({...expected,bytes:257},limits),/extent mismatch/);
});
test('offline receipt binds declared URL and expected artifact while retaining sampled-only evidence',()=>{
  for(const url of ['https://example.test/wrong.pmtiles','http://example.test/'+expected.key,
    'https://u:p@example.test/'+expected.key,'https://example.test/'+expected.key+'?token=x',
    'https://example.test/'+expected.key+'#fragment',undefined]){
    const receipt=fixture();receipt.url=url;
    assert.ok(evaluateTerrainReceipt(expected,receipt,limits).reasons.includes('url'));
  }
  for(const value of ['0'.repeat(64),undefined]){
    const receipt=fixture();receipt.expectedArchiveSha256=value;
    assert.ok(evaluateTerrainReceipt(expected,receipt,limits).reasons.includes('expected-artifact'));
  }
  const failed=fixture();failed.error='TimeoutError';
  assert.ok(evaluateTerrainReceipt(expected,failed,limits).reasons.includes('error'));
  const upper=fixture();upper.expectedArchiveSha256=expected.sha256.toUpperCase();
  assert.equal(evaluateTerrainReceipt(expected,upper,limits).ok,true);
  // A different full-artifact declaration with matching sampled bytes is not
  // a whole-archive verification: only agreement with the supplied identity.
  const otherExpected={...expected,sha256:'f'.repeat(64)},otherReceipt=fixture();
  otherReceipt.expectedArchiveSha256=otherExpected.sha256;
  assert.equal(evaluateTerrainReceipt(otherExpected,otherReceipt,limits).ok,true);
});
test('sample corruption, truncation, false200, range swap and inconsistent ETags cannot pass',()=>{
  const mutations=[r=>r.ranges[1].sha256='0'.repeat(64),r=>r.ranges[1].bytes--,r=>r.ranges[0].status=200,
    r=>r.ranges.reverse(),r=>r.ranges[1].headers.etag='"different-object"',r=>r.ranges[0].headers['access-control-expose-headers']='*'];
  for(const mutate of mutations){const row=fixture();mutate(row);assert.equal(evaluateTerrainReceipt(expected,row,limits).ok,false);}
});
test('historical PNW header does not invent a full artifact or tile receipt',()=>{
  const historical=JSON.parse(readFileSync(new URL('./fixtures/terrain-deep-archive.json',import.meta.url),'utf8'));
  assert.equal(hash(Buffer.from(historical.headerHex,'hex')),historical.headerSha256);
  assert.throws(()=>terrainExpectations(historical,limits),/Incomplete/);
});
test('live collector seam makes only exact owner URL bounded GET ranges with deploy Origin',async()=>{
  const calls=[];const url='https://example.test/'+expected.key;
  const receipt=await collectTerrainReceipt(url,expected,limits,{fetchImpl:async(actual,options)=>{
    calls.push({actual,options});const match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);const offset=Number(match[1]),length=Number(match[2])-offset+1;
    return new Response(archive.subarray(offset,offset+length),{status:206,headers:headers({offset,length})});
  }});
  assert.equal(receipt.verdict.ok,true);assert.equal(calls.length,2);
  for(const {actual,options}of calls){assert.equal(actual,url);assert.equal(options.headers.Origin,TERRAIN_ORIGIN);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');}
});
test('stalled body and headers obey total deadline even when cancellation promise never settles',{timeout:1000},async()=>{
  let canceled=0;
  const receipt=await collectTerrainReceipt('https://example.test/'+expected.key,expected,{...limits,timeoutMs:20},{fetchImpl:async()=>
    new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled++;return new Promise(()=>{});}}),{status:206,headers:headers({offset:0,length:127})})});
  assert.equal(receipt.error,'TimeoutError');assert.equal(receipt.verdict.ok,false);assert.equal(canceled,1);
  const noHeaders=await collectTerrainReceipt('https://example.test/'+expected.key,expected,{...limits,timeoutMs:20},{fetchImpl:()=>new Promise(()=>{})});
  assert.equal(noHeaders.error,'TimeoutError');assert.equal(noHeaders.verdict.ok,false);
});
test('overflow is canceled, owner abort remains distinct, and invalid inputs perform no request',async()=>{
  let canceled=0;
  const tooLong=await collectTerrainReceipt('https://example.test/'+expected.key,expected,limits,{fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(128));},cancel(){canceled++;}}),{status:206,headers:headers({offset:0,length:127})})});
  assert.equal(tooLong.verdict.ok,false);assert.equal(canceled,1);
  const owner=new AbortController();owner.abort();let requests=0;
  const aborted=await collectTerrainReceipt('https://example.test/'+expected.key,expected,limits,{signal:owner.signal,fetchImpl:()=>{requests++;assert.fail('egress');}});
  assert.equal(aborted.error,'AbortError');assert.equal(requests,0);
  for(const url of ['http://example.test/'+expected.key,'https://u:p@example.test/'+expected.key,'https://example.test/'+expected.key+'?token=x','https://example.test/wrong.pmtiles'])
    await assert.rejects(collectTerrainReceipt(url,expected,limits,{fetchImpl:()=>assert.fail('egress')}));
  assert.throws(()=>terrainExpectations({...expected,samples:[]},limits));
  assert.throws(()=>terrainExpectations(expected,{...limits,maxTotalBytes:127}));
});
