/**
 * Question-first view presets (UX-2; ROADMAP "The UX track").
 *
 * Each preset is a named layer-set that answers a question a visitor
 * arrives with, rendered as a chip row in the sidebar. Applying a preset
 * REPLACES the active layer set (through the same activation and
 * deactivation paths a manual toggle takes, so the registry, URL sync,
 * and status pills stay honest) and then leaves the user free to adjust:
 * presets set state without locking it. URL-as-state makes every preset
 * shareable and embeddable for free; there is no preset parameter, only
 * the `layers` list the preset produces.
 *
 * Constraint: a preset names at most ONE surface-role layer (the
 * one-surface-at-a-time invariant, UX-1). `resolveExclusiveSurface`
 * would enforce it downstream on a reload, but a preset that names two
 * surfaces is a config bug; keep the table honest by construction.
 *
 * Tribal Lands appears in every preset: whose land you are looking at is
 * part of every question this module answers (CLAUDE.md section 2).
 */

export interface ViewPreset {
  readonly key: string;
  /** Chip label. Short; the chip row must survive a 400 pixel embed. */
  readonly label: string;
  /** Tooltip / accessible description of the question the preset answers. */
  readonly description: string;
  /** Layer keys to activate, in activation order. At most one surface. */
  readonly layers: readonly string[];
}

export const VIEW_PRESETS: readonly ViewPreset[] = [
  {
    key: 'right-now',
    label: 'Right now',
    description: 'Current drought conditions: the weekly US Drought Monitor with live telemetry stations',
    layers: ['usdm', 'tribal', 'telemetry']
  },
  {
    key: 'this-week',
    label: 'This week',
    description: 'The days ahead: the HeatRisk forecast for today with active heat and fire-weather alerts',
    layers: ['heatrisk', 'nws-alerts', 'tribal']
  },
  {
    key: 'season-ahead',
    label: 'Season ahead',
    description: 'The long view: the NOAA CPC Seasonal Drought Outlook (a categorical tendency, not a forecast of outcomes)',
    layers: ['drought', 'tribal']
  },
  {
    key: 'fire-risk',
    label: 'Fire risk',
    description: 'Fire weather threat: the SPC Day 1 fire-weather outlook with active wildfire perimeters',
    layers: ['spc-fire-weather', 'nifc-fires', 'tribal']
  },
  {
    key: 'whose-land',
    label: 'Whose land',
    description: 'Place and stewardship: Tribal Lands, Treaty areas (representations, not jurisdictional truth), reservation and state boundaries',
    layers: ['tribal', 'treaty', 'bia-reservations', 'states']
  }
];
