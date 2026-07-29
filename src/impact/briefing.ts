/**
 * Briefing composer: turn a boundary selection into an `ImpactBriefing`.
 *
 * This is the analysis half of the impact feature (data to claims); the panel
 * (`src/ui/impact-panel.ts`) is the rendering half (claims to DOM). The split
 * keeps the honesty contract in one place: a horizon never shows a value it
 * did not get from a source.
 *
 * Phase 2 builds the skeleton: the land identity and the routed resources (the
 * resources are static link-outs, available immediately), with the three
 * temporal horizons marked `loading`. Phase 3 wires the live sources that fill
 * the horizons (`hydrateBriefing`), keeping the two-source standard and the
 * honest-gap rule from ddm-drought-impact-modeling (#6).
 */

import { regionCapabilityLevel } from '../config/region-capability';
import { buildResources } from './resources';
import { caveatFor, kindLabel } from './context';
import type {
  BoundarySelectionContext,
  Horizon,
  HorizonKey,
  ImpactBriefing
} from './types';

interface HorizonSpec {
  readonly key: HorizonKey;
  readonly title: string;
  readonly subtitle: string;
}

/**
 * The three horizons, in display order, with their time-window subtitles from
 * the impact-modeling doctrine (current = now; near-term = days to a season;
 * long-range = season to the water year).
 */
const HORIZON_SPECS: readonly HorizonSpec[] = [
  { key: 'current', title: 'Current conditions', subtitle: 'now' },
  { key: 'nearTerm', title: 'Near-term outlook', subtitle: 'days to a season' },
  { key: 'longRange', title: 'Long-range outlook', subtitle: 'season to water year' }
];

function emptyHorizon(spec: HorizonSpec): Horizon {
  return {
    key: spec.key,
    title: spec.title,
    subtitle: spec.subtitle,
    claims: [],
    status: 'loading'
  };
}

/**
 * Build the briefing skeleton: land identity, routed resources, and three
 * empty horizons in the `loading` state. Static resource routes are populated
 * only where the capability matrix validates impact synthesis and routing;
 * the horizons are filled by Phase 3's `hydrateBriefing`.
 */
export function createBriefingSkeleton(
  context: BoundarySelectionContext
): ImpactBriefing {
  const horizonByKey = {} as Record<HorizonKey, Horizon>;
  for (const spec of HORIZON_SPECS) {
    horizonByKey[spec.key] = emptyHorizon(spec);
  }

  return {
    context,
    landTitle: context.title,
    landKind: kindLabel(context.kind),
    landCaveat: caveatFor(context.kind),
    landscape: {
      status: 'loading',
      facts: [],
      sources: []
    },
    horizons: {
      current: horizonByKey.current,
      nearTerm: horizonByKey.nearTerm,
      longRange: horizonByKey.longRange
    },
    resources:
      regionCapabilityLevel(context.regionKey, 'impactSynthesis') === 'none'
        ? []
        : buildResources(context)
  };
}
