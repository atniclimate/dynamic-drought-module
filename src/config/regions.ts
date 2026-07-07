import type { Region } from '../types/region';

/**
 * Region keys for the Pacific Northwest (PNW) framings shipped with the
 * Dynamic Drought Module (DDM). Defined as a string union here rather than
 * the open `string` alias from `../types/region` so consumers get
 * autocompletion and exhaustiveness checks.
 */
export type RegionKey =
  | 'washington_state'
  | 'columbia_snake_basin'
  | 'cascades'
  | 'central_oregon'
  | 'southwest_washington'
  | 'south_puget_sound'
  | 'national'
  | 'alaska'
  | 'hawaii';

export type { Region } from '../types/region';

/**
 * Region bounding boxes in WGS 84.
 *
 * Bounds are stored in Leaflet's `[[south, west], [north, east]]` order even
 * though MapLibre GL JavaScript uses `[west, south, east, north]`. This
 * keeps the table readable as a direct port of the vanilla baseline; the
 * conversion to MapLibre order happens at the boundary in
 * `regionToMapLibreBounds()` (and the equivalent helper in
 * `src/util/bbox.ts`). Padding is in degrees and is applied symmetrically
 * when fitting the bounds.
 *
 * Note on `central_oregon`: the framing prioritizes the Deschutes basin and
 * the named telemetry stations (Madras, Powell Butte, Wickiup, Deschutes at
 * Moody) which sit east of the Cascades. The north bound was bumped from
 * 45.6 to 45.65 in v0.1.2 so that the Deschutes at Moody station (latitude
 * 45.622) is inside the raw bounds rather than only the padded fit. Do not
 * reduce 45.65 without re-verifying that constraint.
 */
export const REGIONS: Record<RegionKey, Region> = {
  washington_state: {
    label: 'Washington State',
    short: 'WA State',
    bounds: [[45.5435, -124.7630], [49.0024, -116.9159]],
    padding: 0.15,
    description: 'Statewide climatological framing.',
    briefing: { kind: 'state', id: 'WA', label: 'Washington' }
  },
  columbia_snake_basin: {
    label: 'Columbia & Snake River Basin',
    short: 'Columbia/Snake',
    bounds: [[45.3453, -126.1675], [50.2225, -111.0435]],
    padding: 0.25,
    description: '259,000 sq mi drainage across seven states.'
  },
  cascades: {
    label: 'Western & Northern Cascades',
    short: 'Cascades',
    bounds: [[46.5, -122.5], [49.0, -120.5]],
    padding: 0.10,
    description: 'High-elevation snowpack & runoff zone.'
  },
  central_oregon: {
    label: 'Central Oregon',
    short: 'Central OR',
    bounds: [[43.5, -122.0], [45.65, -120.3]],
    padding: 0.15,
    description: 'Deschutes basin & ag water demand.',
    // Sub-state framing; the briefing describes the containing state (Oregon),
    // which the panel title and the trigger label both name.
    briefing: { kind: 'state', id: 'OR', label: 'Oregon' }
  },
  southwest_washington: {
    label: 'Southwest Washington',
    short: 'SW WA',
    bounds: [[45.5, -124.3], [47.0, -122.0]],
    padding: 0.10,
    description: 'Lower Columbia estuary & coast.',
    briefing: { kind: 'state', id: 'WA', label: 'Washington' }
  },
  south_puget_sound: {
    label: 'South Puget Sound',
    short: 'S. Puget Sound',
    bounds: [[46.9, -123.2], [47.5, -122.1]],
    padding: 0.10,
    description: 'Inland marine waters & WRIAs.',
    briefing: { kind: 'state', id: 'WA', label: 'Washington' }
  },
  national: {
    // The national explore framing (E1 of the national roadmap). The curated
    // PNW framings above remain the deployment's identity and default; this
    // entry lets a user pull back to the contiguous United States, where the
    // national layers (USDM, NIFC, WHP, BIA AIAN-LAR, gridded SPI) already
    // cover the whole view. The bundled telemetry stations and the ecoregion
    // tile bundle remain PNW-scoped for now; their status pills stay honest
    // outside the PNW.
    label: 'United States',
    short: 'US',
    bounds: [[24.4, -125.0], [49.4, -66.9]],
    padding: 0.5,
    description: 'Contiguous United States explore framing.'
  },
  alaska: {
    // The west bound stops short of the Aleutian antimeridian crossing;
    // geometryBbox in src/impact/context.ts does not normalize longitudes
    // across it (documented there), and the mainland framing serves the
    // planning use case.
    label: 'Alaska',
    short: 'AK',
    bounds: [[51.0, -170.0], [71.5, -129.5]],
    padding: 1.0,
    description: 'Alaska statewide framing; layer coverage varies.',
    briefing: { kind: 'state', id: 'AK', label: 'Alaska' }
  },
  hawaii: {
    label: 'Hawaii',
    short: 'HI',
    bounds: [[18.5, -160.5], [22.5, -154.5]],
    padding: 0.3,
    description: 'Hawaiian Islands framing; layer coverage varies.',
    briefing: { kind: 'state', id: 'HI', label: 'Hawaii' }
  }
};

/**
 * Default region key used when no `region` URL parameter is present.
 */
export const DEFAULT_REGION: RegionKey = 'washington_state';

/**
 * Convert a Region's Leaflet-shaped bounds (`[[south, west], [north, east]]`)
 * to the MapLibre GL JavaScript order (`[west, south, east, north]`) that
 * `Map.fitBounds()` and `LngLatBounds` accept.
 */
export function regionToMapLibreBounds(
  region: Region
): [number, number, number, number] {
  const [[south, west], [north, east]] = region.bounds;
  return [west, south, east, north];
}
