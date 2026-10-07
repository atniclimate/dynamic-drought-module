/**
 * Unwired DR-136 client. M17 must dynamically import this module only after its
 * issuer/year/box filter finds a candidate pair. One Worker owns one operation.
 */
import { PolygonClipError, assertClipLimits, copyClipGeometry, type ClipRequest, type PolygonClipLimits } from './polygon-clip-contract';
import type { ClipCoordinates } from './polygon-clip-validation';
export interface ClipWorkerLike {
  onmessage:((event:MessageEvent<unknown>)=>void)|null;
  onerror:((event:ErrorEvent)=>void)|null;
  onmessageerror:((event:MessageEvent)=>void)|null;
  postMessage(request:ClipRequest):void;
  terminate():void;
}
export interface PolygonClipOptions {
  readonly signal:AbortSignal;
  readonly generation:number;
  readonly deadlineMs:number;
  readonly limits:PolygonClipLimits;
  readonly createWorker?:()=>ClipWorkerLike;
}
function moduleWorker():ClipWorkerLike {
  return new Worker(new URL('./polygon-clip-worker.ts',import.meta.url),{type:'module'});
}
const aborted=():DOMException=>new DOMException('Aborted','AbortError');
export async function clipPolygonPair(a:unknown,b:unknown,options:PolygonClipOptions):Promise<ClipCoordinates> {
  const started=performance.now();
  if(options.signal.aborted) throw aborted();
  assertClipLimits(options.limits);
  // Signed 32-bit timer range is a platform constraint, not a resource budget.
  if(!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs<=0 || options.deadlineMs>2147483647 ||
    !Number.isSafeInteger(options.generation) || options.generation<0) throw new RangeError('Invalid clip operation options.');
  const left=copyClipGeometry(a,options.limits.input.maxVertices,'invalid-input');
  const right=copyClipGeometry(b,options.limits.input.maxVertices,'invalid-input');
  if(options.signal.aborted) throw aborted();
  const expired=():boolean=>performance.now()-started>=options.deadlineMs;
  if(expired()) throw new PolygonClipError('deadline','completion-time');
  let worker:ClipWorkerLike;
  try { worker=(options.createWorker??moduleWorker)(); }
  catch { throw new PolygonClipError('operation-failed','worker-construction'); }
  return new Promise((resolve,reject)=>{
    let settled=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const finish=(value:ClipCoordinates|undefined,error?:unknown):void=>{
      if(settled) return;
      settled=true;
      if(timer!==undefined) clearTimeout(timer);
      options.signal.removeEventListener('abort',onAbort);
      worker.onmessage=worker.onerror=worker.onmessageerror=null;
      try { worker.terminate(); } catch { /* Preserve the original settlement. */ }
      if(error!==undefined) reject(error); else resolve(value!);
    };
    const onAbort=():void=>finish(undefined,aborted());
    const fail=(reason:string):void=>finish(undefined,new PolygonClipError('operation-failed',reason));
    const deadline=():void=>finish(undefined,new PolygonClipError('deadline','completion-time'));
    options.signal.addEventListener('abort',onAbort,{once:true});
    worker.onerror=(event)=>{ event.preventDefault(); fail('worker-error'); };
    worker.onmessageerror=()=>fail('message-error');
    worker.onmessage=(event)=>{
      if(settled) return;
      if(options.signal.aborted) { onAbort(); return; }
      if(expired()) { deadline(); return; }
      const reply=event.data;
      if(!reply || typeof reply!=='object') { fail('malformed-reply'); return; }
      const r=reply as Record<string,unknown>;
      if(!Number.isSafeInteger(r['generation']) || (r['generation'] as number)<0) { fail('malformed-reply'); return; }
      if(r['generation']!==options.generation) return; // Stale response cannot settle current job.
      if(r['ok']===false) {
        if((r['code']==='invalid-input' || r['code']==='invalid-output' || r['code']==='operation-failed') &&
          typeof r['reason']==='string') finish(undefined,new PolygonClipError(r['code'],r['reason']));
        else fail('malformed-reply');
        return;
      }
      if(r['ok']!==true || !Array.isArray(r['coordinates'])) { fail('malformed-reply'); return; }
      try {
        const result=r['coordinates'].length===0 ? [] :
          copyClipGeometry({type:'MultiPolygon',coordinates:r['coordinates']},options.limits.output.maxVertices,'invalid-output').coordinates;
        if(expired()) deadline(); else finish(result);
      } catch(error) { finish(undefined,error); }
    };
    if(options.signal.aborted) { onAbort(); return; }
    if(expired()) { deadline(); return; }
    timer=setTimeout(deadline,Math.max(1,options.deadlineMs-(performance.now()-started)));
    try { worker.postMessage({generation:options.generation,a:left,b:right,limits:options.limits}); }
    catch { fail('post-message'); }
  });
}
