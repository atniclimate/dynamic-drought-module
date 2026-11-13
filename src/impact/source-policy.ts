import {
  resolveCanonicalGeography,
  type CanonicalGeography
} from '../config/geography';
import {
  BRIEFING_SOURCE_KEYS,
  NATIONAL_HEAT_SOURCE_CAPABILITY,
  SPC_FIRE_OUTLOOK_CAPABILITY,
  type BriefingSourceKey,
  type SourceCapabilityCell
} from '../config/source-capability';
import {
  placeCapabilityLevel,
  placeCapabilityNote
} from '../config/place-coverage';
import {
  regionCapabilityLevel,
  regionCapabilityNote
} from '../config/region-capability';
import { pointHasHeatRiskCoverage } from '../layers/heatrisk-coverage';
import type { BoundarySelectionContext } from './types';

export interface BriefingSourcePolicy {
  readonly geography: CanonicalGeography;
  /**
   * The Northwest-validated regional synthesis, read through the place's
   * coverage family. Since DR-256 it gates only what is curated for the
   * Pacific Northwest: the routed resources and the Pacific Northwest ENSO
   * tendency claim. It no longer gates any other source or the matrix.
   */
  readonly droughtImpact: {
    readonly enabled: boolean;
    readonly note: string | null;
  };
  readonly sources: Readonly<Record<BriefingSourceKey, SourceCapabilityCell>>;
}

/**
 * The United States geographies the remaining sources read in (DR-256): each
 * issuer's service answers per point or per State there, and the adapter
 * states its own absence (USDM's no-polygon sentence, DSCI's State
 * requirement, the NWRFC domain gate in water-supply.ts). Puerto Rico and the
 * other territories keep the gate they had, since no code states those
 * services' extent there.
 */
const UNITED_STATES_SOURCE_GEOGRAPHY: ReadonlySet<CanonicalGeography['key']> = new Set([
  'conus',
  'alaska',
  'hawaii'
]);

/** The plain name of each source, for the Technical information list of sources that do not cover a place. */
export const BRIEFING_SOURCE_LABELS: Readonly<Record<BriefingSourceKey, string>> = {
  pointHeat: 'NWS point observation and grid guidance',
  // vocab-allow: names the NWS point forecast, upstream product
  nwsForecast: 'NWS point forecast',
  // vocab-allow: names the NWS active alerts service, upstream product
  nwsAlerts: 'NWS active alerts',
  heatRisk: 'NWS HeatRisk',
  usdm: 'U.S. Drought Monitor',
  dsci: 'USDM Drought Severity and Coverage Index',
  nifc: 'NIFC current mapped fire perimeters',
  cpcExtended: 'NOAA CPC 6-10 and 8-14 day outlooks',
  enso: 'NOAA CPC ENSO index',
  waterSupply: 'NWRFC water supply outlook',
  cpcSeasonal: 'NOAA CPC Seasonal Drought Outlook',
  cpcSeasonalTemp: 'NOAA CPC seasonal temperature outlook',
  spcFireOutlook: 'NOAA SPC Fire Weather Outlook'
};

/**
 * Resolve the complete per-source policy for one selection (DR-256: national
 * by source). Each source reads wherever its issuer's own service covers the
 * place: the heat sources, the CPC seasonal temperature outlook and the SPC
 * fire weather outlook by their stated extents, the rest across the United
 * States geographies above. The coverage/capability matrix, read through the
 * resolved PLACE (DR-090), now gates only the Northwest-curated resources.
 */
export function briefingSourcePolicy(
  context: BoundarySelectionContext
): BriefingSourcePolicy {
  const geography = resolveCanonicalGeography(context);
  const heat = NATIONAL_HEAT_SOURCE_CAPABILITY[geography.key];
  // DR-090: impact synthesis is gated by the resolved PLACE's coverage, not
  // by `context.regionKey` (the camera). A geography with
  // `basis: 'boundary-postal-code'` came from the place itself (a postal
  // code in the feature's properties or `containing.state`), and only that
  // basis does: the gate reads the place's coverage family through
  // src/config/place-coverage.ts and the camera has no say.
  //
  // THE REMAINING FALLBACK TO THE CAMERA REGION, named here at its line:
  // every other basis ('region-framing', 'boundary-source', 'unknown') is
  // stamped by `regionFallback` (src/config/geography.ts), which fires only
  // when the place is silent (no postal-code property AND
  // `containing.basis === 'none'`). The place's coverage is then unknown, so
  // the gate reads the camera region's family, exactly the answer it gave
  // before DR-090 for a silent place; a null or unrecognized region still
  // reads 'none'. Exercised in both directions by
  // tests/camera-region-fallbacks.spec.ts.
  const placeKnown = geography.basis === 'boundary-postal-code';
  const impactLevel = placeKnown
    ? placeCapabilityLevel(geography, 'impactSynthesis')
    : regionCapabilityLevel(context.regionKey, 'impactSynthesis');
  const droughtEnabled = impactLevel !== 'none';
  const familyNote = placeKnown
    ? placeCapabilityNote(geography, 'impactSynthesis')
    : regionCapabilityNote(context.regionKey, 'impactSynthesis');
  const droughtNote = droughtEnabled ? null : familyNote;

  const sources = {} as Record<BriefingSourceKey, SourceCapabilityCell>;
  for (const key of BRIEFING_SOURCE_KEYS) {
    if (
      key === 'pointHeat' ||
      key === 'nwsForecast' ||
      key === 'nwsAlerts' ||
      key === 'heatRisk' ||
      // DDM-P7-T07, DR-075 a (director ruling 2026-09-09): the coverage
      // gate follows the issuer's own service extent (STEP 0).
      key === 'cpcSeasonalTemp'
    ) {
      sources[key] = heat[key];
    } else if (
      // DDM-P7-T03 (DR-022 a): the SPC fire weather outlook's coverage
      // follows its own service extent (SPC_FIRE_OUTLOOK_CAPABILITY),
      // the same national-geography model as cpcSeasonalTemp above.
      key === 'spcFireOutlook'
    ) {
      sources[key] = SPC_FIRE_OUTLOOK_CAPABILITY[geography.key];
    } else {
      // A place the Northwest synthesis already read keeps reading; outside
      // the United States geographies the family's own note stands (Canada,
      // transboundary, an unrecognised place), as before DR-256.
      sources[key] =
        droughtEnabled || UNITED_STATES_SOURCE_GEOGRAPHY.has(geography.key)
          ? { state: 'available', note: `${key} reads where its issuer's service covers the place.` }
          : { state: 'unavailable', note: familyNote };
    }
  }

  if (
    sources.heatRisk.state !== 'unavailable' &&
    !pointHasHeatRiskCoverage(context.lngLat.lng, context.lngLat.lat)
  ) {
    sources.heatRisk = {
      state: 'unavailable',
      note: 'The selected point is outside the shipped CONUS HeatRisk coverage.'
    };
  }

  return {
    geography,
    droughtImpact: { enabled: droughtEnabled, note: droughtNote },
    sources
  };
}

export function sourceMayRun(
  policy: BriefingSourcePolicy,
  source: BriefingSourceKey
): boolean {
  return policy.sources[source].state !== 'unavailable';
}

/**
 * The matrix sources that do not cover this place, grouped by their own
 * capability note so each source and each note is named once (DR-256, B2).
 * Point heat is left out: its own section states its state.
 */
export function uncoveredSourceGroups(
  policy: BriefingSourcePolicy
): { readonly labels: readonly string[]; readonly note: string }[] {
  const byNote = new Map<string, string[]>();
  for (const key of BRIEFING_SOURCE_KEYS) {
    if (key === 'pointHeat' || sourceMayRun(policy, key)) continue;
    const note = policy.sources[key].note;
    byNote.set(note, [...(byNote.get(note) ?? []), BRIEFING_SOURCE_LABELS[key]]);
  }
  return [...byNote].map(([note, labels]) => ({ labels, note }));
}
