/**
 * Hazard cluster definitions for the region shell (S1; D-0.7.0-042,
 * D-0.7.0-043, D-0.7.0-044; plan 9.11).
 *
 * The v1 cluster set is FOUR buttons titled exactly Drought, Wildfire,
 * Extreme Heat, and ENSO (D-0.7.0-042). Naming rulings carried here:
 * "Wildfire" does not say "smoke" (smoke stays in the recipe); water
 * supply is not a cluster (its depth lives in the drought briefing);
 * ENSO is a first-class cluster whose v1 display is the SHIPPED
 * sea-surface-temperature anomaly surface plus the ENSO index snapshot,
 * honestly labeled. Nothing here may imply the richer ENSO products
 * (marine heatwaves, projections) exist before they are built and
 * verified.
 *
 * RECIPES ARE TEMPORAL-HORIZON-AWARE (D-0.7.0-043 part 1): each horizon
 * names its own explicit hazard layer set, never a blend that muddies
 * what time the map shows. Recipes list HAZARD members only; the
 * persistent reference set (sovereign geography, hillshade, state
 * hairlines) survives every cluster switch and is composed by the S3
 * cluster service, not repeated per recipe (D-0.7.0-043 part 6). The
 * temporal register itself persists across cluster flips so a switch
 * compares the same time.
 *
 * URL AUTHORITY (D-0.7.0-044): while the display is a clean cluster the
 * URL carries only the one-word cluster token; Drought, the default
 * display, is ABSENCE (no token; absence is the truth, D-0.7.0-041).
 * Customizing in the LAYERS studio drops `cluster=` for `layers=`; on
 * parse, `layers=` outranks `cluster=`. S2 implements the parsing; this
 * table is the durable vocabulary.
 *
 * Consumers apply recipes through the layer controller only (the frozen
 * facade discipline); this module has one type-only import, `LayerKey`
 * from src/config/layers.ts (DDM-P1-T05 microtask 2), so a typo in a
 * recipe's layer key fails typechecking instead of drifting silently; a
 * type-only import is erased at build and adds no runtime edge, so this
 * module still has no runtime imports from layer or UI code.
 */

import type { LayerKey } from './layers';
import type { DetailSectionKey } from './detail-sections';
import type { PlaceConditionRowKey } from './place-condition-rows';
import type { BasemapMode } from '../state/basemap-store';

export type HazardClusterKey = 'drought' | 'wildfire' | 'heat' | 'enso';

/**
 * The three briefing/display horizons (D-0.7.0-052: Current, Next seven
 * days, Season ahead). Mapping these onto the timeline store's
 * registers (USDM week, outlook range) is the S3 cluster service's job.
 */
export type TemporalHorizonKey = 'current' | 'weeks-ahead' | 'season-ahead';

export const TEMPORAL_HORIZON_KEYS: readonly TemporalHorizonKey[] = [
  'current',
  'weeks-ahead',
  'season-ahead'
];

/**
 * VISIBLE HORIZON WORDS moved out of this module (DDM-P8-T03, owner ruling
 * R1, 2026-09-07). Two tables used to live here: the shell's chip text
 * ("Current" / "Weeks ahead" / "Season ahead", read by shell.tsx and
 * panel-response.tsx) and a separate prose-cadence table ("next seven
 * days", read by nothing but a test pin). They had already diverged from
 * the briefing panel's own headings ("Near Term" for the same horizon), and
 * this module's own comment reserved reconciling them for an owner ruling
 * rather than a refactor.
 *
 * The ruling: `src/impact/horizon-chrome.ts` is now the single source of
 * horizon names for the whole interface, shell chips included, through its
 * `SHELL_HORIZON_KEY` map from `TemporalHorizonKey` (kept here for routing:
 * URL tokens, recipe selection) to the briefing's `HorizonKey`. The chip
 * table is retired outright. The cadence table had zero production readers
 * and is retired too, the smaller diff; `tests/heat-h1-heatrisk.spec.ts`
 * re-points its pin at `HORIZON_CHROME` directly.
 */

export interface HazardClusterDef {
  /** Button title, exactly as ruled (D-0.7.0-042). */
  readonly title: string;
  /** One-word durable URL token, or null for the default cluster whose
   * URL truth is absence (D-0.7.0-044). */
  readonly urlToken: string | null;
  /** Accessible description of what the cluster shows today; honest
   * about v1 scope. */
  readonly description: string;
  /** The basemap this mode opens on (owner, 2026-10-13). REQUIRED, so a new
   * mode cannot be added without deciding it. Applied when a visitor chooses
   * the mode; a SAT press lasts only within the mode. The URL carries
   * `basemap=` only when the live basemap differs from this value. */
  readonly defaultBasemap: BasemapMode;
  /**
   * Explicit hazard-layer recipe per temporal horizon, in activation
   * order; keys are LAYER_DEFS keys. At most one surface-role layer per
   * horizon (the one-surface invariant, UX-1). An EMPTY recipe is an
   * honest statement that no verified surface exists for that horizon
   * yet; the shell must not fake one.
   */
  readonly recipes: Readonly<Record<TemporalHorizonKey, readonly LayerKey[]>>;
  /**
   * Layers a person may add on top of this mode without leaving it: the mode
   * stays pressed and every horizon stays usable; while one is on beyond the
   * recipe the link writes `layers=` so it carries it. A surface here stands in for the recipe's
   * surface, which the one-surface rule turns off when it comes on. A horizon
   * change re-applies the recipe, so a layer here follows it.
   */
  readonly optionalLayers?: readonly LayerKey[];
  /**
   * The horizon an in-session entry into this mode commits (the mode
   * switcher, the minimap ocean door, the phone rail), read only through the
   * cluster service and the rail, never as a mode literal (DR-113). Unset
   * keeps the held horizon where the mode can show it (DR-190). A shared link
   * keeps its own `horizon=`, and an absent one means Current.
   */
  readonly entryHorizon?: TemporalHorizonKey;
  /**
   * The Key drawer's sections for this cluster, in order (S30D D1 M11;
   * DR-113; src/config/detail-sections.ts). Omitted or empty means the
   * drawer holds only the legend, qualifications and the map-information
   * pointer (design record section 2.6, items 1, 2, 4 and 5) with no
   * section host revealed.
   */
  readonly detailSections?: readonly DetailSectionKey[];
  /**
   * The row this cluster contributes to a place popup's Conditions block
   * (S30D D1 M24; DR-113; src/config/place-condition-rows.ts), or null when
   * its row is deferred with a reason recorded in
   * PLACE_CONDITION_ROW_DEFERRED. REQUIRED, so a new mode cannot be added
   * without deciding it.
   */
  readonly placeConditionRow: PlaceConditionRowKey | null;
  /**
   * The ENSO flow kind this mode opens with when its link names no `flow=`
   * (DR-111 Q-WIND-MODES; precedence.md 2.4 and section 3). Read only through
   * src/state/enso-flow.ts `ensoFlowModeDefault`, never as a mode literal
   * (DR-113); `flow=off` keeps such a mode off. Unset means off. ENSO sets it
   * to 'wind' (ENSO-FLOW-PLAN block E2, unit E2-4); no other mode sets it.
   */
  readonly flowDefault?: Exclude<import('../state/enso-flow').EnsoFlowKind, 'off'>;
  /**
   * The National Weather Service products the alert layer (`nws-alerts`,
   * src/layers/nws-alerts.ts) reads in this mode, and its name here. Read
   * through the person's hazard (`getSelectedHazard`, src/state/cluster-service.ts),
   * so a custom layer set keeps its mode's. Unset: the layer reads nothing in this mode.
   */
  readonly alerts?: AlertSet;
}

/**
 * One mode's alert products. Each event is a `prod_type` value of the NWS
 * Watch/Warning/Advisory MapServer verbatim (the service's renderer lists
 * them); the reader asks for these and no others, and the key lists them in
 * NWS_ALERT_LEGEND order (src/config/palette.ts).
 */
export interface AlertSet {
  readonly name: string;
  readonly events: readonly string[];
}

/** The heat and fire weather products: the alert layer's one list before modes named their own. */
export const HEAT_FIRE_ALERTS: AlertSet = {
  // vocab-allow: names the NWS alert products layer, upstream data
  name: 'Heat & Fire Weather Alerts',
  // The pre-2025 "Excessive Heat" and the Hazard Simplification "Extreme
  // Heat" names both, so transitional products never drop out silently.
  events: [ // vocab-allow: verbatim NWS product names, quoted source data
    'Extreme Heat Warning', // vocab-allow: verbatim NWS product names, quoted source data
    'Excessive Heat Warning',
    'Extreme Heat Watch',
    'Excessive Heat Watch',
    'Heat Advisory',
    'Red Flag Warning', // vocab-allow: verbatim NWS product names, quoted source data
    'Fire Weather Watch'
  ]
};

export const HAZARD_CLUSTERS: Record<HazardClusterKey, HazardClusterDef> = {
  drought: {
    title: 'Drought',
    urlToken: null,
    // First-use acronym expansion (DG-080 r2 finding 5):
    // this tooltip is the cluster's first prose use of the agency name,
    // so both acronyms are spelled out here; later uses stay compact.
    description:
      'Current North American Drought Monitor conditions and the National Oceanic and Atmospheric Administration (NOAA) Climate Prediction Center (CPC) drought outlooks.',
    defaultBasemap: 'satellite',
    recipes: {
      // The monthly tri-national product is the current continental read.
      current: ['nadm-drought'],
      // Both outlook horizons render the CPC outlook surface; the
      // timeline store's outlook range (monthly vs seasonal) selects
      // the register within it.
      'weeks-ahead': ['drought'],
      'season-ahead': ['drought']
    },
    placeConditionRow: 'drought',
    // Drought is also the committed mode of every custom layer set (a
    // `layers=` link, the phone hazard rail, a studio choice), which read
    // these products before modes named their own.
    alerts: HEAT_FIRE_ALERTS
  },
  wildfire: {
    title: 'Wildfire',
    urlToken: 'wildfire',
    description:
      'Current mapped fire perimeters (NIFC), distinguishing Wildfire and Prescribed fire, plus independently timed NOAA Hazard Mapping System (HMS) smoke plumes; outlook and potential reads at longer horizons. Recent NOAA GOES GeoColor context on request (SAT).',
    defaultBasemap: 'default',
    recipes: {
      // D-0.7.0-043 part 1: at the current register, perimeters plus
      // smoke ONLY; the potential read (WHP) stays out of the
      // present-conditions read. The phone Fire quick view
      // (MOBILE_HAZARD_PRESETS in src/config/presets.ts) deliberately
      // diverges: it adds the SPC Day 1 outlook to this pair because the
      // phone shell has no horizon control. That is a governed, recorded
      // divergence (docs/design/mobile-map-chrome.md), not drift.
      current: ['nifc-fires', 'hms-smoke'],
      // Near-term: the SPC fire-weather outlook over the live events.
      'weeks-ahead': ['spc-fire-weather', 'nifc-fires', 'hms-smoke'],
      // Long horizon: the static potential read becomes eligible beside the
      // live perimeters, which DR-022 keeps in every horizon. Retiring WHP
      // for the NIFC Months 1 to 4 outlook is the rest of DDM-P7-T03.
      // WHP first: the activation-failure spec fails recipe[0], so this keeps a WHP failure tested.
      'season-ahead': ['usfs-whp', 'nifc-fires']
    },
    // The console's Fuel risk switch (src/ui/fire3d-fuel-risk.ts).
    optionalLayers: ['usfs-whp'],
    placeConditionRow: 'wildfire-perimeter',
    alerts: HEAT_FIRE_ALERTS
  },
  heat: {
    title: 'Extreme Heat',
    urlToken: 'heat',
    description: 'Published National Weather Service HeatRisk heat-impact levels for the selected date with active heat notices.',
    defaultBasemap: 'default',
    recipes: {
      // Alerts ride the count-first, hazard-filtered model
      // (D-0.7.0-043 part 2); the nws-alerts layer is the map face of
      // that model.
      current: ['heatrisk', 'nws-alerts'],
      // HeatRisk publishes the next seven daily periods. The durable
      // `weeks-ahead` recipe key keeps its URL compatibility, while its
      // display label above names the source's actual next-seven-days span.
      'weeks-ahead': ['heatrisk', 'nws-alerts'],
      // No verified season-ahead heat surface exists yet; the drought
      // briefing carries seasonal temperature context in prose. An
      // empty recipe is deliberate honesty, not an omission.
      'season-ahead': []
    },
    // HeatRisk first (S30D D1 M11): the seven-day point sequence is
    // Heat's one Key drawer section.
    detailSections: ['heatrisk-sequence'],
    // HeatRisk has no verified per-point read (src/ui/popup-conditions.ts),
    // so Heat's place row is the active NWS heat and fire weather products.
    placeConditionRow: 'nws-alerts',
    alerts: HEAT_FIRE_ALERTS
  },
  enso: {
    title: 'ENSO',
    urlToken: 'enso',
    // First-use acronym expansion (DG-080 review finding
    // 7): the ruled compact button title stays 'ENSO'; the description
    // (the button's title text) spells the acronym out.
    description: 'The sea-surface-temperature anomaly display with the current El Nino / Southern Oscillation (ENSO) index snapshot.',
    defaultBasemap: 'satellite',
    recipes: {
      // The shipped SST anomaly surface at every horizon; the ENSO snapshot
      // line is a UI surface, not a map layer. The active tropical cyclones
      // (ENSO block B3, an event overlay) ride every horizon: the issuer
      // serves only the current advisories, which run five days ahead.
      // Weeks ahead adds the CPC 8-14 day precipitation outlook and Season
      // ahead the CPC seasonal precipitation outlook over the SST surface,
      // each its own layer and key, never merged with another.
      current: ['sst-anomaly', 'tropical-cyclones'],
      'weeks-ahead': ['sst-anomaly', 'cpc-814-precip', 'tropical-cyclones'],
      'season-ahead': ['sst-anomaly', 'cpc-seasonal-precip', 'tropical-cyclones']
    },
    // The other CPC outlooks and the alert layer are the mode's, each off
    // until a person turns it on, at any horizon.
    optionalLayers: ['cpc-seasonal-temp', 'cpc-610-precip', 'cpc-610-temp', 'cpc-814-temp', 'nws-alerts'],
    // ENSO opens on the outlook until the DDM-P16-T09 composite is promoted
    // (its acceptance sentence, amended 2026-09-26).
    entryHorizon: 'season-ahead',
    // Deferred, not absent: ENSO's place row (the sea surface temperature
    // anomaly) moves to the ocean sprint the owner asked for on 2026-10-01
    // (PLACE_CONDITION_ROW_DEFERRED in src/config/place-condition-rows.ts).
    placeConditionRow: null,
    // ENSO opens with the NOAA GFS wind paths on (DR-111 Q-WIND-MODES;
    // precedence.md 2.4); `flow=off` keeps it off (ENSO-FLOW-PLAN E2-4).
    flowDefault: 'wind',
    alerts: {
      // DRAFT wording (pending the owner's read-back): the alert layer's name in ENSO.
      // vocab-allow: names the NWS alert products layer, upstream data
      name: 'Flood, Storm, Wind & Coastal Alerts',
      // The service's Warnings and Watches for flood, storm, wind and the
      // coast, in that group order, each group in the NWS priority order
      // (https://www.weather.gov/help-map); no advisory or statement. The
      // Hurricane and Tropical Storm Watches and Warnings are the storm
      // layer's (tropical-cyclones, in its issuer's colours); the Typhoon
      // products stay, since that layer's three basins exclude the western Pacific.
      events: [
        'Flash Flood Warning', 'Flood Warning', 'Flash Flood Watch', 'Flood Watch', // vocab-allow: verbatim NWS product names, quoted source data
        'Typhoon Warning', 'Blizzard Warning', 'Ice Storm Warning', 'Winter Storm Warning', // vocab-allow: verbatim NWS product names, quoted source data
        'Typhoon Watch', 'Winter Storm Watch',
        'Extreme Wind Warning', 'High Wind Warning', 'High Wind Watch', // vocab-allow: verbatim NWS product names, quoted source data
        'Storm Surge Warning', 'Coastal Flood Warning', 'Lakeshore Flood Warning', 'High Surf Warning', // vocab-allow: verbatim NWS product names, quoted source data
        'Storm Surge Watch', 'Coastal Flood Watch', 'Lakeshore Flood Watch'
      ]
    }
  }
};

/** The cluster keys in button presentation order (D-0.7.0-042): the
 * HAZARD_CLUSTERS table's own order, so a new mode cannot miss the list. */
export const HAZARD_CLUSTER_KEYS = Object.keys(HAZARD_CLUSTERS) as readonly HazardClusterKey[];

/** Display-name table for the honest prose display summary
 * (D-0.7.0-041 part 2; src/types/display-summary.ts). */
export const CLUSTER_DISPLAY_NAMES: Readonly<Record<HazardClusterKey, string>> = {
  drought: HAZARD_CLUSTERS.drought.title,
  wildfire: HAZARD_CLUSTERS.wildfire.title,
  heat: HAZARD_CLUSTERS.heat.title,
  enso: HAZARD_CLUSTERS.enso.title
};
