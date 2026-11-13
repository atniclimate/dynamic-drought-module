/**
 * Exact selected-place resolution policy for the baked landscape signature.
 *
 * Kept separate from the artifact loader so an unsupported boundary can reach
 * its honest unavailable state without downloading the consumer JavaScript or
 * the 531 kB artifact.
 */

import { CAPABILITY_AXIS_LABELS } from '../config/capability-matrix';
import type { CanonicalGeography } from '../config/geography';
import { placeCapabilityNote } from '../config/place-coverage';
import type { BoundarySelectionContext } from './types';

export interface LandscapeEcoregionKey {
  readonly level: 3 | 4;
  readonly code: string;
}

export type LandscapeSelectionResolution =
  | {
      readonly ok: true;
      readonly key: LandscapeEcoregionKey;
    }
  | {
      readonly ok: false;
      readonly note: string;
    };

export const UNSUPPORTED_LANDSCAPE_SELECTION_NOTE =
  'The shipped landscape signature is indexed by EPA Omernik ecoregion. This selected boundary does not resolve to one exact bundle, so DDM does not substitute a centroid or click point.';

export const UNKEYED_ECOREGION_LANDSCAPE_NOTE =
  'This ecoregion selection does not carry an EPA Level III or Level IV code, so it cannot be matched to the baked signature.';

function textProperty(
  properties: BoundarySelectionContext['properties'],
  key: string
): string | null {
  const value = properties?.[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Resolve only the exact issuer key carried by an ecoregion selection. */
export function selectedLandscapeEcoregion(
  context: BoundarySelectionContext
): LandscapeEcoregionKey | null {
  if (context.kind !== 'ecoregion') return null;
  const level4 = textProperty(context.properties, 'US_L4CODE');
  if (level4) return { level: 4, code: level4 };
  const level3 = textProperty(context.properties, 'US_L3CODE');
  return level3 ? { level: 3, code: level3 } : null;
}

/** The Landscape context section draws only for an ecoregion selection, the one place the signature is indexed by. */
export function landscapeContextShown(context: BoundarySelectionContext): boolean {
  return context.kind === 'ecoregion';
}

/**
 * Any other place lists the signature among the sources that do not cover it
 * (DR-256, B2), with the place's own capability note and no instruction.
 */
export function landscapeUncoveredGroup(
  context: BoundarySelectionContext,
  geography: CanonicalGeography
): { readonly labels: readonly string[]; readonly note: string } | null {
  if (landscapeContextShown(context)) return null;
  return {
    labels: [CAPABILITY_AXIS_LABELS.landscapeSignature],
    note: placeCapabilityNote(geography, 'landscapeSignature')
  };
}

export function resolveLandscapeSelection(
  context: BoundarySelectionContext
): LandscapeSelectionResolution {
  if (context.kind !== 'ecoregion') {
    return { ok: false, note: UNSUPPORTED_LANDSCAPE_SELECTION_NOTE };
  }
  const key = selectedLandscapeEcoregion(context);
  return key
    ? { ok: true, key }
    : { ok: false, note: UNKEYED_ECOREGION_LANDSCAPE_NOTE };
}
