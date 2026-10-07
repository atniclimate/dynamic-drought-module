import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { parseArcGisPolygonFeatureCollection } from '../config/wildfire-presentation';
import { fetchBufferedWithBudget } from './fetch';

export interface PolygonPageOptions {
  readonly urlForPage: (offset: number, count: number) => string;
  readonly sourceLabel: string;
  readonly signal: AbortSignal;
  readonly pageSize: number;
  readonly pageLimit: number;
  readonly pageTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxPageBytes: number;
  readonly maxTotalBytes: number;
  readonly maxVertices: number;
}
type PolygonFeature = Feature<Polygon | MultiPolygon>;
export interface PolygonPagesResult {
  readonly collection: FeatureCollection<Polygon | MultiPolygon>;
  readonly complete: boolean;
  readonly reason: 'complete' | 'page-limit' | 'deadline' | 'byte-limit' | 'vertex-limit' | 'repeated-page' | 'changed-record' | 'invalid-id' | 'read-failed';
  readonly pages: number;
  readonly acceptedBytes: number;
  /** Vertices in retained distinct feature records. */
  readonly retainedVertices: number;
  /** Positions traversed in all parsed pages, including an unaccepted final page. */
  readonly inspectedVertices: number;
}
function vertexCount(coordinates: unknown): number {
  if (!Array.isArray(coordinates)) return 0;
  if (typeof coordinates[0] === 'number') return 1;
  return coordinates.reduce<number>((sum, part: unknown) => sum + vertexCount(part), 0);
}

/**
 * Unactivated paging primitive. Every resource allowance is an explicit caller
 * input. Empty complete differs from empty failed; callers map these to their
 * source states. Owner cancellation rejects, never publishes a partial result.
 * This preserves raw attributes, including independent initial-event clocks.
 */
export async function readPolygonPages(options: PolygonPageOptions): Promise<PolygonPagesResult> {
  for (const [name, value] of Object.entries({
    pageSize: options.pageSize, pageLimit: options.pageLimit,
    pageTimeoutMs: options.pageTimeoutMs, totalTimeoutMs: options.totalTimeoutMs,
    maxPageBytes: options.maxPageBytes, maxTotalBytes: options.maxTotalBytes,
    maxVertices: options.maxVertices
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid polygon read limit: ' + name);
  }
  const started = performance.now();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal.addEventListener('abort', onAbort);
  if (options.signal.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(), options.totalTimeoutMs);
  const features: PolygonFeature[] = [];
  const fingerprints = new Map<number, string>();
  let pages = 0;
  let acceptedBytes = 0;
  let inspectedVertices = 0;
  let retainedVertices = 0;
  const cancelled = (): void => {
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const expired = (): boolean => controller.signal.aborted || performance.now() - started >= options.totalTimeoutMs;
  const finish = (reason: PolygonPagesResult['reason']): PolygonPagesResult => ({
    collection: { type: 'FeatureCollection', features }, complete: reason === 'complete',
    reason, pages, acceptedBytes, retainedVertices, inspectedVertices
  });
  try {
    cancelled();
    for (let page = 0; page < options.pageLimit; page++) {
      if (expired()) return finish('deadline');
      const remainingBytes = options.maxTotalBytes - acceptedBytes;
      if (remainingBytes <= 0) return finish('byte-limit');
      let value: unknown;
      let bytes: ArrayBuffer;
      try {
        pages++;
        const response = await fetchBufferedWithBudget(
          options.urlForPage(page * options.pageSize, options.pageSize), null,
          controller.signal, options.pageTimeoutMs,
          Math.min(options.maxPageBytes, remainingBytes)
        );
        cancelled();
        if (expired()) return finish('deadline');
        if (!response.ok) return finish('read-failed');
        bytes = await response.arrayBuffer();
        value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch (error) {
        cancelled();
        if (expired()) return finish('deadline');
        return finish(error instanceof RangeError ? 'byte-limit' : 'read-failed');
      }
      cancelled();
      if (expired()) return finish('deadline');
      let parsed: ReturnType<typeof parseArcGisPolygonFeatureCollection>;
      try { parsed = parseArcGisPolygonFeatureCollection(value, options.sourceLabel); }
      catch { return finish('read-failed'); }
      if (expired()) return finish('deadline');
      const incoming = parsed.collection.features as PolygonFeature[];
      const count = incoming.reduce((sum, feature) => sum + vertexCount(feature.geometry.coordinates), 0);
      inspectedVertices += count;
      if (inspectedVertices > options.maxVertices) return finish('vertex-limit');
      const pending = new Map<number, { feature: PolygonFeature; fingerprint: string }>();
      for (const feature of incoming) {
        const id: unknown = feature.properties?.['OBJECTID'];
        if (typeof id !== 'number' || !Number.isSafeInteger(id)) return finish('invalid-id');
        // Conservative: a changed representation is never silently called complete.
        const fingerprint = JSON.stringify(feature);
        const previous = fingerprints.get(id) ?? pending.get(id)?.fingerprint;
        if (previous !== undefined) {
          if (previous !== fingerprint) return finish('changed-record');
        } else pending.set(id, { feature, fingerprint });
      }
      cancelled();
      if (expired()) return finish('deadline');
      if (incoming.length > 0 && pending.size === 0) return finish('repeated-page');
      if (incoming.length === 0 && parsed.truncated) return finish('repeated-page');
      for (const [id, row] of pending) {
        fingerprints.set(id, row.fingerprint); features.push(row.feature);
        retainedVertices += vertexCount(row.feature.geometry.coordinates);
      }
      acceptedBytes += bytes.byteLength;
      if (!parsed.truncated && incoming.length < options.pageSize) return finish('complete');
    }
    return finish('page-limit');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}
