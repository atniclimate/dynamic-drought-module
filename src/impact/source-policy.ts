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
 * Resolve the complete per-source policy for one selection. Geography controls
 * nationally supported heat sources. The existing regional capability matrix
 * continues to control drought, fire, climate, water, and resource synthesis.
 */
export function briefingSourcePolicy(
  context: BoundarySelectionContext
): BriefingSourcePolicy {
  const geography = resolveCanonicalGeography(context);
  const heat = NATIONAL_HEAT_SOURCE_CAPABILITY[geography.key];
  const impactLevel = regionCapabilityLevel(
    context.regionKey,
    'impactSynthesis'
  );
  const droughtEnabled = impactLevel !== 'none';
  const droughtNote = droughtEnabled
    ? null
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
