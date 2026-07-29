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

import type { CoverageFamilyKey } from './capability-matrix';

/**
 * Selector grouping for the region list (0.8.0 T-M0-4, the N4a substrate;
 * the "group field" of docs/EXPANSION_PLAN_070.md). DISTINCT from
 * `coverageFamily`: grouping is a user-facing selector concept, coverage
 * family is capability truth, and two regions may share one capability row
 * while belonging to different groups. Today: 'pnw' for the six curated
 * Pacific Northwest framings (the deployment identity), 'explore' for the
 * pull-back framings (national, alaska, hawaii). The ratified NIDIS Drought
 * Early Warning System (DEWS) groups join at N4b; nothing renders grouping
 * yet (the grouped selector is N4b's visible change). 'canada' is the
 * British Columbia display grouping added by U7.
 */
export type RegionGroup = 'pnw' | 'explore' | 'canada';

/**
 * Which drought-monitor edition covers (part of) a region's identity
 * geography upstream, and at what cadence. This states UPSTREAM coverage
 * truth about the named scope; it does NOT state module capability (that
 * is the coverage/capability matrix: the US Drought Monitor covers Alaska
 * upstream while the module's ak-hi droughtState remains 'none').
 *
 *   source   'usdm' = the US Drought Monitor (weekly);
 *            'cdm'  = the Canadian Drought Monitor (monthly). 'cdm' is a
 *            union member for the N6 mixed-edition seam; no shipped region
 *            carries a 'cdm' row today (no claim is made);
 *            'bc-basin' = the Province of British Columbia basin drought
 *            levels, updated weekly during the core drought season.
 *   scope    'full' when the edition covers the whole identity geography;
 *            'us-portion' when the identity geography deliberately includes
 *            Canadian land the edition does not cover (the Columbia and
 *            Snake basin reaches into British Columbia). Camera bounds that
 *            merely pad across the border do not change scope; scope is
 *            about the geography the framing is OF, not the pixels it
 *            shows.
 */
export interface RegionSourceEdition {
  readonly source: 'usdm' | 'cdm' | 'bc-basin';
  readonly cadence: 'weekly' | 'weekly-in-season' | 'monthly';
  readonly scope: 'full' | 'us-portion';
}

export interface Region {
  readonly label: string;
  readonly short: string;
  readonly bounds: readonly [readonly [number, number], readonly [number, number]];
  readonly padding: number;
  readonly description: string;
  /** Optional boundary for the keyboard-reachable impact briefing (#9). */
  readonly briefing?: RegionBriefingAnchor;
  /** Selector grouping; see `RegionGroup`. Nothing renders this yet. */
  readonly group: RegionGroup;
  /**
   * The coverage/capability-matrix row this region reads its capability
   * truth from (`regionCapabilityLevel` in src/config/region-capability.ts).
   * Honest disablement (M-BREADTH) will consult it; nothing does yet.
   */
  readonly coverageFamily: CoverageFamilyKey;
  /** Upstream drought-monitor edition coverage; see `RegionSourceEdition`. */
  readonly sourceEditions: readonly RegionSourceEdition[];
  /**
   * United States Postal Service codes of the states the framing's
   * identity geography lies within, populated ONLY where that is
   * enumerable without inference (a single-state framing). OMITTED means
   * "not enumerated here", never "no states": the Columbia and Snake
   * basin's membership is deliberately not inferred (fuzzy basin
   * membership; docs/EXPANSION_PLAN_070.md), and the national framing's
   * identity is the contiguous United States as a whole.
   */
  readonly memberStates?: readonly string[];
}

export type RegionKey = string;
