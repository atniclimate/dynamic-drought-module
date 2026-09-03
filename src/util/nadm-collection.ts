/**
 * One structural reading of the North American Drought Monitor (NADM)
 * current-consensus GeoJSON, shared by its two consumers (DR-052 follow-up,
 * 2026-09-03).
 *
 * The map layer (`src/layers/nadm-drought.ts`) and the drought minimap
 * (`src/state/minimap-drought.ts`) share ONE transport through the
 * `'nadm-current'` key of `fetchSharedJsonWithBudget`, and each may evict
 * the fulfilled entry when it rejects the payload. Until 2026-09-03 each
 * carried its own validator, and the two disagreed at the edges: the layer
 * read an empty collection as "no data" while the minimap threw on it and
 * evicted the entry, so a payload one consumer had accepted was thrown away
 * by the other and fetched again. A shared key needs a shared verdict; this
 * module is that verdict, and the eviction rule on both sides is now "this
 * function threw", nothing else.
 *
 * Deliberately free of geometry helpers: the layer's activation chunk is
 * budgeted (`scripts/check-activation-budget.mjs`), and the minimap's
 * polygon preparation stays in `src/util/nadm.ts`.
 */

/** The consensus classes, upper-cased as the issuer publishes them. */
export const NADM_CLASS_CODES = ['D0', 'D1', 'D2', 'D3', 'D4'] as const;
export type NadmClassCode = (typeof NADM_CLASS_CODES)[number];

/** One validated feature: the raw record plus its normalized class. */
export interface NadmCollectionFeature {
  readonly feature: Record<string, unknown>;
  readonly properties: Record<string, unknown>;
  readonly geometry: Record<string, unknown>;
  readonly code: NadmClassCode;
}

/**
 * The verdict. `empty` is a well-formed collection with no features, which
 * is the issuer's honest answer on a month with no classified polygons and
 * is NOT a malformed payload: the layer reports `no-data`, the minimap
 * reports `unavailable`, and neither evicts the shared entry.
 */
export type NadmCollectionVerdict =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'ok';
      /** `YYYY-MM`, the single consensus month every feature carries. */
      readonly month: string;
      readonly features: readonly NadmCollectionFeature[];
    };

/** Thrown for a payload no consumer may keep; the shared entry is evicted. */
export class NadmCollectionError extends Error {
  override readonly name = 'NadmCollectionError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `YYYYMM` as the issuer writes it, normalized to `YYYY-MM`; null otherwise. */
export function normalizeNadmYearMonth(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})(0[1-9]|1[0-2])$/.exec(raw);
  return match ? `${match[1]}-${match[2]}` : null;
}

/** `DROUGHTCAT` in either case, normalized to the published upper case. */
export function normalizeNadmClassCode(value: unknown): NadmClassCode | null {
  const code = String(value ?? '')
    .trim()
    .toUpperCase();
  return NADM_CLASS_CODES.includes(code as NadmClassCode)
    ? (code as NadmClassCode)
    : null;
}

function isPosition(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function isRing(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isPolygonCoordinates(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isRing);
}

/** A Polygon or MultiPolygon with closed, finite rings; nothing else. */
export function hasNadmPolygonCoordinates(
  geometry: Record<string, unknown>
): boolean {
  const coordinates = geometry['coordinates'];
  if (geometry['type'] === 'Polygon') return isPolygonCoordinates(coordinates);
  return (
    geometry['type'] === 'MultiPolygon' &&
    Array.isArray(coordinates) &&
    coordinates.length > 0 &&
    coordinates.every(isPolygonCoordinates)
  );
}

/**
 * Read the collection. Throws `NadmCollectionError` on anything that is not
 * a FeatureCollection of well-formed, single-month, classified polygon
 * Features; returns `empty` for a well-formed collection with no features.
 * The checks are the union of what the two consumers used to ask
 * separately, so nothing either accepted before is rejected now except the
 * cases where they disagreed, which are settled here.
 */
export function validateNadmCollection(value: unknown): NadmCollectionVerdict {
  if (
    !isRecord(value) ||
    value['type'] !== 'FeatureCollection' ||
    !Array.isArray(value['features'])
  ) {
    throw new NadmCollectionError('NADM response is not a FeatureCollection.');
  }
  if (value['features'].length === 0) return { kind: 'empty' };

  let month: string | null = null;
  const features: NadmCollectionFeature[] = [];
  for (const feature of value['features']) {
    if (
      !isRecord(feature) ||
      feature['type'] !== 'Feature' ||
      !isRecord(feature['properties']) ||
      !isRecord(feature['geometry']) ||
      !hasNadmPolygonCoordinates(feature['geometry'])
    ) {
      throw new NadmCollectionError(
        'NADM response contains a malformed polygon feature.'
      );
    }
    const properties = feature['properties'];
    const geometry = feature['geometry'];
    const code = normalizeNadmClassCode(properties['DROUGHTCAT']);
    if (code === null) {
      throw new NadmCollectionError(
        `NADM DROUGHTCAT is invalid: ${String(properties['DROUGHTCAT'])}.`
      );
    }
    const featureMonth = normalizeNadmYearMonth(properties['YEAR_MONTH']);
    if (featureMonth === null) {
      throw new NadmCollectionError(
        `NADM YEAR_MONTH is invalid: ${String(properties['YEAR_MONTH'])}.`
      );
    }
    if (month !== null && featureMonth !== month) {
      throw new NadmCollectionError('NADM response mixes consensus months.');
    }
    month = featureMonth;
    features.push({ feature, properties, geometry, code });
  }
  if (month === null) {
    throw new NadmCollectionError('NADM response has no consensus month.');
  }
  return { kind: 'ok', month, features };
}
