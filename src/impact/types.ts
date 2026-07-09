/**
 * Typed content model for the clickable drought-impact briefing.
 *
 * The kernel-integration headline feature turns a boundary selection (an
 * ecoregion, a Tribal Lands placeholder feature, a Treaty area, or a Bureau
 * of Indian Affairs (BIA) reservation boundary) into a sourced read of the
 * land, the drought's impacts across three temporal horizons (wildfire and
 * extreme heat foregrounded), and the public resources to route to it.
 *
 * The model is deliberately separated from the panel rendering: this file and
 * the rest of `src/impact/` turn data into claims; `src/ui/impact-panel.ts`
 * turns claims into DOM. That split keeps the analysis honest (every claim
 * carries its source) and the rendering dumb (it never invents a value).
 *
 * Doctrine: ddm-drought-impact-modeling (#6) owns the temporal framing and the
 * index-to-impact translation; ddm-tribal-context-threading (#9) owns the
 * resource routing and the stewardship order; ddm-enso-correlation (#7)
 * supplies the long-range modifier. See docs/KERNEL_INTEGRATION_CONTINUATION.md
 * sections 5, 6, and 12.
 */

import type { RegionKey } from '../config/regions';
import type { LocationIdentity } from '../state/location-identity';

/**
 * One sourced statement in a horizon. `kind` separates an observation (a fact
 * about current conditions, stated plainly) from an outlook (a probability or
 * tendency, never rendered as a fact); the panel styles and labels them
 * differently so a forecast can never read as a certainty (CLAUDE.md section 6
 * invariant 6; the honest-feedback rule).
 */
export interface SourcedClaim {
  /** The statement itself. Rendered through `escapeHtml`. */
  readonly text: string;
  /** Human-readable source name, for example "U.S. Drought Monitor". */
  readonly source: string;
  /** Optional `https://` link to the source; only https is rendered. */
  readonly sourceUrl?: string;
  /** Observation = current fact stated plainly; outlook = probability/tendency. */
  readonly kind: 'observation' | 'outlook';
  /**
   * Optional inline SVG chart (from `src/ui/charts.ts`) rendered beneath the
   * claim text. Trusted, self-generated markup; never user-supplied.
   */
  readonly chartSvg?: string;
}

/**
 * Per-horizon load state.
 *
 *   loading      data is being fetched
 *   ready        all expected sources answered
 *   partial      some sources answered, at least one was unavailable
 *   unavailable  no source answered; the horizon says so honestly
 */
export type HorizonStatus = 'loading' | 'ready' | 'partial' | 'unavailable';

/** Stable keys for the three temporal horizons. */
export type HorizonKey = 'current' | 'nearTerm' | 'longRange';

/**
 * One temporal horizon section of the briefing. Wildfire and extreme heat are
 * foregrounded inside `claims`, not modeled as separate fields, so the
 * ordering of claims (drought state, then wildfire, then heat, then water)
 * carries the foregrounding.
 */
export interface Horizon {
  readonly key: HorizonKey;
  /** Section heading, for example "Current conditions". */
  readonly title: string;
  /** Short definition of the time window, for example "now". */
  readonly subtitle: string;
  claims: SourcedClaim[];
  status: HorizonStatus;
  /**
   * Optional honest note shown when the horizon is unavailable or partial,
   * for example "The near-term temperature outlook source did not respond."
   */
  note?: string;
}

/**
 * Resource tiers, in stewardship order. The order is itself a statement:
 * Tribal sovereignty is primary, external resources supplementary
 * (ddm-tribal-context-threading).
 *
 *   tribe-own      the deployer-populated Tribe's-own-resources slot (first)
 *   federal        federal regional context (drought.gov, USDM, USDA relief)
 *   state          state regional context, plainly attributed to the agency
 *   bia-regional   the BIA regional resource, keyed off the AIAN-LAR REGION
 */
export type ResourceTier = 'tribe-own' | 'federal' | 'state' | 'bia-regional';

/**
 * One routed resource link. `url` is optional: the Tribe's-own slot is empty
 * by default and renders a "populate in data/README.md" affordance rather
 * than a link, mirroring the empty-FeatureCollection placeholder pattern.
 * Only `https://` URLs are rendered as anchors.
 */
export interface ResourceLink {
  readonly label: string;
  readonly url?: string;
  /** The agency that owns the resource; always shown, plainly attributed. */
  readonly agency: string;
  readonly tier: ResourceTier;
  /** Optional one-line description of what the resource offers. */
  readonly description?: string;
}

/** The kind of boundary that was selected; drives the land title and caveat. */
export type BoundaryKind = 'ecoregion' | 'tribal' | 'treaty' | 'bia-reservation' | 'state';

/**
 * The context handed from a boundary click to the briefing composer. Carries
 * the clicked feature's identity (kind, title, raw properties), the click
 * location, an optional bounding box derived from the feature geometry (used
 * to clip live queries in Phase 3), and the active region key (for resource
 * framing).
 */
export interface BoundarySelectionContext {
  readonly kind: BoundaryKind;
  /** Display title, for example the ecoregion name or the reservation LARNAME. */
  readonly title: string;
  /** The clicked feature's raw GeoJSON properties (may be null). */
  readonly properties: Readonly<Record<string, unknown>> | null;
  /** Click location in WGS 84. */
  readonly lngLat: { readonly lng: number; readonly lat: number };
  /** Feature bounding box `[west, south, east, north]`, when derivable. */
  readonly bbox?: readonly [number, number, number, number];
  /** Active region key, or null if no region is selected yet. */
  readonly regionKey: RegionKey | null;
  /**
   * The resolved location identity for `lngLat` (state, ecoregion, containing
   * Tribal land; county null this phase). Optional and set asynchronously by
   * the R1 wiring after the boundary context is built (D-0.6.0-009); a context
   * without it degrades to the region-fallback resource routing.
   */
  readonly identity?: LocationIdentity;
}

/**
 * The full composed briefing the panel renders. `landCaveat` carries the
 * representation caveat for Tribal and Treaty boundaries (preserved in every
 * panel per CLAUDE.md section 2); it is empty for an ecoregion.
 */
export interface ImpactBriefing {
  readonly context: BoundarySelectionContext;
  readonly landTitle: string;
  /** A short kind label, for example "BIA reservation boundary". */
  readonly landKind: string;
  /** The representation caveat, or empty string when none applies. */
  readonly landCaveat: string;
  readonly horizons: {
    current: Horizon;
    nearTerm: Horizon;
    longRange: Horizon;
  };
  resources: ResourceLink[];
}
