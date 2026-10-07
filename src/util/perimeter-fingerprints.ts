import { validatePolygonForClip, type ClipValidationLimits, type ClipCoordinates } from './polygon-clip-validation';
export interface PerimeterFingerprintLimits {
  readonly geometry: ClipValidationLimits;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxChars: number;
}
/** Collision-free canonical strings, not a lossy digest. Worker-only work. */
export function fingerprintPerimeter(geometry: unknown, properties: unknown, limits: PerimeterFingerprintLimits): {
  geometryFingerprint: string; revisionFingerprint: string; geometry: { type: 'MultiPolygon'; coordinates: ClipCoordinates };
} {
  if (![limits.maxNodes, limits.maxDepth, limits.maxChars].every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError('Invalid fingerprint limits.');
  const polygons = validatePolygonForClip(geometry, limits.geometry);
  const compare = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]!;
  const ring = (input: [number, number][]): [number, number][] => {
    const n = input.length - 1;
    let first = 0;
    for (let i = 1; i < n; i++) if (compare(input[i]!, input[first]!) < 0) first = i;
    const direction = compare(input[(first + 1) % n]!, input[(first + n - 1) % n]!) < 0 ? 1 : -1;
    const result: [number, number][] = Array.from({ length: n }, (_, i) => {
      const p = input[(first + direction * i + n) % n]!;
      return [p[0] === 0 ? 0 : p[0], p[1] === 0 ? 0 : p[1]];
    });
    result.push([...result[0]!] as [number, number]);
    return result;
  };
  const order = <T>(values: T[]): T[] => values.map(value => ({ value, key: JSON.stringify(value) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(row => row.value);
  const coordinates = order(polygons.map(p => [ring(p[0]!), ...order(p.slice(1).map(ring))]));
  const canonical = { type: 'MultiPolygon' as const, coordinates };
  let nodes = 0; let chars = 0;
  const active = new Set<object>();
  const add = (s: string): string => { chars += s.length; if (chars > limits.maxChars) throw new RangeError('Fingerprint character allowance exceeded.'); return s; };
  // Tagged JSON values preserve null, array order, exact strings and -0 attributes.
  // Geometry -0 is canonicalized above because it denotes the same coordinate.
  const encode = (value: unknown, depth: number): string => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new RangeError('Fingerprint structure allowance exceeded.');
    if (value === null) return add('n');
    if (typeof value === 'string') return add('s' + JSON.stringify(value));
    if (typeof value === 'boolean') return add(value ? 't' : 'f');
    if (typeof value === 'number' && Number.isFinite(value)) return add('d' + (Object.is(value, -0) ? '-0' : String(value)));
    if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('Non-JSON source revision.');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError('Non-JSON source revision.');
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Non-JSON source revision.');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) throw new TypeError('Non-JSON source revision.');
        const parts: string[] = [];
        add('[]');
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !('value' in descriptor)) throw new TypeError('Non-JSON source revision.');
          parts.push(encode(descriptor.value, depth + 1));
        }
        add(','.repeat(Math.max(0, parts.length - 1)));
        return '[' + parts.join(',') + ']';
      }
      const keys = Object.keys(value).sort(); const parts: string[] = [];
      add('{}');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new TypeError('Non-JSON source revision.');
        parts.push(add(JSON.stringify(key) + ':') + encode(descriptor.value, depth + 1));
      }
      add(','.repeat(Math.max(0, parts.length - 1)));
      return '{' + parts.join(',') + '}';
    } finally { active.delete(value); }
  };
  const geometryFingerprint = 'g1:' + encode(coordinates, 0);
  const revisionFingerprint = 'r1:' + encode([geometryFingerprint, properties], 0);
  if (geometryFingerprint.length > limits.maxChars || revisionFingerprint.length > limits.maxChars) throw new RangeError('Fingerprint character allowance exceeded.');
  return { geometryFingerprint, revisionFingerprint, geometry: canonical };
}
