/**
 * Editorial camera framings for the region shell (S1; D-0.7.0-039,
 * D-0.7.0-051; the four-round region-selector spike, round 4,
 * 2026-07-15).
 *
 * The nine framings are the ONLY camera vocabulary the shell UI offers
 * (D-0.7.0-039). They are deliberately distinct from two other place
 * vocabularies:
 *
 *   - `RegionKey` (src/config/regions.ts): the curated legacy framings.
 *     NOT widened by this module; old `region=` links stay honored
 *     forever, mapped to camera fits by the S2 URL migration.
 *   - The NIDIS DEWS regional scheme: absent from the 0.7.0 shell
 *     entirely, reserved as a briefing/coverage taxonomy for a later
 *     phase.
 *
 * PROVENANCE (D-0.7.0-051): every framing here is OWNED, AUTHORED
 * geometry; a documented editorial simplification ATNI maintains, made
 * for navigation. These are eco-climatic groupings coarser than EPA
 * Omernik Level I, composed by the maintainer through the spike rounds.
 * They are NOT authoritative boundaries of any kind and no surface may
 * present them as such; the per-entry `provenance` note travels with
 * each definition so consumers can label honestly.
 *
 * A framing is CAMERA-ONLY state (plan 9.11 "framing context"): choosing
 * one fits the viewport and never selects a briefing place, changes the
 * display cluster, or claims data coverage. Coverage honesty is the
 * shell's job (S4): a Mexico click under a US-scoped display must say
 * so.
 *
 * The ALL state is not an editorial framing entry. A user-selected ALL camera
 * serializes as `framing=all` so the North American extent survives reload;
 * null still means no explicit minimap camera and leaves the legacy region
 * path in control.
 *
 * Bounds use the repository's Leaflet order `[[south, west],
 * [north, east]]` (the same convention as `REGIONS`; the conversion to
 * MapLibre order happens at the boundary via `regionToMapLibreBounds`
 * or `leafletBoundsToMapLibre`). Padding is degrees, applied
 * symmetrically at fit time.
 */

/** The nine editorial framing keys (round-4 rebalance: the six
 * eco-climatic regions with Alaska & Northwest split out of Boreal &
 * Arctic along the northern Rockies / Mackenzie Mountains trend, plus
 * Mexico under North American Drought Monitor coverage and the Hawaii
 * enlarged inset). Keys are stable identifiers; S2 owns their URL
 * serialization. */
export type FramingKey =
  | 'alaska-northwest'
  | 'boreal-arctic'
  | 'pacific-coast'
  | 'arid-west'
  | 'plains-prairies'
  | 'eastern-forests'
  | 'southeast-gulf'
  | 'mexico'
  | 'hawaii';

/** Durable minimap camera state. `all` is a camera token, not a shape key. */
export type FramingSelection = FramingKey | 'all' | null;

/** Leaflet-order bounds used by the minimap's explicit ALL camera. */
export const ALL_FRAMING_BOUNDS = [
  [14, -188],
  [84, -52],
] as const;

export interface FramingDef {
  /** Display label (tooltips, assistive names; the minimap drawing
   * itself is label-free for pointer users, D-0.7.0-054). */
  readonly label: string;
  /** Camera fit bounds, Leaflet order [[south, west], [north, east]]. */
  readonly bounds: readonly [
    readonly [number, number],
    readonly [number, number],
  ];
  /** Symmetric fit padding in degrees. */
  readonly padding: number;
  /** The honest label consumers must carry: where this shape came from
   * and what it is not. Required, never empty (D-0.7.0-051). */
  readonly provenance: string;
  /** One-line coverage caution for the shell's honesty surfaces, when a
   * framing extends beyond the US-scoped display layers. */
  readonly coverageNote?: string;
}

/** Convert and pad one framing for a compact MapLibre fit across the dateline. */
export function framingFitBounds(
  framing: Pick<FramingDef, 'bounds' | 'padding'>
): [[number, number], [number, number]] {
  const [[south, west], [north, encodedEast]] = framing.bounds;
  const east = encodedEast < west ? encodedEast + 360 : encodedEast;
  const pad = framing.padding;
  return [
    [west - pad, south - pad],
    [east + pad, north + pad]
  ];
}

const AUTHORED_NOTE =
  'ATNI-authored editorial framing for camera navigation; an owned ' +
  'simplification, not an authoritative boundary of any kind. Coastline ' +
  'presentation is adapted from Natural Earth 1:50m physical land.';

export const FRAMINGS: Record<FramingKey, FramingDef> = {
  'alaska-northwest': {
    label: 'Alaska & Northwest',
    // Split out of Boreal & Arctic (round 4 item 4) along the northern
    // Rockies and Mackenzie Mountains trend: Alaska, Yukon, and
    // northwestern British Columbia as one navigable area of focus.
    // Encoded crossing bounds keep the western Aleutians in the same compact
    // camera fit as Alaska and northwestern Canada.
    bounds: [
      [50.0, 172.0],
      [72.0, -123.0],
    ],
    padding: 1.0,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'US display layers cover Alaska variably; Yukon and British Columbia are outside US-scoped sources. The monthly North American Drought Monitor informs this minimap across Alaska and the Aleutians.',
  },
  'boreal-arctic': {
    label: 'Boreal Northern Canada',
    // East of the Alaska & Northwest divide across contiguous northern
    // Canada. The Arctic Archipelago is deliberately outside this compact
    // navigation framing.
    bounds: [
      [50.0, -141.5],
      [72.0, -52.0],
    ],
    padding: 1.0,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'Mostly outside US-scoped display sources; per-layer status stays honest here. The monthly continental drought summary uses an analysis-mask proxy for Nunavut and is partial in northern Canada.',
  },
  'pacific-coast': {
    label: 'Pacific Coast & Northwest Cascades',
    // Coastal British Columbia through Washington, Oregon, and
    // northwestern California; the Columbia-Fraser sphere.
    bounds: [
      [38.0, -130.5],
      [56.5, -113.5],
    ],
    padding: 0.5,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'British Columbia portions are outside US-scoped display sources. The monthly North American Drought Monitor informs the minimap across the border.',
  },
  'arid-west': {
    label: 'Arid West & Desert Southwest',
    bounds: [
      [31.0, -124.5],
      [44.5, -102.0],
    ],
    padding: 0.5,
    provenance: AUTHORED_NOTE,
  },
  'plains-prairies': {
    label: 'Agricultural Great Plains & Prairies',
    bounds: [
      [33.5, -110.5],
      [55.5, -89.5],
    ],
    padding: 0.5,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'The prairie provinces are outside US-scoped display sources. The monthly North American Drought Monitor informs the minimap across them.',
  },
  'eastern-forests': {
    label: 'Eastern Forests & Great Lakes',
    bounds: [
      [38.0, -95.5],
      [52.0, -52.0],
    ],
    padding: 0.5,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'Ontario, Quebec, and the Maritimes are outside US-scoped display sources. The monthly North American Drought Monitor informs the minimap across Canada.',
  },
  'southeast-gulf': {
    label: 'Southeast & Gulf Coast',
    bounds: [
      [24.4, -100.5],
      [39.0, -74.5],
    ],
    padding: 0.5,
    provenance: AUTHORED_NOTE,
  },
  mexico: {
    label: 'Mexico',
    // Camera-only framing riding North American Drought Monitor coverage.
    // Mexico place catalogs and local briefings remain out of scope. The
    // camera includes the full country extent represented by NADM.
    bounds: [
      [14.0, -119.0],
      [33.0, -86.0],
    ],
    padding: 0.5,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'The current display layers do not cover Mexico. The monthly North American Drought Monitor informs this minimap in Mexico; place selection and local briefings are unavailable.',
  },
  hawaii: {
    label: 'Hawaii',
    // The minimap draws Hawaii as an enlarged inset (round 4 item 6),
    // but clicking it fits the REAL island-chain bounds; kept equal to
    // REGIONS.hawaii so the framing and the legacy region land the same
    // camera (pinned in tests/s1-substrate.spec.ts).
    bounds: [
      [18.5, -160.5],
      [22.5, -154.5],
    ],
    padding: 0.3,
    provenance: AUTHORED_NOTE,
    coverageNote:
      'Layer coverage varies for Hawaii; per-layer status stays honest here. The monthly North American Drought Monitor informs this minimap.',
  },
};

/** The framing keys in the minimap's presentation order (spike round 4:
 * north to south, west to east; Mexico below Arid West and the Plains,
 * Hawaii as the bottom-left inset). */
export const FRAMING_KEYS: readonly FramingKey[] = [
  'alaska-northwest',
  'boreal-arctic',
  'pacific-coast',
  'arid-west',
  'plains-prairies',
  'eastern-forests',
  'southeast-gulf',
  'mexico',
  'hawaii',
];
