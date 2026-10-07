import { readPolygonPages, type PolygonPageOptions, type PolygonPagesResult } from './polygon-pages';

export interface BcwsReadOptions extends Omit<PolygonPageOptions, 'urlForPage' | 'sourceLabel'> {
  readonly endpoint: string;
  readonly bounds?: readonly [west: number, south: number, east: number, north: number];
}

/** DR-134 only. Unknown values never enter the issuer-active edge. */
export function bcwsStatusClass(value: unknown): 'active' | 'inactive' | 'unknown' {
  if (typeof value !== 'string') return 'unknown';
  switch (value.trim().toLowerCase()) {
    case 'out of control':
    case 'being held':
    case 'under control': return 'active';
    case 'out': return 'inactive';
    default: return 'unknown';
  }
}

/** Unactivated source read; current-product membership is never filtered by year. */
export function readBcwsPerimeters(options: BcwsReadOptions): Promise<PolygonPagesResult> {
  if (options.bounds && (!options.bounds.every(Number.isFinite) ||
      options.bounds[0] > options.bounds[2] || options.bounds[1] > options.bounds[3])) {
    throw new RangeError('Invalid BCWS query bounds.');
  }
  return readPolygonPages({
    ...options,
    sourceLabel: 'BC Wildfire Service',
    urlForPage: (offset, count) => {
      const url = new URL(options.endpoint);
      const params = {
        f: 'geojson', where: '1=1', outFields: '*', outSR: '4326',
        returnGeometry: 'true', orderByFields: 'OBJECTID ASC',
        resultOffset: String(offset), resultRecordCount: String(count),
        maxAllowableOffset: '0.0005', geometryPrecision: '5'
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (options.bounds) {
        url.searchParams.set('geometry', options.bounds.join(','));
        url.searchParams.set('geometryType', 'esriGeometryEnvelope');
        url.searchParams.set('inSR', '4326');
        url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
      }
      return url.toString();
    }
  });
}
