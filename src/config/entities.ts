/**
 * The canonical place reference (DDM-P2-T09: "give every selection one
 * canonical place reference").
 *
 * A `PlaceRef` is identity only, never a claim: it names WHICH state, BIA
 * land area, AIANNH area, ecoregion or watershed a selection points at, and
 * says nothing about what condition that place is in (plan_rules: a
 * reference never carries data, severity, or a claim, and blending
 * identity with a claim is exactly what this module refuses to do).
 *
 * A `PlaceRef` is NEVER URL state. There is no place-reference URL
 * parameter and this module adds none (src/state/typed-place.ts:13-18
 * forbids a typed-place or coordinate parameter for the same reason;
 * D-0.7.0-035 ruling 2: a shared link must never disclose a person's
 * selection or location beyond the one-shot `select=` command).
 *
 * `'tribe'` is deliberately absent from `PlaceScheme`: the Tribal Nation
 * subject is a Federal Register roster identity, not a polygon, and
 * DDM-P2-T10 owns building its reference. `placeRefFromBoundary` and
 * `placeRefFromTypedPlace` both return null for it here.
 */

import type { GeoJsonProperties } from 'geojson';

import type { BoundaryKind } from '../impact/types';
import type { TypedPlaceRef } from '../state/typed-place';

/** The five polygon-backed place schemes a selection can canonically name. */
export const PLACE_SCHEMES = Object.freeze([
  'state',
  'bia',
  'aiannh',
  'ecoregion',
  'watershed'
] as const);

/** The union of every valid place scheme, derived from `PLACE_SCHEMES`. */
export type PlaceScheme = (typeof PLACE_SCHEMES)[number];

/** The canonical, durable identity of a selected place: a scheme and its stable code. */
export interface PlaceRef {
  readonly scheme: PlaceScheme;
  readonly code: string;
}

function isPlaceScheme(value: string): value is PlaceScheme {
  return (PLACE_SCHEMES as readonly string[]).includes(value);
}

/** Render a `PlaceRef` as `scheme:code`. Round-trips with `parsePlaceRef`. */
export function formatPlaceRef(ref: PlaceRef): string {
  return `${ref.scheme}:${ref.code}`;
}

/**
 * Parse a `scheme:code` string back into a `PlaceRef`. Null for an unknown
 * scheme, a missing colon, or an empty code; never throws.
 */
export function parsePlaceRef(text: string): PlaceRef | null {
  const separatorIndex = text.indexOf(':');
  if (separatorIndex <= 0) return null;
  const scheme = text.slice(0, separatorIndex);
  const code = text.slice(separatorIndex + 1);
  if (!isPlaceScheme(scheme) || code === '') return null;
  return { scheme, code };
}

/** A string property, or a finite number rendered as its decimal string. Trims; empty is null. */
function readCode(properties: GeoJsonProperties, key: string): string | null {
  if (!properties) return null;
  const value = (properties as Record<string, unknown>)[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Derive a `PlaceRef` from a clicked (or otherwise resolved) boundary
 * feature's own properties, reading the same stable code each layer already
 * promotes to its MapLibre feature id: STUSPS for a state, LARID for a BIA
 * reservation, AIANNHNS for an AIANNH area, US_L4CODE (else US_L3CODE) for
 * an ecoregion. Null for `'tribal'` and `'treaty'` (no stable polygon code
 * carries an identity claim there), for null properties, and when the
 * expected code property is missing or empty.
 */
export function placeRefFromBoundary(
  kind: BoundaryKind,
  properties: GeoJsonProperties
): PlaceRef | null {
  if (!properties) return null;
  switch (kind) {
    case 'state': {
      const code = readCode(properties, 'STUSPS');
      return code ? { scheme: 'state', code } : null;
    }
    case 'bia-reservation': {
      const code = readCode(properties, 'LARID');
      return code ? { scheme: 'bia', code } : null;
    }
    case 'aiannh': {
      const code = readCode(properties, 'AIANNHNS');
      return code ? { scheme: 'aiannh', code } : null;
    }
    case 'ecoregion': {
      const code = readCode(properties, 'US_L4CODE') ?? readCode(properties, 'US_L3CODE');
      return code ? { scheme: 'ecoregion', code } : null;
    }
    case 'watershed': {
      // Not clickable on the map today (no registerClickTarget builds a
      // 'watershed' context; the Place studio catalog is the only door).
      // Reads the same HUC4-else-HUC2 precedence (finer level first) the
      // studio's watershed catalog uses (src/config/place-catalog.ts
      // loadWatershedEntries requests the huc2 and huc4 fields), so a future clickable
      // watershed source would agree with the studio for the same HUC code.
      const code = readCode(properties, 'huc4') ?? readCode(properties, 'huc2');
      return code ? { scheme: 'watershed', code } : null;
    }
    case 'tribal':
    case 'treaty':
      return null;
  }
}

/**
 * Derive a `PlaceRef` from the durable typed-place store's entry. Agrees
 * with `placeRefFromBoundary` for the same underlying code: a state's
 * STUSPS, an ecoregion's EPA code, a watershed's HUC code. Null for
 * `'tribe'` (DDM-P2-T10 owns that reference).
 */
export function placeRefFromTypedPlace(place: TypedPlaceRef): PlaceRef | null {
  switch (place.kind) {
    case 'state':
      return { scheme: 'state', code: place.id };
    case 'ecoregion':
      return { scheme: 'ecoregion', code: place.id };
    case 'watershed':
      return { scheme: 'watershed', code: place.id };
    case 'tribe':
      return null;
  }
}
