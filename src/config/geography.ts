import type { RegionKey } from './regions';
import type { BoundaryKind, BoundarySelectionContext } from '../impact/types';

/**
 * Canonical geography families used by source policy. These describe the
 * selected point's issuing geography, not the camera framing and not a claim
 * about jurisdiction.
 */
export type CanonicalGeographyKey =
  | 'conus'
  | 'alaska'
  | 'hawaii'
  | 'puerto-rico'
  | 'served-territory'
  | 'american-samoa'
  | 'canada'
  | 'transboundary'
  | 'unknown';

export type GeographyBasis =
  | 'boundary-postal-code'
  | 'boundary-source'
  | 'region-framing'
  | 'unknown';

export interface CanonicalGeography {
  readonly key: CanonicalGeographyKey;
  readonly country: 'United States' | 'Canada' | 'transboundary' | 'unknown';
  readonly postalCode?: string;
  readonly basis: GeographyBasis;
  /**
   * Human-readable qualification for source policy and diagnostics. It never
   * replaces the selected place's own title in the interface.
   */
  readonly note: string;
}

export const CANONICAL_GEOGRAPHY_KEYS: readonly CanonicalGeographyKey[] = [
  'conus',
  'alaska',
  'hawaii',
  'puerto-rico',
  'served-territory',
  'american-samoa',
  'canada',
  'transboundary',
  'unknown'
];

export const CANONICAL_GEOGRAPHY_LABELS: Readonly<
  Record<CanonicalGeographyKey, string>
> = {
  conus: 'Contiguous United States and District of Columbia',
  alaska: 'Alaska',
  hawaii: 'Hawaii',
  'puerto-rico': 'Puerto Rico',
  'served-territory': 'Guam, Northern Mariana Islands, and U.S. Virgin Islands',
  'american-samoa': 'American Samoa',
  canada: 'Canada',
  transboundary: 'Transboundary selection without country identity',
  unknown: 'Unknown geography'
};

const CONUS_CODES = new Set([
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD',
  'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
]);

const SERVED_TERRITORY_CODES = new Set(['GU', 'MP', 'VI']);

function geographyForPostalCode(code: string): CanonicalGeography | null {
  if (CONUS_CODES.has(code)) {
    return {
      key: 'conus',
      country: 'United States',
      postalCode: code,
      basis: 'boundary-postal-code',
      note: `The selected boundary identifies United States postal code ${code}.`
    };
  }
  if (code === 'AK') {
    return {
      key: 'alaska',
      country: 'United States',
      postalCode: code,
      basis: 'boundary-postal-code',
      note: 'The selected boundary identifies Alaska.'
    };
  }
  if (code === 'HI') {
    return {
      key: 'hawaii',
      country: 'United States',
      postalCode: code,
      basis: 'boundary-postal-code',
      note: 'The selected boundary identifies Hawaii.'
    };
  }
  if (code === 'PR') {
    return {
      key: 'puerto-rico',
      country: 'United States',
      postalCode: code,
      basis: 'boundary-postal-code',
      note: 'The selected boundary identifies Puerto Rico.'
    };
  }
  if (SERVED_TERRITORY_CODES.has(code)) {
    return {
      key: 'served-territory',
      country: 'United States',
      postalCode: code,
      basis: 'boundary-postal-code',
      note: `The selected boundary identifies United States postal code ${code}.`
    };
  }
  if (code === 'AS') {
    return {
      key: 'american-samoa',
      country: 'United States',
      postalCode: code,
      basis: 'boundary-postal-code',
      note: 'The selected boundary identifies American Samoa.'
    };
  }
  return null;
}

function postalCodeOf(context: BoundarySelectionContext): string | null {
  const properties = context.properties;
  if (!properties) return null;
  for (const key of ['STUSPS', 'STATE_ABBR', 'stateCode']) {
    const value = properties[key];
    if (typeof value !== 'string') continue;
    const code = value.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) return code;
  }
  return null;
}

/**
 * Boundary products that are United States-only in this application. This is
 * source provenance, not a claim that the selected representation establishes
 * jurisdiction.
 */
function isUnitedStatesBoundarySource(kind: BoundaryKind): boolean {
  return (
    kind === 'state' ||
    kind === 'aiannh' ||
    kind === 'bia-reservation' ||
    kind === 'ecoregion' ||
    kind === 'watershed'
  );
}

function regionFallback(
  regionKey: RegionKey | null,
  kind: BoundaryKind
): CanonicalGeography {
  switch (regionKey) {
    case 'alaska':
      return {
        key: 'alaska',
        country: 'United States',
        postalCode: 'AK',
        basis: 'region-framing',
        note: 'The selected point uses the Alaska framing fallback.'
      };
    case 'hawaii':
      return {
        key: 'hawaii',
        country: 'United States',
        postalCode: 'HI',
        basis: 'region-framing',
        note: 'The selected point uses the Hawaii framing fallback.'
      };
    case 'british_columbia':
      return {
        key: 'canada',
        country: 'Canada',
        basis: 'region-framing',
        note: 'The selected point uses the British Columbia framing fallback.'
      };
    case 'columbia_snake_basin':
      if (!isUnitedStatesBoundarySource(kind)) {
        return {
          key: 'transboundary',
          country: 'transboundary',
          basis: 'region-framing',
          note:
            'The Columbia and Snake basin framing crosses the international border, and this boundary carries no United States postal code.'
        };
      }
      return {
        key: 'conus',
        country: 'United States',
        basis: 'boundary-source',
        note:
          'The selected boundary comes from a United States-only source inside the transboundary camera framing.'
      };
    case 'washington_state':
    case 'cascades':
    case 'central_oregon':
    case 'southwest_washington':
    case 'south_puget_sound':
    case 'national':
      return {
        key: 'conus',
        country: 'United States',
        basis: 'region-framing',
        note: 'The selected point uses a United States framing fallback.'
      };
    case null:
    default:
      return {
        key: 'unknown',
        country: 'unknown',
        basis: 'unknown',
        note:
          'The selected point has no recognized postal code or coverage framing.'
      };
  }
}

/**
 * Resolve one canonical geography for source policy. Explicit boundary
 * identity wins over camera framing. HTTP success or failure is never used to
 * decide geography.
 */
export function resolveCanonicalGeography(
  context: BoundarySelectionContext
): CanonicalGeography {
  const postalCode = postalCodeOf(context);
  if (postalCode) {
    const explicit = geographyForPostalCode(postalCode);
    if (explicit) return explicit;
  }
  return regionFallback(context.regionKey, context.kind);
}
