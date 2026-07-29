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
 * facade discipline); this module is pure config with no imports from
 * layer or UI code.
 */

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

/** Display labels. The durable `weeks-ahead` key predates the seven-day read. */
export const TEMPORAL_HORIZON_LABELS: Readonly<
  Record<TemporalHorizonKey, string>
> = {
  current: 'current',
  'weeks-ahead': 'next seven days',
  'season-ahead': 'season ahead'
};

export interface HazardClusterDef {
  /** Button title, exactly as ruled (D-0.7.0-042). */
  readonly title: string;
  /** One-word durable URL token, or null for the default cluster whose
   * URL truth is absence (D-0.7.0-044). */
  readonly urlToken: string | null;
  /** Accessible description of what the cluster shows today; honest
   * about v1 scope. */
  readonly description: string;
  /**
   * Explicit hazard-layer recipe per temporal horizon, in activation
   * order; keys are LAYER_DEFS keys. At most one surface-role layer per
   * horizon (the one-surface invariant, UX-1). An EMPTY recipe is an
   * honest statement that no verified surface exists for that horizon
   * yet; the shell must not fake one.
   */
  readonly recipes: Readonly<Record<TemporalHorizonKey, readonly string[]>>;
}

export const HAZARD_CLUSTERS: Record<HazardClusterKey, HazardClusterDef> = {
  drought: {
    title: 'Drought',
    urlToken: null,
    // First-use expansion (CLAUDE.md section 5; DG-080 r2 finding 5):
    // this tooltip is the cluster's first prose use of the agency name,
    // so both acronyms are spelled out here; later uses stay compact.
    description:
      'Current drought conditions and the National Oceanic and Atmospheric Administration (NOAA) Climate Prediction Center (CPC) drought outlooks.',
    recipes: {
      // The weekly US Drought Monitor is the current read.
      current: ['usdm'],
      // Both outlook horizons render the CPC outlook surface; the
      // timeline store's outlook range (monthly vs seasonal) selects
      // the register within it.
      'weeks-ahead': ['drought'],
      'season-ahead': ['drought']
    }
  },
  wildfire: {
    title: 'Wildfire',
    urlToken: 'wildfire',
    description: 'Active wildfire perimeters and smoke plumes; outlook and potential reads at longer horizons.',
    recipes: {
      // D-0.7.0-043 part 1: at the current register, perimeters plus
      // smoke ONLY; the potential read (WHP) stays out of the
      // present-conditions read.
      current: ['nifc-fires', 'hms-smoke'],
      // Near-term: the SPC fire-weather outlook over the live events.
      'weeks-ahead': ['spc-fire-weather', 'nifc-fires', 'hms-smoke'],
      // Long horizon: the static potential read becomes eligible.
      'season-ahead': ['usfs-whp']
    }
  },
  heat: {
    title: 'Extreme Heat',
    urlToken: 'heat',
    description: 'Published National Weather Service HeatRisk heat-impact levels for the selected date with active heat notices.',
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
    }
  },
  enso: {
    title: 'ENSO',
    urlToken: 'enso',
    // First-use expansion (CLAUDE.md section 5; DG-080 review finding
    // 7): the ruled compact button title stays 'ENSO'; the description
    // (the button's title text) spells the acronym out.
    description: 'The sea-surface-temperature anomaly display with the current El Nino / Southern Oscillation (ENSO) index snapshot.',
    recipes: {
      // v1 is the shipped SST anomaly surface at every horizon; the
      // ENSO snapshot line is a UI surface, not a map layer. Richer
      // products are a later phase (D-0.7.0-042 honesty boundary).
      current: ['sst-anomaly'],
      'weeks-ahead': ['sst-anomaly'],
      'season-ahead': ['sst-anomaly']
    }
  }
};

/** The cluster keys in button presentation order (D-0.7.0-042). */
export const HAZARD_CLUSTER_KEYS: readonly HazardClusterKey[] = [
  'drought',
  'wildfire',
  'heat',
  'enso'
];

/** Display-name table for the honest prose display summary
 * (D-0.7.0-041 part 2; src/types/display-summary.ts). */
export const CLUSTER_DISPLAY_NAMES: Readonly<Record<HazardClusterKey, string>> = {
  drought: HAZARD_CLUSTERS.drought.title,
  wildfire: HAZARD_CLUSTERS.wildfire.title,
  heat: HAZARD_CLUSTERS.heat.title,
  enso: HAZARD_CLUSTERS.enso.title
};
