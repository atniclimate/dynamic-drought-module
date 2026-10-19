import { HAZARD_CLUSTERS } from './clusters';
import type { LayerKey } from './layers';

/**
 * The phone hazard rail's presets (0.7.0 mobile shell). The desktop Quick
 * views chip row is retired (owner review, 2026-10-19): each mode opens with
 * its own layers.
 *
 * Applying a preset REPLACES the active layer set (through the same
 * activation and deactivation paths a manual toggle takes, so the registry,
 * URL sync, and status pills stay honest) and then leaves the user free to
 * adjust: presets set state without locking it. There is no preset
 * parameter, only the granular `layers` and the optional `basemap` state the
 * preset produces. A preset leaves the committed horizon where it is.
 *
 * Constraint: a preset names at most ONE surface-role layer (the
 * one-surface-at-a-time invariant, UX-1). `resolveExclusiveSurface`
 * would enforce it downstream on a reload, but a preset that names two
 * surfaces is a config bug; keep the table honest by construction.
 *
 * Tribal Lands appears in every preset: whose land you are looking at is
 * part of every question this module answers (a stewardship rule). Since
 * the Tribal Nations umbrella build (D-0.7.0-032/033), the key that carries
 * it is `aiannh`, the LIVE US Census layer that actually renders on the
 * reference deployment; the `tribal` deployer own-data slot ships empty and
 * stays out of presets.
 */

/**
 * The preset-key authority (DDM-P1-T05 microtask 2): every key
 * `MOBILE_HAZARD_PRESETS` defines, in the order it declares them. This is a
 * VALUE list maintained by hand, the same shape `LAYER_KEYS` uses in
 * src/config/layers.ts and for the same reason: a type derived from the
 * array literals' own shape could not catch a typo in a preset's `key`
 * field against itself. `ViewPreset.key` is typed from this list, so a
 * typo there fails `tsc`. `tests/config-key-authority.spec.ts` keeps this
 * list in step with the preset array at runtime.
 */
export const PRESET_KEYS = Object.freeze([
  'hazard-enso',
  'hazard-drought',
  'hazard-heat',
  'hazard-fire'
] as const);

/** The union of every valid preset key, derived from `PRESET_KEYS`. */
export type PresetKey = (typeof PRESET_KEYS)[number];

export interface ViewPreset {
  readonly key: PresetKey;
  /** Short name of the preset. */
  readonly label: string;
  /** Tooltip / accessible description of the question the preset answers. */
  readonly description: string;
  /** Basemap requested only by an explicit click on this preset. */
  readonly preferredBasemap?: 'satellite';
  /** Layer keys to activate, in activation order. At most one surface. */
  readonly layers: readonly LayerKey[];
}

/**
 * The mobile hazard rail's quick selections (0.7.0 mobile shell; from the
 * 2026-07-11 ideation's hazard rail, built per the maintainer's 2026-07-14
 * direction with Codex-sol design input). Hazard-named rather than
 * question-named: on a phone the visitor reaches for ENSO, fire, drought, or
 * heat, not a temporal frame. REPLACE the active set through the controller;
 * at most one surface; never locked. A rail press leaves the committed
 * horizon where it is (the phone shell shows no horizon row), and the
 * rail's pressed state is the registry-driven surface read in
 * src/ui/sidebar.ts's `wireHazardRail`. Deliberately slim layer sets: the
 * rail's job is the fastest honest read of one hazard, not a composed
 * view. NOT exclusive modes: the visitor can still stack layers from the
 * catalog afterward
 * (the drought to heat to fire combined read stays reachable).
 */
export const MOBILE_HAZARD_PRESETS: readonly ViewPreset[] = [
  {
    key: 'hazard-enso',
    label: 'ENSO',
    description: HAZARD_CLUSTERS.enso.description,
    layers: ['sst-anomaly', 'aiannh']
  },
  {
    key: 'hazard-drought',
    label: 'Drought',
    description: 'Current drought conditions: the tri-national North American Drought Monitor',
    layers: ['nadm-drought', 'aiannh']
  },
  {
    key: 'hazard-heat',
    label: 'Heat',
    description: 'Extreme heat: published National Weather Service HeatRisk heat-impact levels for the selected date, with active heat notices',
    layers: ['heatrisk', 'nws-alerts', 'aiannh']
  },
  {
    key: 'hazard-fire',
    label: 'Fire',
    description: 'Wildfire: recent NOAA GOES GeoColor context; the SPC fire-weather outlook with current mapped fire perimeters, including Wildfire and Prescribed fire, plus independently timed NOAA Hazard Mapping System (HMS) smoke plumes',
    preferredBasemap: 'satellite',
    // hms-smoke is named explicitly (maintainer ruling 2026-07-15): a fire
    // view without smoke is not the full read. Naming it is now the only way
    // the preset brings smoke in: applyPreset takes the non-cascading path,
    // and since the owner's ruling of 2026-09-28 (found-007) no layer declares
    // coActivateWith partners, so the two checkboxes are independent.
    layers: ['spc-fire-weather', 'nifc-fires', 'hms-smoke', 'aiannh']
  }
];
