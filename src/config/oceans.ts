/**
 * Schematic ocean zones for the region shell minimap (S1; D-0.7.0-042,
 * D-0.7.0-051, D-0.7.0-053; spike round 4 item 7).
 *
 * The Pacific, Arctic, and Atlantic ocean views ENTER THE ENSO
 * CLUSTER: choosing one switches
 * the display to the sea-surface-temperature anomaly surface AND frames
 * the camera to that ocean in one gesture (the only gesture that pairs
 * display with camera; D-0.7.0-053). Framing context and briefing place
 * are untouched; a hazard-cluster button switches back; returning to
 * ENSO later restores the temporal register; leaving ENSO restores the
 * camera from before entering (F9, src/map/enso-camera.ts).
 *
 * The Pacific and Atlantic zones on the minimap are clickable; all three
 * views stay in the framing dropdown's 'Ocean views' group
 * (src/ui/sidebar.ts).
 *
 * PROVENANCE (D-0.7.0-051): these zones are SCHEMATIC UI AFFORDANCES.
 * They claim nothing about real ocean boundaries; they exist so a
 * pointer, keyboard, or touch user can honestly name and reach the
 * three ocean camera framings. No verified geometry source is needed or
 * implied. Oceans have no place specifics, so the place studio
 * deliberately excludes them.
 *
 * Bounds use the repository's Leaflet order [[south, west],
 * [north, east]], converted at the boundary like every other camera
 * fit. The Pacific framing deliberately includes the Nino 3.4 index
 * region (5S to 5N, 170W to 120W): the index box is a place, and its
 * on-map annotation renders only when the Pacific is in frame
 * (D-0.7.0-053; on other views the display description names the ENSO
 * state in prose).
 */

export type OceanKey = 'pacific' | 'arctic' | 'atlantic';

export interface OceanDef {
  /** The ocean view's option text in the framing dropdown. */
  readonly label: string;
  /** Camera fit bounds, Leaflet order [[south, west], [north, east]]. */
  readonly bounds: readonly [readonly [number, number], readonly [number, number]];
  /** Symmetric fit padding in degrees. */
  readonly padding: number;
  /**
   * [lng, lat] the camera centres on when the fit would need a zoom below the
   * map's floor (a small embed): MapLibre would otherwise clamp around the
   * bounds' centre and push the Nino 3.4 box off the frame.
   */
  readonly floorCentre?: readonly [number, number];
  /** The honest label consumers must carry (D-0.7.0-051). */
  readonly provenance: string;
}

const SCHEMATIC_NOTE =
  'Schematic click affordance for camera navigation; not a boundary of ' +
  'any kind.';

export const OCEANS: Record<OceanKey, OceanDef> = {
  pacific: {
    label: 'Pacific Ocean',
    // Southern bound reaches below the equator so the Nino 3.4 region
    // (5S to 5N, 170W to 120W) is inside the fit, per D-0.7.0-053.
    // The west bound stays inside -180 to avoid the antimeridian
    // normalization gap documented at REGIONS.alaska.
    bounds: [[-10.0, -179.9], [62.0, -110.0]],
    padding: 1.0,
    // Nino 3.4 centre, nudged to 8N so the equator band and Hawaii both show.
    floorCentre: [-145, 8],
    provenance: SCHEMATIC_NOTE
  },
  arctic: {
    label: 'Arctic Ocean',
    // A Mercator-honest fit this far north is approximate by nature;
    // the zone exists to name and reach the high-latitude anomaly
    // view, not to bound the ocean.
    bounds: [[60.0, -179.9], [85.0, -30.0]],
    padding: 1.0,
    provenance: SCHEMATIC_NOTE
  },
  atlantic: {
    label: 'Atlantic Ocean',
    bounds: [[8.0, -82.0], [55.0, -15.0]],
    padding: 1.0,
    provenance: SCHEMATIC_NOTE
  }
};

export const OCEAN_KEYS: readonly OceanKey[] = ['pacific', 'arctic', 'atlantic'];

/** Ocean zones the minimap draws and makes clickable. The Arctic stays a
 * dropdown and deep-link view only: the minimap is for the Pacific and
 * Atlantic (owner, 2026-10-19). */
export const MINIMAP_OCEAN_KEYS = ['pacific', 'atlantic'] as const satisfies readonly OceanKey[];
export type MinimapOceanKey = (typeof MINIMAP_OCEAN_KEYS)[number];
