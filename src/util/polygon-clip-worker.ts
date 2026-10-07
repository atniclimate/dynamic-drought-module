import { intersectPolygons } from './polygon-clip';
import { PolygonClipError, type ClipReply, type ClipRequest } from './polygon-clip-contract';
const scope=self as unknown as {
  onmessage:((event:MessageEvent<ClipRequest>)=>void)|null;
  postMessage(message:ClipReply):void;
};
scope.onmessage=(event)=>{
  const request=event.data;
  let reply:ClipReply;
  try {
    reply={generation:request.generation,ok:true,
      coordinates:intersectPolygons(request.a,request.b,request.limits)};
  } catch(error) {
    reply={generation:request.generation,ok:false,
      code:error instanceof PolygonClipError && error.code!=='deadline' ? error.code : 'operation-failed',
      reason:error instanceof PolygonClipError ? error.reason : 'worker-failed'};
  }
  scope.postMessage(reply);
};
