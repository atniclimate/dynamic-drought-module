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
import type { BriefingSourcePolicy } from './source-policy';
import type { LayerStatus } from '../types/layer';

/**
 * What kind of knowledge a claim rests on (the 0.8.0 evidence/claim contract,
 * T-P0-2). The class drives the badge label and styling through the single
 * mapping in `src/impact/evidence.ts`, so a modeled or derived read can never
 * wear observation styling. Class meanings are documented on that mapping.
 */
export type EvidenceClass =
  | 'observed'
  | 'analyzed'
  | 'classified'
  | 'modeled-analysis'
  | 'modeled'
  | 'derived'
  | 'outlook';

/**
 * The dates a claim carries, all ISO 8601 (`YYYY-MM-DD`). The shown line uses
 * the precedence valid, else issued, else published, else retrieved (see
 * `claimDateLine` in `src/impact/evidence.ts`). Live fetches set `retrieved`
 * to the fetch date; fixed prose claims set `retrieved` to the date their
 * source statement was last verified.
 */
export interface ClaimDates {
  /** When the source published the underlying product. */
  readonly published?: string;
  /** The date the value is valid for (for example a USDM map date). */
  readonly valid?: string;
  /** When the source issued the product (for example a forecast issue date). */
  readonly issued?: string;
  /** When DDM retrieved the value (fetch date or snapshot build date). */
  readonly retrieved?: string;
}

/** The spatial support a claim's value actually has, stated honestly. */
export interface ClaimSupport {
  /** The source data's native support, for example "4 km gridMET cell". */
  readonly native?: string;
  /** The effective support after any resampling or aggregation. */
  readonly effective?: string;
  /** What the claim reports over, for example "statewide" or "basin forecast point". */
  readonly reporting?: string;
}

/**
 * A claim's uncertainty, shown rather than smoothed. `not-quantified` is the
 * explicit honest state for a source that publishes no uncertainty.
 */
export interface ClaimUncertainty {
  readonly kind: 'range' | 'typical' | 'categorical' | 'not-quantified';
  readonly text: string;
}

/** Method provenance: version, climatological baseline, source vintage. */
export interface ClaimMethod {
  readonly version?: string;
  readonly baseline?: string;
  readonly sourceVintage?: string;
}

/**
 * One sourced statement in a horizon, under the evidence/claim contract
 * (T-P0-2): every claim names its evidence class and carries its dates.
 * Build claims ONLY through `makeClaim` in `src/impact/evidence.ts`; the
 * legacy `kind` is derived there from `evidence` and never set independently.
 */
export interface SourcedClaim {
  /** The statement itself. Rendered through `escapeHtml`. */
  readonly text: string;
  /** Human-readable source name, for example "U.S. Drought Monitor". */
  readonly source: string;
  /** Optional `https://` link to the source; only https is rendered. */
  readonly sourceUrl?: string;
  /** What kind of knowledge the statement rests on. Required; set truthfully. */
  readonly evidence: EvidenceClass;
  /**
   * Legacy compatibility tone, DERIVED from `evidence` by `makeClaim`
   * (observation for observed/analyzed/classified; outlook for the
   * model-borne and forward classes). The renderer styles from `evidence`.
   */
  readonly kind: 'observation' | 'outlook';
  /** The claim's dates (ISO 8601); every construction site sets at least one. */
  readonly dates?: ClaimDates;
  /** The spatial support of the value, when it matters to honesty. */
  readonly support?: ClaimSupport;
  /** The claim's uncertainty, or the explicit not-quantified state. */
  readonly uncertainty?: ClaimUncertainty;
  /** Method provenance (version, baseline, source vintage). */
  readonly method?: ClaimMethod;
  /** For derived reads: the inputs the derivation stands on, in order. */
  readonly lineage?: readonly string[];
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

/** One dated source behind a landscape-context fact. */
export interface LandscapeContextSource {
  /** Stable artifact source key, for example `terrain` or `soilMukey`. */
  readonly key: string;
  readonly label: string;
  readonly url?: string;
  readonly vintage: string;
  readonly acquired?: string;
  readonly methodVersion: number;
}

/** One readable family from the baked ecoregion signature. */
export interface LandscapeContextFact {
  readonly key: 'terrain' | 'soil' | 'landcover' | 'fuels';
  readonly label: string;
  readonly text: string;
  /** A family-specific honesty qualification shown directly with the fact. */
  readonly note?: string;
}

/**
 * The lazy landscape-signature read shown beside the temporal briefing.
 *
 * It is context, never an observation or current-condition claim. Only an
 * EPA Omernik ecoregion selection resolves directly to one baked bundle.
 * Other boundary kinds use the explicit unavailable state rather than a
 * centroid, click point, or silent polygon-to-point substitution.
 */
export interface LandscapeContext {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly note?: string;
  readonly ecoregion?: {
    readonly level: 3 | 4;
    readonly code: string;
    readonly name: string;
  };
  readonly support?: string;
  readonly artifactDate?: string;
  readonly analysisCrs?: string;
  readonly gridResolutionMeters?: number;
  readonly facts: readonly LandscapeContextFact[];
  readonly sources: readonly LandscapeContextSource[];
}

export type PointHeatMetricKey =
  | 'temperature'
  | 'relativeHumidity'
  | 'maxTemperature'
  | 'minTemperature'
  | 'apparentTemperature'
  | 'heatIndex'
  | 'wetBulbGlobeTemperature';

/** One issuer value with its unit and untouched ISO 8601 validity interval. */
export interface PointHeatValue {
  readonly value: number;
  readonly unitCode: string;
  readonly validTime: string;
  readonly startTime: string;
  readonly endTime?: string;
}

/** One NWS grid field and its bounded current/future series. */
export interface PointHeatMetricSeries {
  readonly key: PointHeatMetricKey;
  readonly label: string;
  readonly unitCode: string;
  readonly values: readonly PointHeatValue[];
  /** Number of populated current/future intervals in the issuer payload. */
  readonly availableValueCount: number;
}

export interface PointHeatObservation {
  status: LayerStatus;
  note?: string;
  stationId?: string;
  stationName?: string;
  stationUrl?: string;
  distanceKm?: number;
  timestamp?: string;
  metrics: readonly PointHeatMetricSeries[];
}

export interface PointHeatGridGuidance {
  status: LayerStatus;
  note?: string;
  office?: string;
  gridId?: string;
  generatedAt?: string;
  metrics: readonly PointHeatMetricSeries[];
}

/**
 * Point heat is its own briefing lane. It describes the selected coordinate,
 * never the complete boundary, state, Tribal Nation, or Treaty area.
 */
export interface PointHeatBriefing {
  status: LayerStatus;
  note?: string;
  readonly point: { readonly lng: number; readonly lat: number };
  observation: PointHeatObservation;
  grid: PointHeatGridGuidance;
}

export type HeatSourceReadKey =
  | 'pointHeat'
  | 'heatRisk'
  | 'nwsForecast'
  | 'nwsAlerts';

export interface HeatSourceRead {
  readonly key: HeatSourceReadKey;
  readonly label: string;
  readonly text: string;
}

/**
 * Side-by-side heat evidence. DDM preserves each issuer product's spatial and
 * temporal support and never converts these reads into a new heat class.
 */
export interface HeatSynthesis {
  status: LayerStatus;
  reads: readonly HeatSourceRead[];
  note?: string;
}

/**
 * The kind of boundary that was selected; drives the land title and caveat.
 *
 *   tribal          the deployer-populated own-data slot (the Nation's own data)
 *   aiannh          a US Census AIANNH area (live), which spans BOTH legal
 *                   reservation/trust land AND statistical geographies (Oklahoma
 *                   Tribal Statistical Areas, Alaska Native Village Statistical
 *                   Areas, Hawaiian Home Lands, state reservations, joint-use
 *                   areas). A statistical area is NEVER a jurisdiction claim; the
 *                   distinction is drawn by AIANNHCC in the popup and label.
 *   bia-reservation the BIA AIAN-LAR federal reservation/trust-land depiction
 *   watershed       a USGS Watershed Boundary Dataset hydrologic unit (HUC2 or
 *                   HUC4 in the Place studio's v1 scope); a landscape unit like
 *                   an ecoregion, never a jurisdiction, so it carries no
 *                   sovereignty caveat
 */
export type BoundaryKind = 'ecoregion' | 'tribal' | 'aiannh' | 'treaty' | 'bia-reservation' | 'state' | 'watershed';

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
  /**
   * Compatibility feature bounding box `[west, south, east, north]`, when
   * derivable. A crossing geometry retains its naive min/max walk here.
   */
  readonly bbox?: readonly [number, number, number, number];
  /**
   * Complete geometry-derived service envelope, encoded with west greater
   * than east when the selection crosses the antimeridian. Services that can
   * make a negative spatial claim use this field and fail closed when a
   * suspected crossing has no complete envelope.
   */
  readonly serviceBbox?: readonly [number, number, number, number];
  /**
   * True when the selected feature's geometry shows antimeridian-crossing
   * evidence (`geometryLikelyCrossesAntimeridian` in
   * src/util/antimeridian.ts; evidence, not proof). When set, `bbox` above
   * remains the naive min/max walk and `serviceBbox` carries the compact
   * geometry envelope. Omitted (never false) when no crossing evidence
   * exists.
   */
  readonly bboxCrossesAntimeridian?: boolean;
  /** Active region key, or null if no region is selected yet. */
  readonly regionKey: RegionKey | null;
}

/**
 * The full composed briefing the panel renders. `landCaveat` carries the
 * representation caveat for Tribal and Treaty boundaries (preserved in every
 * panel per CLAUDE.md section 2); it is empty for an ecoregion.
 */
export interface ImpactBriefing {
  readonly context: BoundarySelectionContext;
  /** Canonical geography plus the independent policy for every source. */
  readonly sourcePolicy: BriefingSourcePolicy;
  readonly landTitle: string;
  /** A short kind label, for example "BIA reservation boundary". */
  readonly landKind: string;
  /** The representation caveat, or empty string when none applies. */
  readonly landCaveat: string;
  /** Lazy, static ecoregion context. Replaced when its artifact read settles. */
  landscape: LandscapeContext;
  pointHeat: PointHeatBriefing;
  heatSynthesis: HeatSynthesis;
  readonly horizons: {
    current: Horizon;
    nearTerm: Horizon;
    longRange: Horizon;
  };
  resources: ResourceLink[];
}
