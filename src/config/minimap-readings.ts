/**
 * What the minimap reads, per mode and horizon: the one table its shading,
 * its accessible names and its provenance line derive from. The owner's
 * acceptance sentence (2026-09-25): each mode's minimap shows that mode's
 * regional readings from the product the mode loaded, under its declared
 * filter.
 *
 * A cell names the loaded product the minimap reads and the rule that takes
 * a regional reading from it. A cell with no reading, or with a reading that
 * is off, leaves the minimap navigation-only: it shades no framing, says so
 * in the unshaded words, and names nothing it does not show. The Record types
 * require a cell for every mode and horizon of `HAZARD_CLUSTERS`, and
 * tests/minimap-readings.test.mjs holds every reading's product to that
 * horizon's recipe, so no cell can read a product its horizon does not load.
 *
 * DRAFT rows: a regional reading of an outlook is a derived presentation of
 * an agency's product, so its rule and its words are the owner's decision.
 * Each ships off (`on: false`), which keeps its horizon navigation-only, until
 * the owner turns it on. Their one rule, `classes-drawn`, names the issuer
 * classes the loaded outlook draws over a framing in the issuer's own words
 * (src/state/minimap-outlook.ts); it computes no area, share, rank or band.
 */

import type { HazardClusterKey, TemporalHorizonKey } from './clusters';
import { framingMinimapProvenance } from './framings';
import type { FramingKey } from './framings';
import { getLayerDef } from './layers';
import type { LayerKey } from './layers';
import {
  CPC_EXTENDED_COLORS,
  CPC_SEASONAL_COLORS,
  OUTLOOK_LEGEND,
  SPC_FIREWX_CATEGORIES,
} from './palette';

/** One issuer class, named and coloured as the product's own legend shows it. */
export interface MinimapOutlookClass {
  readonly label: string;
  readonly color: string;
}

/** Where a classes-drawn reading finds what its layer drew, and the issuer's classes in legend order. */
export interface MinimapOutlookSource {
  /** The layer's GeoJSON source on the map: what it drew, under its own filter. */
  readonly source: string;
  readonly classes: readonly MinimapOutlookClass[];
  /** A drawn feature's class as an index into `classes`, or -1 when the legend does not name it. */
  readonly classOf: (properties: Readonly<Record<string, unknown>> | null) => number;
}

export type MinimapReading =
  | {
      /** Shipped: src/state/minimap-drought.ts and src/state/minimap-wildfire.ts. */
      readonly rule: 'nadm-framing-summary' | 'nifc-perimeter-count';
      readonly product: LayerKey;
      readonly on: boolean;
    }
  | {
      readonly rule: 'classes-drawn';
      readonly product: LayerKey;
      readonly on: boolean;
      readonly outlook: MinimapOutlookSource;
    };

export interface MinimapCell {
  readonly reading?: MinimapReading;
  /** Navigation-only, the mode's own clause saying why no framing is shaded is true here. */
  readonly unshadedWhy?: true;
  /** Navigation-only, the scale slot names the basin-wide index (EF-6). */
  readonly index?: 'roni';
}

type CpcRow = {
  readonly cat: string;
  readonly prob: number;
  readonly label: string;
  readonly color: readonly number[];
};

/** A CPC outlook layer's renderer classes (cat and prob), as its own adapter draws them. */
function cpcOutlook(source: LayerKey, rows: readonly CpcRow[]): MinimapOutlookSource {
  return {
    source,
    classes: rows.map(({ label, color: [r, g, b, a = 255] }) => ({
      label,
      color: `rgba(${r},${g},${b},${a / 255})`,
    })),
    classOf: (properties) =>
      rows.findIndex((row) => properties?.['cat'] === row.cat && properties['prob'] === row.prob),
  };
}

/** The drought outlook's drawn `outlook` values, in OUTLOOK_LEGEND's order (src/layers/drought.ts). */
const DROUGHT_OUTLOOK_VALUES: readonly unknown[] = ['Persistence', 'Development', 'Improvement', 'Removal'];

const DROUGHT_OUTLOOK: MinimapOutlookSource = {
  source: 'drought-outlook',
  classes: OUTLOOK_LEGEND,
  classOf: (properties) => DROUGHT_OUTLOOK_VALUES.indexOf(properties?.['outlook']),
};

const SPC_FIRE_WEATHER: MinimapOutlookSource = {
  source: 'spc-fire-weather',
  classes: SPC_FIREWX_CATEGORIES,
  classOf: (properties) =>
    SPC_FIREWX_CATEGORIES.findIndex((category) => category.dn === Number(properties?.['dn'])),
};

export const MINIMAP_READINGS: Readonly<
  Record<HazardClusterKey, Readonly<Record<TemporalHorizonKey, MinimapCell>>>
> = {
  drought: {
    current: { reading: { rule: 'nadm-framing-summary', product: 'nadm-drought', on: true } },
    // DRAFT row (owner's decision): the CPC Monthly Drought Outlook classes drawn in each framing.
    'weeks-ahead': {
      reading: { rule: 'classes-drawn', product: 'drought', on: false, outlook: DROUGHT_OUTLOOK },
    },
    // DRAFT row (owner's decision): the CPC Seasonal Drought Outlook classes drawn in each framing.
    'season-ahead': {
      reading: { rule: 'classes-drawn', product: 'drought', on: false, outlook: DROUGHT_OUTLOOK },
    },
  },
  wildfire: {
    current: { reading: { rule: 'nifc-perimeter-count', product: 'nifc-fires', on: true } },
    // DRAFT row (owner's decision): the SPC Day 1 fire weather categories drawn in each framing.
    'weeks-ahead': {
      reading: { rule: 'classes-drawn', product: 'spc-fire-weather', on: false, outlook: SPC_FIRE_WEATHER },
    },
    // The WHP raster on the map gives no issuer-class reading per framing, and
    // the bundled WHP overview holds only merged classes over DDM thresholds.
    'season-ahead': {},
  },
  heat: {
    current: { unshadedWhy: true },
    'weeks-ahead': { unshadedWhy: true },
    // No surface: HeatRisk is not drawn here, so its clause would not be true.
    'season-ahead': {},
  },
  enso: {
    current: { unshadedWhy: true, index: 'roni' },
    // DRAFT row (owner's decision): the CPC 8-14 day precipitation outlook classes drawn in each framing.
    'weeks-ahead': {
      reading: {
        rule: 'classes-drawn',
        product: 'cpc-814-precip',
        on: false,
        outlook: cpcOutlook('cpc-814-precip', CPC_EXTENDED_COLORS.precipitation),
      },
      unshadedWhy: true,
      index: 'roni',
    },
    // DRAFT row (owner's decision): the CPC seasonal precipitation outlook classes drawn in each framing.
    'season-ahead': {
      reading: {
        rule: 'classes-drawn',
        product: 'cpc-seasonal-precip',
        on: false,
        outlook: cpcOutlook('cpc-seasonal-precip', CPC_SEASONAL_COLORS.precipitation),
      },
      unshadedWhy: true,
      index: 'roni',
    },
  },
};

/** The reading the minimap takes at this mode and horizon, or null: navigation-only. */
export function minimapReading(
  mode: HazardClusterKey,
  horizon: TemporalHorizonKey,
): MinimapReading | null {
  const reading = MINIMAP_READINGS[mode][horizon].reading;
  return reading?.on ? reading : null;
}

/** The scale slot's basin-wide index here, when the minimap is navigation-only. */
export function minimapIndexLabel(
  mode: HazardClusterKey,
  horizon: TemporalHorizonKey,
): 'roni' | undefined {
  return minimapReading(mode, horizon) === null ? MINIMAP_READINGS[mode][horizon].index : undefined;
}

/** A product's own catalog name (src/config/layers.ts). */
export function minimapProductName(product: LayerKey): string {
  return getLayerDef(product)?.name ?? product;
}

/**
 * The minimap's provenance clause at this mode and horizon: what informs it,
 * or why it shades nothing, only where that is true; undefined when nothing
 * is. A shipped reading and a navigation-only cell keep the mode's own words
 * (`framingMinimapProvenance`); a null key asks for the mode-wide clause.
 */
export function minimapProvenanceAt(
  key: FramingKey | null,
  mode: HazardClusterKey,
  horizon: TemporalHorizonKey,
): string | undefined {
  const reading = minimapReading(mode, horizon);
  if (reading?.rule === 'classes-drawn') {
    // DRAFT wording (owner's decision, minimap readings): shown only while a row is on.
    return `The ${minimapProductName(reading.product)} informs this minimap.`;
  }
  return reading !== null || MINIMAP_READINGS[mode][horizon].unshadedWhy
    ? framingMinimapProvenance(key, mode)
    : undefined;
}

export type MinimapOutlookStatus = 'idle' | 'loading' | 'live' | 'unavailable';

/** One framing's classes-drawn reading: the issuer's class words verbatim. */
export function outlookFramingWords(
  name: string,
  status: MinimapOutlookStatus,
  labels: readonly string[],
): string {
  const body =
    status === 'live'
      ? labels.join('; ') || 'no area drawn'
      : status === 'unavailable'
        ? 'unavailable'
        : 'loading';
  // DRAFT wording (owner's decision, minimap readings): shown only while a row is on.
  return `${name} in this framing: ${body}.`;
}

/** The scale slot for a classes-drawn reading: the product's own name and its read state. */
export function outlookScaleText(name: string, status: MinimapOutlookStatus): string {
  // DRAFT wording (owner's decision, minimap readings): shown only while a row is on.
  return status === 'live' ? name : `${name} · ${status === 'unavailable' ? 'unavailable' : 'loading'}`;
}
