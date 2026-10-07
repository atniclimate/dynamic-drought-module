/**
 * DR-136: sole polygon-clipping importer. Execute only inside the clip Worker,
 * created after M17 has a cross-issuer/year-compatible bounding-box candidate.
 * No M22 reuse. Planar WGS84 geometry only; no area/link decision is made here.
 */
import polygonClipping from 'polygon-clipping';
import { validatePolygonForClip, certifyEmptyClip, PolygonClipValidationError, type ClipCoordinates } from './polygon-clip-validation';
import { PolygonClipError, assertClipLimits, type PolygonClipLimits } from './polygon-clip-contract';

type Intersection = (a:ClipCoordinates,b:ClipCoordinates)=>unknown;
export function intersectPolygons(a:unknown,b:unknown,limits:PolygonClipLimits,
  operation:Intersection=polygonClipping.intersection):ClipCoordinates {
  assertClipLimits(limits);
  const validate=(value:unknown,phase:'invalid-input'|'invalid-output',cap:PolygonClipLimits['input']):ClipCoordinates=>{
    try { return validatePolygonForClip(value,cap); }
    catch(error) {
      throw new PolygonClipError(phase,error instanceof PolygonClipValidationError ? error.code : 'validation-failed');
    }
  };
  const left=validate(a,'invalid-input',limits.input);
  const right=validate(b,'invalid-input',limits.input);
  refuseVendorInputCollapse(left,right);
  let output:unknown;
  try { output=operation(left,right); }
  catch { throw new PolygonClipError('operation-failed','intersection-threw'); }
  if(Array.isArray(output) && output.length===0) {
    let certified=false;
    try { certified=certifyEmptyClip(left,right,limits.input.maxSegmentTests); }
    catch(error) { throw new PolygonClipError('invalid-output',error instanceof PolygonClipValidationError ? error.code : 'empty-certification-failed'); }
    if(!certified) throw new PolygonClipError('invalid-output','numerical-uncertainty');
    return [];
  }
  return validate({type:'MultiPolygon',coordinates:output},'invalid-output',limits.output);
}

/**
 * Reject the exact pinned vendor's input-coordinate coalescing domain.
 * This reproduces 0.15.7 cmp, not a scientific geometry tolerance.
 * Sorted adjacent unequal values plus the vendor's seeded zero suffice to
 * detect an input collapse; generated intersections still need empty certification.
 */
function refuseVendorInputCollapse(a:ClipCoordinates,b:ClipCoordinates):void {
  const axes:[Set<number>,Set<number>]=[new Set([0]),new Set([0])];
  for(const geometry of [a,b]) for(const polygon of geometry) for(const ring of polygon) for(const p of ring){
    axes[0].add(p[0]);axes[1].add(p[1]);
  }
  for(const axis of axes){
    const values=[...axis].sort((x,y)=>x-y);
    for(let i=1;i<values.length;i++){
      const x=values[i-1]!;const y=values[i]!;
      const d=x-y;const e=Number.EPSILON;
      if((-e<x && x<e && -e<y && y<e) || d*d<e*e*x*y)
        throw new PolygonClipError('invalid-input','numerical-uncertainty');
    }
  }
}
