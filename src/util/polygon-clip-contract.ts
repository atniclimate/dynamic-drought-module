import type { ClipCoordinates, ClipValidationLimits } from './polygon-clip-validation';
export interface PolygonClipLimits {
  readonly input: ClipValidationLimits;
  readonly output: ClipValidationLimits;
}
export type PolygonClipFailure = 'invalid-input' | 'operation-failed' | 'invalid-output' | 'deadline';
export class PolygonClipError extends Error {
  readonly code: PolygonClipFailure;
  readonly reason: string;
  constructor(code: PolygonClipFailure, reason: string) {
    super('Polygon clip ' + code + ': ' + reason);
    this.name='PolygonClipError'; this.code=code; this.reason=reason;
  }
}
export interface ClipRequest {
  readonly generation: number;
  readonly a: unknown;
  readonly b: unknown;
  readonly limits: PolygonClipLimits;
}
export type ClipReply =
  | { readonly generation: number; readonly ok: true; readonly coordinates: ClipCoordinates }
  | { readonly generation: number; readonly ok: false; readonly code: Exclude<PolygonClipFailure,'deadline'>; readonly reason: string };

export function assertClipLimits(limits: PolygonClipLimits): void {
  for (const n of [limits.input.maxVertices,limits.input.maxSegmentTests,
    limits.output.maxVertices,limits.output.maxSegmentTests]) {
    if (!Number.isSafeInteger(n) || n<=0) throw new RangeError('Invalid polygon clip limit.');
  }
}

/** Cheap metered copy before structured clone; exact topology belongs in Worker. */
export function copyClipGeometry(value: unknown, maxVertices: number, phase: 'invalid-input'|'invalid-output'): {type:'MultiPolygon';coordinates:ClipCoordinates} {
  const fail=(reason:string):never=>{throw new PolygonClipError(phase,reason);};
  if (!value || typeof value!=='object') return fail('geometry-shape');
  const record=value as {type?:unknown;coordinates?:unknown};
  const polygons:unknown=record.type==='Polygon'?[record.coordinates]:
    record.type==='MultiPolygon'?record.coordinates:null;
  if(!Array.isArray(polygons) || polygons.length===0) return fail('geometry-shape');
  let count=0;
  const coordinates:ClipCoordinates=[];
  for(const polygon of polygons) {
    if(!Array.isArray(polygon) || polygon.length===0) return fail('geometry-shape');
    const rings:[number,number][][]=[];
    for(const ring of polygon) {
      if(!Array.isArray(ring) || ring.length<4) return fail('geometry-shape');
      count+=ring.length;
      if(count>maxVertices) return fail('validation-limit');
      const positions:[number,number][]=[];
      for(const p of ring) {
        if(!Array.isArray(p) || p.length!==2 || typeof p[0]!=='number' ||
          typeof p[1]!=='number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
          p[0]<-180 || p[0]>180 || p[1]<-90 || p[1]>90) return fail('coordinate');
        positions.push([p[0],p[1]]);
      }
      rings.push(positions);
    }
    coordinates.push(rings);
  }
  return {type:'MultiPolygon',coordinates};
}
