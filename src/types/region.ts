/**
 * Region: a named PNW (or future-regional) framing for the map.
 *
 * The `bounds` field is intentionally in Leaflet's `[[south, west], [north, east]]`
 * order even though MapLibre uses `[west, south, east, north]`. This keeps the
 * config blocks ports cleanly from the vanilla baseline; conversion happens
 * at the boundary in `regionToMapLibreBounds()` (see src/config/regions.ts).
 *
 * `padding` is in degrees and is applied symmetrically when fitting the bounds.
 */
/**
 * An optional boundary a region maps to for its keyboard-reachable drought
 * impact briefing (critical-review #9). The impact briefing is boundary based
 * (a region is only a viewport), so a region that sits inside a single
 * briefable boundary names it here; a region spanning several states (or the
 * national framing) carries no anchor and shows no briefing trigger.
 */
export interface RegionBriefingAnchor {
  /**
   * The boundary kind the briefing opens. Only 'state' is wired today (the one
   * bundled boundary with a briefing path); the field leaves room for more.
   */
  readonly kind: 'state';
  /** The boundary identifier (a two-letter USPS state code for kind 'state'). */
  readonly id: string;
  /**
   * Human label of the boundary the briefing describes, shown on the trigger.
   * For a sub-state region this names the CONTAINING state, so the button and
   * the panel's own title agree on the land being described.
   */
  readonly label: string;
}

export interface Region {
  readonly label: string;
  readonly short: string;
  readonly bounds: readonly [readonly [number, number], readonly [number, number]];
  readonly padding: number;
  readonly description: string;
  /** Optional boundary for the keyboard-reachable impact briefing (#9). */
  readonly briefing?: RegionBriefingAnchor;
}

export type RegionKey = string;
