/**
 * Strict input gate for the DR-136 cross-issuer clipper, not a general GIS repair.
 * Run inside the clip Worker before intersection and again on its output.
 * Conservative rejection leaves the pair undetermined; it never means no overlap.
 */
export interface ClipValidationLimits {
  readonly maxVertices: number;
  readonly maxSegmentTests: number;
}
export type ClipCoordinates = [number, number][][][];
export class PolygonClipValidationError extends Error {
  readonly code: 'invalid-geometry' | 'validation-limit';
  constructor(code: PolygonClipValidationError['code'], message: string) {
    super(message); this.name = 'PolygonClipValidationError'; this.code = code;
  }
}
type Point = { xy: [number, number]; x: bigint; y: bigint };
type Ring = Point[];
const invalid = (message: string): never => { throw new PolygonClipValidationError('invalid-geometry', message); };

/** Exact integer representation of a finite binary64 value, scaled by 2^1074. */
function exact(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const exponent = (high >>> 20) & 0x7ff;
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const unsigned = exponent === 0 ? mantissa : ((1n << 52n) | mantissa) << BigInt(exponent - 1);
  return high >>> 31 ? -unsigned : unsigned;
}
function orientation(a: Point, b: Point, c: Point): bigint {
  return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
}
function equal(a: Point, b: Point): boolean { return a.x===b.x && a.y===b.y; }
function within(a: bigint, b: bigint, x: bigint): boolean {
  return x >= (a < b ? a : b) && x <= (a > b ? a : b);
}
function onSegment(a: Point, b: Point, p: Point): boolean {
  return orientation(a,b,p)===0n && within(a.x,b.x,p.x) && within(a.y,b.y,p.y);
}
function touches(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC=orientation(a,b,c); const abD=orientation(a,b,d);
  const cdA=orientation(c,d,a); const cdB=orientation(c,d,b);
  if (abC===0n && onSegment(a,b,c) || abD===0n && onSegment(a,b,d) ||
      cdA===0n && onSegment(c,d,a) || cdB===0n && onSegment(c,d,b)) return true;
  return (abC>0n && abD<0n || abC<0n && abD>0n) &&
    (cdA>0n && cdB<0n || cdA<0n && cdB>0n);
}

/**
 * Accept closed, simple WGS84 two-dimensional rings with disjoint, strictly
 * contained holes. Reject touching/nested holes and touching/overlapping components
 * conservatively rather than silently normalizing them. A disjoint component inside
 * another component's hole is accepted. Ring direction is immaterial.
 * Limits count closing positions too; maxSegmentTests covers segment-pair and
 * point-in-ring edge checks. No production allowance is selected here.
 */
export function validatePolygonForClip(value: unknown, limits: ClipValidationLimits): ClipCoordinates {
  for (const n of [limits.maxVertices, limits.maxSegmentTests]) {
    if (!Number.isSafeInteger(n) || n<=0) throw new RangeError('Invalid clip validation limit.');
  }
  let vertices=0; let checks=0;
  const spend = (): void => {
    if (++checks>limits.maxSegmentTests) throw new PolygonClipValidationError('validation-limit','Clip topology allowance exceeded.');
  };
  if (!value || typeof value!=='object') return invalid('Expected polygon geometry.');
  const input=value as {type?:unknown; coordinates?:unknown};
  const raw: unknown = input.type==='Polygon' ? [input.coordinates] :
    input.type==='MultiPolygon' ? input.coordinates : null;
  if (!Array.isArray(raw) || raw.length===0) return invalid('Expected nonempty polygon geometry.');
  const polygons: Ring[][]=[];
  for (const polygon of raw) {
    if (!Array.isArray(polygon) || polygon.length===0) return invalid('Polygon has no exterior ring.');
    const rings: Ring[]=[];
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length<4) return invalid('Ring is too short.');
      vertices+=ring.length;
      if (vertices>limits.maxVertices) throw new PolygonClipValidationError('validation-limit','Clip vertex allowance exceeded.');
      const points: Point[]=ring.map((position: unknown): Point => {
        if (!Array.isArray(position) || position.length!==2) return invalid('Expected two-dimensional position.');
        const x: unknown=position[0]; const y: unknown=position[1];
        if (typeof x!=='number' || typeof y!=='number' || !Number.isFinite(x) || !Number.isFinite(y) ||
            x < -180 || x > 180 || y < -90 || y > 90) return invalid('Invalid WGS84 position.');
        return {xy:[x,y],x:exact(x),y:exact(y)};
      });
      if (!equal(points[0]!,points[points.length-1]!)) return invalid('Ring is not closed.');
      const edges=points.length-1;
      let area=0n;
      for (let i=0;i<edges;i++) {
        const a=points[i]!; const b=points[i+1]!;
        if (equal(a,b)) return invalid('Zero-length ring edge.');
        // The admitted corridor never crosses 180. Do not reinterpret a wrapped edge.
        if (Math.abs(a.xy[0]-b.xy[0])>180) return invalid('Antimeridian edge is unsupported.');
        area+=a.x*b.y-b.x*a.y;
        const c=points[(i+2)%edges]!;
        if (orientation(a,b,c)===0n && (b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)<0n)
          return invalid('Adjacent edges backtrack.');
        for (let j=i+1;j<edges;j++) {
          if (j===i+1 || i===0 && j===edges-1) continue;
          spend();
          if (touches(a,b,points[j]!,points[j+1]!)) return invalid('Ring self-intersects or self-touches.');
        }
      }
      if (area===0n) return invalid('Ring has no area.');
      rings.push(points);
    }
    polygons.push(rings);
  }
  const intersects = (a: Ring,b: Ring): boolean => {
    for (let i=0;i<a.length-1;i++) for (let j=0;j<b.length-1;j++) {
      spend(); if (touches(a[i]!,a[i+1]!,b[j]!,b[j+1]!)) return true;
    }
    return false;
  };
  const inside = (p: Point, ring: Ring): boolean => {
    let result=false;
    for (let i=0;i<ring.length-1;i++) {
      spend();
      const a=ring[i]!; const b=ring[i+1]!;
      if ((a.y>p.y)!==(b.y>p.y)) {
        const side=orientation(a,b,p);
        if (b.y>a.y ? side>0n : side<0n) result=!result;
      }
    }
    return result;
  };
  const insidePolygon=(p:Point,polygon:Ring[]):boolean => {
    let result=false;
    for (const ring of polygon) if (inside(p,ring)) result=!result;
    return result;
  };
  for (const rings of polygons) {
    for (let i=0;i<rings.length;i++) for (let j=i+1;j<rings.length;j++) {
      if (intersects(rings[i]!,rings[j]!)) return invalid('Polygon rings touch or cross.');
      if (i>0 && (inside(rings[i]![0]!,rings[j]!) || inside(rings[j]![0]!,rings[i]!)))
        return invalid('Holes overlap or nest.');
    }
    for (let i=1;i<rings.length;i++) if (!inside(rings[i]![0]!,rings[0]!))
      return invalid('Hole is outside exterior.');
  }
  for (let i=0;i<polygons.length;i++) for (let j=i+1;j<polygons.length;j++) {
    const a=polygons[i]!; const b=polygons[j]!;
    for (const ar of a) for (const br of b) if (intersects(ar,br))
      return invalid('Components touch or cross.');
    if (insidePolygon(a[0]![0]!,b) || insidePolygon(b[0]![0]!,a))
      return invalid('Components overlap.');
  }
  return polygons.map(polygon=>polygon.map(ring=>ring.map(point=>point.xy)));
}

/**
 * Certify only empty area intersections with no ambiguous boundary contact.
 * Operands have already passed validatePolygonForClip. False means uncertain,
 * never proof of positive overlap. Count component pairs and every edge test.
 */
export function certifyEmptyClip(a:ClipCoordinates,b:ClipCoordinates,maxSegmentTests:number):boolean {
  if(!Number.isSafeInteger(maxSegmentTests) || maxSegmentTests<=0) throw new RangeError('Invalid empty-clip limit.');
  let checks=0;
  const spend=():void=>{
    if(++checks>maxSegmentTests) throw new PolygonClipValidationError('validation-limit','Empty-clip allowance exceeded.');
  };
  const convert=(input:ClipCoordinates):Ring[][]=>input.map(p=>p.map(r=>r.map(xy=>({xy,x:exact(xy[0]),y:exact(xy[1])}))));
  const left=convert(a); const right=convert(b);
  const bounds=(ring:Ring):[number,number,number,number]=>{
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const p of ring){ x0=Math.min(x0,p.xy[0]);y0=Math.min(y0,p.xy[1]);x1=Math.max(x1,p.xy[0]);y1=Math.max(y1,p.xy[1]); }
    return [x0,y0,x1,y1];
  };
  const inside=(point:Point,polygon:Ring[]):boolean=>{
    let result=false;
    for(const ring of polygon) for(let i=0;i<ring.length-1;i++){
      spend();const p=ring[i]!;const q=ring[i+1]!;
      if((p.y>point.y)!==(q.y>point.y)){
        const side=orientation(p,q,point);
        if(q.y>p.y ? side>0n : side<0n) result=!result;
      }
    }
    return result;
  };
  const leftBounds=left.map(p=>bounds(p[0]!));const rightBounds=right.map(p=>bounds(p[0]!));
  const sameBoundary=(a:Ring,b:Ring):boolean=>{
    spend();if(a.length!==b.length)return false;
    const n=a.length-1;
    let start=-1;
    for(let i=0;i<n;i++){spend();if(equal(a[0]!,b[i]!)){start=i;break;}}
    if(start<0)return false;
    for(const direction of [1,-1]){
      let same=true;
      for(let i=0;i<n;i++){spend();if(!equal(a[i]!,b[(start+direction*i+n)%n]!)){same=false;break;}}
      if(same)return true;
    }
    return false;
  };
  for(let i=0;i<left.length;i++) for(let j=0;j<right.length;j++){
    spend();
    const u=leftBounds[i]!;const v=rightBounds[j]!;
    if(u[2]<=v[0] || v[2]<=u[0] || u[3]<=v[1] || v[3]<=u[1]) continue;
    const p=left[i]!;const q=right[j]!;
    // Exact coincident exterior/hole boundary has no filled area in common.
    // Other components are still checked; an island inside that hole is not lost.
    if(p.slice(1).some(hole=>sameBoundary(hole,q[0]!)) ||
       q.slice(1).some(hole=>sameBoundary(hole,p[0]!)))continue;
    for(const pr of p) for(const qr of q)
      for(let x=0;x<pr.length-1;x++) for(let y=0;y<qr.length-1;y++){
        spend();if(touches(pr[x]!,pr[x+1]!,qr[y]!,qr[y+1]!)) return false;
      }
    // Boundaries are disjoint. A component's exterior point determines containment.
    if(inside(p[0]![0]!,q) || inside(q[0]![0]!,p)) return false;
  }
  return true;
}
