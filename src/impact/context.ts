/**
 * Build a `BoundarySelectionContext` from a clicked map feature.
 *
 * Each boundary layer's registered click target (the
 * InteractionCoordinator's `respond`) has the committed feature's
 * properties and geometry plus the click `lngLat`. This module turns that into
 * the typed context the briefing composer consumes: it resolves a display
 * title per boundary kind, attaches the representation caveat for Tribal and
 * Treaty boundaries (CLAUDE.md section 2), derives a bounding box from the
 * feature geometry for later query clipping, carries a compact service
 * envelope for antimeridian crossings, and reads the active region key from
 * the shared region store.
 *
 * Identifying the land is step 1 of the land-resource-analyst flow
 * (docs/KERNEL_INTEGRATION_CONTINUATION.md section 12).
 */

import type { GeoJsonProperties, Geometry, Position } from 'geojson';

import { getCurrentRegion } from '../state/region-store';
import {
  geometryBboxAcrossAntimeridian,
  geometryLikelyCrossesAntimeridian
} from '../util/antimeridian';
import type { BoundaryKind, BoundarySelectionContext } from './types';

/**
 * The representation caveat carried for sovereign-jurisdiction boundaries.
 * Mirrors the language in the BIA and Treaty popups; preserved in every panel
 * built from such a selection (CLAUDE.md section 2, hard rule honored in
 * popups.ts).
 */
const REPRESENTATION_CAVEAT =
  "This boundary is an administrative representation for general spatial reference, not a definitive depiction of Tribal jurisdiction. Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority.";

const KIND_LABEL: Record<BoundaryKind, string> = {
  ecoregion: 'EPA Omernik ecoregion',
  tribal: 'Tribal Lands (deployer data)',
  // AIANNH spans legal and statistical geographies; the neutral product name is
  // the honest label for the briefing subtitle (the per-feature legal-vs-
  // statistical distinction is drawn in the popup by AIANNHCC, never here as a
  // jurisdiction claim).
  aiannh: 'Tribal Lands (US Census AIANNH)',
  treaty: 'Historical Treaty area',
  'bia-reservation': 'BIA reservation boundary (AIAN-LAR)',
  state: 'State (Census cartographic boundary)',
  watershed: 'Watershed (USGS Watershed Boundary Dataset)'
};

/** First non-empty string property among `keys`, else null. */
function firstString(
  props: GeoJsonProperties,
  keys: readonly string[]
): string | null {
  if (!props) return null;
  for (const key of keys) {
    const v = (props as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Resolve the display title for a selection by boundary kind. */
function resolveTitle(kind: BoundaryKind, props: GeoJsonProperties): string {
  switch (kind) {
    case 'ecoregion':
      return firstString(props, ['US_L4NAME', 'US_L3NAME', 'NA_L3NAME', 'name']) ?? 'Ecoregion';
    case 'tribal':
      return (
        firstString(props, ['LARName', 'LARNAME', 'NAME', 'name', 'TRIBE', 'RESERV_NAM']) ??
        'Tribal land area'
      );
    case 'aiannh':
      // US Census AIANNH: NAME carries the area name (BASENAME the descriptor-
      // stripped form). Never presented as the Tribe's own name for itself.
      return firstString(props, ['NAME', 'BASENAME', 'name']) ?? 'Tribal land area';
    case 'treaty':
      return (
        firstString(props, ['name', 'TREATY_NAM', 'TREATY_NAME', 'TreatyName', 'NAME', 'Treaty']) ??
        'Treaty area'
      );
    case 'bia-reservation':
      return firstString(props, ['LARNAME', 'LARName', 'NAME', 'name']) ?? 'Reservation land area';
    case 'state':
      return firstString(props, ['NAME', 'name', 'STUSPS']) ?? 'State';
    case 'watershed':
      return firstString(props, ['name', 'NAME']) ?? 'Watershed';
  }
}

/**
 * The display title a boundary click resolves for a feature, exposed so
 * the InteractionCoordinator can label a not-yet-committed hit in its
 * "Other map features here" disclosure without building the full
 * selection context (no geometry walk).
 */
export function resolveBoundaryTitle(
  kind: BoundaryKind,
  props: GeoJsonProperties
): string {
  return resolveTitle(kind, props);
}

/**
 * Walk a GeoJSON geometry's coordinates into a `[west, south, east, north]`
 * bounding box. Returns null for geometries without positional coordinates
 * (an empty geometry or a `GeometryCollection`, which the boundary layers do
 * not emit). Longitudes are not normalized across the antimeridian; the PNW
 * framings do not cross it. For a crossing geometry the walk smears into a
 * near-world-spanning box whose true extent is NOT recoverable from the box
 * alone. `buildBoundaryContext` preserves this compatibility bbox and carries
 * the geometry-derived compact envelope separately for services that must
 * cover the complete selection.
 */
export function geometryBbox(
  geometry: Geometry | undefined | null
): [number, number, number, number] | null {
  if (!geometry || geometry.type === 'GeometryCollection') return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    // A coordinate position is [lng, lat, ...]; recurse otherwise.
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lng, lat] = node as Position;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const child of node) visit(child);
  };

  visit((geometry as { coordinates?: unknown }).coordinates);

  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return [west, south, east, north];
}

/**
 * Compose the selection context. `properties` and `geometry` come from the
 * clicked MapLibre feature; `lngLat` is the click location. A `titleOverride`
 * lets a layer that already resolved the feature name (the Treaty layer) reuse
 * it rather than re-deriving.
 */
export function buildBoundaryContext(
  kind: BoundaryKind,
  properties: GeoJsonProperties,
  geometry: Geometry | undefined | null,
  lngLat: { lng: number; lat: number },
  titleOverride?: string
): BoundarySelectionContext {
  const title = titleOverride && titleOverride.trim() !== '' ? titleOverride : resolveTitle(kind, properties);
  const bbox = geometryBbox(geometry);
  const crossesAntimeridian = bbox ? geometryLikelyCrossesAntimeridian(geometry) : false;
  // N2-A consumes the T-M0-4 crossing evidence. The compatibility bbox stays
  // the naive walk, while every geometry-backed service receives a complete
  // circular envelope and never reconstructs one from lost min/max endpoints.
  const serviceBbox = bbox
    ? geometryBboxAcrossAntimeridian(geometry)
    : null;
  return {
    kind,
    title,
    properties: (properties as Readonly<Record<string, unknown>> | null) ?? null,
    lngLat: { lng: lngLat.lng, lat: lngLat.lat },
    ...(bbox ? { bbox } : {}),
    ...(serviceBbox ? { serviceBbox } : {}),
    ...(crossesAntimeridian ? { bboxCrossesAntimeridian: true } : {}),
    regionKey: getCurrentRegion()
  };
}

/** The kind label for a selection, for the panel's land subtitle. */
export function kindLabel(kind: BoundaryKind): string {
  return KIND_LABEL[kind];
}

/** Whether a boundary kind carries the representation caveat. */
export function caveatFor(kind: BoundaryKind): string {
  // Ecoregions are ecological classifications, states are public
  // administrative boundaries, and watersheds are hydrologic landscape
  // units; none is a sovereign-jurisdiction representation, so none
  // carries the caveat.
  return kind === 'ecoregion' || kind === 'state' || kind === 'watershed'
    ? ''
    : REPRESENTATION_CAVEAT;
}
