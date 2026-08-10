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
 * the granular `layers` and optional `basemap` state the preset produces.
 *
 * Constraint: a preset names at most ONE surface-role layer (the
 * one-surface-at-a-time invariant, UX-1). `resolveExclusiveSurface`
 * would enforce it downstream on a reload, but a preset that names two
 * surfaces is a config bug; keep the table honest by construction.
 *
 * Tribal Lands appears in every preset: whose land you are looking at is
 * part of every question this module answers (CLAUDE.md section 2). Since
 * the Tribal Nations umbrella build (D-0.7.0-032/033), the key that carries
 * it is `aiannh`, the LIVE US Census layer that actually renders on the
 * reference deployment; the `tribal` deployer own-data slot ships empty and
 * stays out of presets.
 */

export interface ViewPreset {
  readonly key: string;
  /** Chip label. Short; the chip row must survive a 400 pixel embed. */
  readonly label: string;
  /** Tooltip / accessible description of the question the preset answers. */
  readonly description: string;
  /** Basemap requested only by an explicit click on this preset. */
  readonly preferredBasemap?: 'satellite';
  /** Layer keys to activate, in activation order. At most one surface. */
  readonly layers: readonly string[];
}

/**
 * The mobile hazard rail's quick selections (0.7.0 mobile shell; from the
 * 2026-07-11 ideation's hazard rail, built per the maintainer's 2026-07-14
 * direction with Codex-sol design input). Hazard-named rather than
 * question-named: on a phone the visitor reaches for "drought", "heat",
 * "fire", not a temporal frame. Same ViewPreset semantics as the chip row
 * (REPLACE the active set through the controller; at most one surface;
 * never locked), and deliberately slim layer sets: the rail's job is the
 * fastest honest read of one hazard, not a composed view. NOT exclusive
 * modes: the visitor can still stack layers from the catalog afterward
 * (the drought to heat to fire combined read stays reachable).
 */
export const MOBILE_HAZARD_PRESETS: readonly ViewPreset[] = [
  {
    key: 'hazard-drought',
    label: 'Drought',
    description: 'Current drought conditions: the weekly US Drought Monitor',
    layers: ['usdm', 'aiannh']
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
    description: 'Current drought conditions: the weekly US Drought Monitor with live telemetry stations',
    layers: ['usdm', 'aiannh', 'telemetry']
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
    layers: ['drought', 'aiannh']
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
