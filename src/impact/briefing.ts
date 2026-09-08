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

import { buildResources } from './resources';
import { caveatFor, kindLabel } from './context';
import { HORIZON_CHROME } from './horizon-chrome';
import { createHorizonCells, HORIZON_KEYS } from './matrix';
import { briefingSourcePolicy, sourceMayRun } from './source-policy';
import type {
  BoundarySelectionContext,
  Horizon,
  HorizonKey,
  ImpactBriefing
} from './types';

/**
 * An empty horizon in the `loading` state. Its heading comes from
 * `HORIZON_CHROME`, the one table this composer and the eager panel's
 * module-failure presentation both read, so the two cannot drift apart again;
 * `HORIZON_KEYS` supplies the display order.
 */
function emptyHorizon(key: HorizonKey): Horizon {
  const chrome = HORIZON_CHROME[key];
  return {
    key,
    title: chrome.title,
    subtitle: chrome.subtitle,
    cells: createHorizonCells(key),
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
  const sourcePolicy = briefingSourcePolicy(context);
  const horizonByKey = {} as Record<HorizonKey, Horizon>;
  for (const key of HORIZON_KEYS) {
    horizonByKey[key] = emptyHorizon(key);
  }

  return {
    context,
    sourcePolicy,
    landTitle: context.title,
    landKind: kindLabel(context.kind),
    landCaveat: caveatFor(context.kind),
    landscape: {
      status: 'loading',
      facts: [],
      sources: []
    },
    pointHeat: {
      status: sourceMayRun(sourcePolicy, 'pointHeat') ? 'loading' : 'error',
      ...(sourceMayRun(sourcePolicy, 'pointHeat')
        ? {}
        : { note: sourcePolicy.sources.pointHeat.note }),
      point: { ...context.lngLat },
      observation: {
        status: sourceMayRun(sourcePolicy, 'pointHeat') ? 'loading' : 'error',
        ...(sourceMayRun(sourcePolicy, 'pointHeat')
          ? {}
          : { note: sourcePolicy.sources.pointHeat.note }),
        metrics: []
      },
      grid: {
        status: sourceMayRun(sourcePolicy, 'pointHeat') ? 'loading' : 'error',
        ...(sourceMayRun(sourcePolicy, 'pointHeat')
          ? {}
          : { note: sourcePolicy.sources.pointHeat.note }),
        metrics: []
      }
    },
    heatSynthesis: {
      status:
        sourceMayRun(sourcePolicy, 'pointHeat') ||
        sourceMayRun(sourcePolicy, 'heatRisk') ||
        sourceMayRun(sourcePolicy, 'nwsForecast') ||
        sourceMayRun(sourcePolicy, 'nwsAlerts')
          ? 'loading'
          : 'error',
      reads: [],
      ...(
        sourceMayRun(sourcePolicy, 'pointHeat') ||
        sourceMayRun(sourcePolicy, 'heatRisk') ||
        sourceMayRun(sourcePolicy, 'nwsForecast') ||
        sourceMayRun(sourcePolicy, 'nwsAlerts')
          ? {}
          : { note: 'No heat source is available for this selected geography.' }
      )
    },
    horizons: {
      current: horizonByKey.current,
      nearTerm: horizonByKey.nearTerm,
      longRange: horizonByKey.longRange
    },
    resources: sourcePolicy.droughtImpact.enabled ? buildResources(context) : []
  };
}
