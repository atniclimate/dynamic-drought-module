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
  readonly droughtImpact: {
    readonly enabled: boolean;
    readonly note: string | null;
  };
  readonly sources: Readonly<Record<BriefingSourceKey, SourceCapabilityCell>>;
}

function regionalCell(
  enabled: boolean,
  source: BriefingSourceKey,
  unavailableNote: string
): SourceCapabilityCell {
  return enabled
    ? {
        state: 'available',
        note: `${source} remains inside the validated regional impact synthesis.`
      }
    : { state: 'unavailable', note: unavailableNote };
}

/**
 * Resolve the complete per-source policy for one selection. Geography
 * controls nationally supported heat sources. The coverage/capability
 * matrix, read through the resolved PLACE (DR-090), continues to control
 * drought, fire, climate, water, and resource synthesis.
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
  const droughtNote = droughtEnabled
    ? null
    : placeKnown
      ? placeCapabilityNote(geography, 'impactSynthesis')
      : regionCapabilityNote(context.regionKey, 'impactSynthesis');

  const sources = {} as Record<BriefingSourceKey, SourceCapabilityCell>;
  for (const key of BRIEFING_SOURCE_KEYS) {
    if (
      key === 'pointHeat' ||
      key === 'nwsForecast' ||
      key === 'nwsAlerts' ||
      key === 'heatRisk' ||
      // DDM-P7-T07, DR-075 a (director ruling 2026-09-09): the coverage
      // gate follows the issuer's own service extent (STEP 0), not the
      // drought-impact-synthesis doctrine region every other non-heat
      // source below reads. Bounded to this one key; every other key keeps
      // the regionalCell branch unchanged.
      key === 'cpcSeasonalTemp'
    ) {
      sources[key] = heat[key];
    } else if (
      // DDM-P7-T03 (DR-022 a): the SPC fire weather outlook's coverage
      // follows its own service extent (SPC_FIRE_OUTLOOK_CAPABILITY),
      // the same national-geography model as cpcSeasonalTemp above,
      // bounded to this one key; every other key keeps the regionalCell
      // branch below unchanged.
      key === 'spcFireOutlook'
    ) {
      sources[key] = SPC_FIRE_OUTLOOK_CAPABILITY[geography.key];
    } else {
      sources[key] = regionalCell(
        droughtEnabled,
        key,
        droughtNote ??
          'This source is outside the validated regional impact synthesis.'
      );
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
