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
 * supplies the long-range modifier.
 */

import type { RegionKey } from '../config/regions';
import type { PlaceRef } from '../config/entities';
import type { BriefingSourcePolicy } from './source-policy';
import type { LayerStatus } from '../types/layer';
import type { StateCode } from './resources';
import type { ProductKey } from '../config/products';

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
  /**
   * DDM-P13-T02: the key of the `src/ui/legend-registry.ts` section that
   * carries this claim's product legend (for example `'usdm'`, `'heatrisk'`),
   * when that legend already exists in the app. Set only to a key a real
   * legend section is built under; the renderer uses this to make the
   * per-product legend reachable from the claim, never to invent one.
   */
  readonly legendKey?: string;
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
  /**
   * DDM-P13-T02: the issuer's own statement of the method or basis behind the
   * claim's value (for example a percentile basis or a forecast-period
   * definition), quoted from prose the tree already carries elsewhere
   * (never authored fresh at a construction site). Renders as its own line
   * beneath the source, under the claim that carries it.
   */
  readonly basis?: string;
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
   * The catalog product this claim reads (DDM-P14-T05 microtask 2), a key
   * into `PRODUCTS` in `src/config/products.ts`. Required so every claim
   * traces to the issuer, endpoint, layer and lane one catalog entry
   * records; validated at runtime against `PRODUCT_KEYS` by `makeClaim`,
   * never set independently of that catalog.
   */
  readonly product: ProductKey;
  /**
   * An explicit observed/outlook register that overrides `CLAIM_REGISTER_TAG`'s
   * per-evidence-class default (DR-070 amended 2026-09-08): HeatRisk is
   * `classified` evidence (the badge stays Classified, an issuer-published
   * class of a currently valid state) but the issuer's own words describe a
   * forecast, so its register reads `outlook` in the briefing and on the time
   * bar alike. Set only where the owner has ruled a per-claim exception;
   * every other classified claim, and every other evidence class, still gets
   * its register from the class default. Read through `claimRegisterTag` in
   * `src/impact/evidence.ts`, never this field or the table directly.
   */
  readonly register?: 'observed' | 'outlook';
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
   * The machine-readable identity behind a plain-language lineage (DR-058 a):
   * the internal doctrine or model id, rendered as a `title` attribute on the
   * lineage line so it stays reachable without appearing in the sentence.
   */
  readonly lineageRef?: string;
  /**
   * Optional inline SVG chart (from `src/ui/charts.ts`) rendered beneath the
   * claim text. Trusted, self-generated markup; never user-supplied.
   */
  readonly chartSvg?: string;
  /**
   * The hazard rows of the briefing matrix this claim belongs in. Omitted
   * when the claim belongs to every hazard row its lane feeds, which is the
   * usual case: a lane declares its hazards once (`src/impact/matrix.ts`)
   * and only a claim that departs from its lane names its own. Set it where
   * one fetch answers for more than one hazard, so a claim can never land in
   * a row its issuer does not speak for.
   */
  readonly hazards?: readonly HazardKey[];
  /**
   * The horizon column this claim belongs in. Omitted when the claim belongs
   * to its lane's only horizon. Set it where one fetch answers across
   * horizons (the ENSO snapshot reads a current index state and a seasonal
   * tendency from one file), so each claim sits under the clock it speaks
   * for.
   */
  readonly horizon?: HorizonKey;
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

/** Stable keys for the four hazard rows of the briefing matrix. */
export type HazardKey = 'drought' | 'fire' | 'heat' | 'enso';

/**
 * One cell of the four-hazard by three-horizon matrix: what this briefing can
 * say about one hazard at one horizon, and nothing else.
 *
 * A cell owns its own claims, its own status, and its own note, so a hazard
 * can never borrow the issuer or the validity clock of the hazard beside it.
 * A cell with no claims always carries a `note` that names the product it is
 * missing and why; an empty cell with no explanation is a defect, not a
 * state.
 */
export interface HazardCell {
  readonly hazard: HazardKey;
  readonly horizon: HorizonKey;
  /** The row label, for example "Drought". */
  readonly label: string;
  claims: SourcedClaim[];
  status: HorizonStatus;
  /** The named unavailable, partial, or empty state for this cell alone. */
  note?: string;
}

/**
 * One temporal horizon section of the briefing, holding the four hazard rows
 * of that horizon (DR-012 b: three horizon sections, four hazard rows each).
 *
 * `cells` is authoritative. `claims` remains the flattened view of the same
 * content in hazard order, for the consumers that read one leading line out
 * of the briefing rather than rendering the matrix.
 */
export interface Horizon {
  readonly key: HorizonKey;
  /** Section heading, for example "Current Conditions" (`HORIZON_CHROME`). */
  readonly title: string;
  /** Short definition of the time window, for example "now". */
  readonly subtitle: string;
  /** The four hazard cells of this horizon, keyed by hazard. */
  cells: Record<HazardKey, HazardCell>;
  claims: SourcedClaim[];
  status: HorizonStatus;
  /**
   * Optional honest note for the horizon as a whole, used only by the
   * capability path that reports the whole synthesis unavailable. Per-cell
   * honesty lives on `cells`, never here.
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
  /**
   * The issuer resource this read came from. "Heat sources together" is the
   * section that most explicitly compares issuers, so it carries the same
   * provenance path as a horizon claim (IB-12); optional because a read may
   * have no single addressable product page.
   */
  readonly sourceUrl?: string;
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
 * What contains the selected place, resolved FROM THE PLACE. THE INVARIANT:
 * the camera region is NEVER a basis here. `basis: 'none'` with `state: null`
 * is the honest answer when the place's own state is unknown; it must never
 * be filled in from `regionKey`. A consumer may still fall back to the
 * region afterwards, but that fallback must be visible at the consumer
 * (see `resolveStateCode`, src/impact/resources.ts), never hidden inside
 * this field.
 */
export interface ContainingPlaces {
  readonly state: StateCode | null;
  readonly basis: 'feature-property' | 'point-in-polygon' | 'none';
}

/**
 * The context handed from a boundary click to the briefing composer. Carries
 * the clicked feature's identity (kind, title, raw properties), the click
 * location, an optional bounding box derived from the feature geometry (used
 * to clip live queries in Phase 3), the active region key (for resource
 * framing), and what the place is known to be contained by, resolved from
 * the place itself rather than the camera (see `ContainingPlaces`).
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
  /** What contains the selected place, resolved from the place, never the camera region. */
  readonly containing: ContainingPlaces;
  /**
   * The canonical `scheme:code` identity of the selected place (DDM-P2-T09),
   * filled from the selected feature's OWN properties (`placeRefFromBoundary`,
   * src/config/entities.ts), never from the camera or the active region. Null
   * when the feature carries no stable code for its kind ('tribal', 'treaty',
   * or a property miss); identity only, never a claim, and never URL state.
   * Optional since the C3 housekeeping commit (2026-09-12): no reader exists
   * yet, so the two boot doors (the interaction coordinator's condition door
   * and the deep link's `select=` door) omit it and keep src/config/entities.ts
   * out of the entry chunk, while `buildBoundaryContext` still fills it on
   * the lazy path. DR-099 / DDM-P2-T13 (S31) is the first reader.
   */
  readonly place?: PlaceRef | null;
}

/**
 * The full composed briefing the panel renders. `landCaveat` carries the
 * representation caveat for Tribal and Treaty boundaries (a stewardship hard
 * rule: preserved in every panel); it is empty for an ecoregion.
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
