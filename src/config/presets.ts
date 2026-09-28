import { HAZARD_CLUSTERS } from './clusters';
import type { TemporalHorizonKey } from './clusters';
import type { LayerKey } from './layers';

/**
 * Question-first view presets (UX-2; ROADMAP "The UX track").
 *
 * Each preset is a named scene that answers a question a visitor arrives
 * with, rendered as a chip row in the sidebar. Applying a preset REPLACES
 * the active layer set (through the same activation and
 * deactivation paths a manual toggle takes, so the registry, URL sync,
 * and status pills stay honest) and then leaves the user free to adjust:
 * presets set state without locking it. URL-as-state makes every preset
 * shareable and embeddable for free; there is no preset parameter, only
 * the granular `layers`, the optional `basemap`, and (for a preset that
 * declares one) the `horizon` state the preset produces.
 *
 * Horizon rule (D1 M6, 2026-09-27; found-005): a preset whose question names
 * a time declares `horizon`, and applying it commits that horizon through
 * the cluster service's `requestHorizon` AFTER its layers are applied (the
 * display is already a custom set by then, so the write republishes the
 * set at the new horizon and never re-runs a hazard recipe). "Right now"
 * declares `current` and "Season ahead" declares `season-ahead`; a preset
 * that declares none leaves the committed horizon where it is. The mobile
 * hazard rail declares none (below).
 *
 * Pressed rule (D1 M6): a quick-view chip reads `aria-pressed="true"`
 * exactly while `isPresetShowing` (below) holds for the committed shell
 * snapshot: its intended layer keys equal the preset's `layers` as a set,
 * and the committed horizon equals the declared one when the preset
 * declares one. Pressed reports what the display IS; it still locks
 * nothing. The rule lives here, beside the `horizon` field it reads,
 * because this module is DOM-free and its one runtime import is
 * `./clusters`, so `tests/preset-pressed.test.mjs` proves it under plain
 * `node --test`.
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
 * `MOBILE_HAZARD_PRESETS` and `VIEW_PRESETS` define, in the order those two
 * arrays declare them (mobile rail first, then the chip row). This is a
 * VALUE list maintained by hand, the same shape `LAYER_KEYS` uses in
 * src/config/layers.ts and for the same reason: a type derived from the
 * array literals' own shape could not catch a typo in a preset's `key`
 * field against itself. `ViewPreset.key` is typed from this list, so a
 * typo there fails `tsc`. `tests/config-key-authority.spec.ts` keeps this
 * list in step with the two preset arrays at runtime.
 */
export const PRESET_KEYS = Object.freeze([
  'hazard-enso',
  'hazard-drought',
  'hazard-heat',
  'hazard-fire',
  'right-now',
  'this-week',
  'season-ahead',
  'fire-risk',
  'whose-land'
] as const);

/** The union of every valid preset key, derived from `PRESET_KEYS`. */
export type PresetKey = (typeof PRESET_KEYS)[number];

export interface ViewPreset {
  readonly key: PresetKey;
  /** Chip label. Short; the chip row must survive a 400 pixel embed. */
  readonly label: string;
  /** Tooltip / accessible description of the question the preset answers. */
  readonly description: string;
  /** Basemap requested only by an explicit click on this preset. */
  readonly preferredBasemap?: 'satellite';
  /** Layer keys to activate, in activation order. At most one surface. */
  readonly layers: readonly LayerKey[];
  /**
   * The time horizon this preset commits after its layers (D1 M6,
   * 2026-09-27; found-005), for a preset whose question names a time.
   * Omitted (never `undefined`: `exactOptionalPropertyTypes`) for a
   * preset that leaves the committed horizon where it is.
   */
  readonly horizon?: TemporalHorizonKey;
}

/**
 * The mobile hazard rail's quick selections (0.7.0 mobile shell; from the
 * 2026-07-11 ideation's hazard rail, built per the maintainer's 2026-07-14
 * direction with Codex-sol design input). Hazard-named rather than
 * question-named: on a phone the visitor reaches for ENSO, fire, drought, or
 * heat, not a temporal frame. Same layer semantics as the chip row
 * (REPLACE the active set through the controller; at most one surface;
 * never locked), but NO rail preset declares a `horizon` (the phone shell
 * shows no horizon row, so a rail press leaves the committed horizon where
 * it is), and the rail's pressed state stays the registry-driven surface
 * read in src/ui/sidebar.ts's `wireHazardRail`, not `isPresetShowing`. The
 * chip row's declared horizons apply wherever the chip row renders, the
 * phone sheet's Quick views included. Deliberately slim layer sets: the
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
    // hms-smoke is named explicitly (maintainer ruling 2026-07-15): applyPreset
    // takes the non-cascading activation path, so coActivateWith alone would
    // not bring smoke in, and a fire view without smoke is not the full read.
    layers: ['spc-fire-weather', 'nifc-fires', 'hms-smoke', 'aiannh']
  }
];

export const VIEW_PRESETS: readonly ViewPreset[] = [
  {
    key: 'right-now',
    label: 'Right now',
    description: 'Current drought conditions: the tri-national North American Drought Monitor with live telemetry stations',
    layers: ['nadm-drought', 'aiannh', 'telemetry'],
    horizon: 'current'
  },
  {
    key: 'this-week',
    label: 'This week',
    description: 'The days ahead: published National Weather Service HeatRisk heat-impact levels for the selected date, with active heat and fire-weather notices',
    layers: ['heatrisk', 'nws-alerts', 'aiannh']
  },
  {
    key: 'season-ahead',
    label: 'Season ahead',
    // vocab-allow: honesty disclaimer, denies being a forecast
    description: 'The long view: the NOAA CPC Seasonal Drought Outlook (a categorical tendency, not a forecast of outcomes)',
    layers: ['drought', 'aiannh'],
    horizon: 'season-ahead'
  },
  {
    key: 'fire-risk',
    label: 'Fire risk',
    description: 'Fire weather threat: recent NOAA GOES GeoColor context; the SPC Day 1 fire-weather outlook with current mapped fire perimeters, including Wildfire and Prescribed fire, plus independently timed NOAA Hazard Mapping System (HMS) smoke plumes',
    preferredBasemap: 'satellite',
    // Explicit hms-smoke for the same non-cascading reason as hazard-fire.
    layers: ['spc-fire-weather', 'nifc-fires', 'hms-smoke', 'aiannh']
  },
  {
    key: 'whose-land',
    label: 'Whose land',
    description: 'Place and stewardship: Tribal Lands, reservation and state boundaries',
    layers: ['aiannh', 'bia-reservations', 'states']
  }
];

/**
 * The committed display a quick view is compared with: the committed shell
 * snapshot's intended layer keys and horizon (a `CommittedShellSnapshot`
 * from src/state/cluster-service.ts satisfies this structurally; this
 * module never imports the service).
 */
export interface PresetDisplayReading {
  readonly intendedKeys: ReadonlySet<string>;
  readonly horizon: TemporalHorizonKey;
}

/**
 * The quick-view pressed rule (D1 M6, 2026-09-27; found-005): true exactly
 * while the display's intended keys equal the preset's `layers` as a set
 * (neither a superset nor a subset) AND, when the preset declares a
 * `horizon`, the display's horizon equals it. Pure: no DOM, no module state.
 */
export function isPresetShowing(preset: ViewPreset, display: PresetDisplayReading): boolean {
  const wanted = new Set<string>(preset.layers);
  if (display.intendedKeys.size !== wanted.size) return false;
  for (const key of wanted) {
    if (!display.intendedKeys.has(key)) return false;
  }
  return preset.horizon === undefined || display.horizon === preset.horizon;
}
