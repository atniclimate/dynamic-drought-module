/**
 * Briefing hydration: fill the three horizons of an `ImpactBriefing` from the
 * live sources, updating the panel progressively as each horizon resolves.
 *
 * The skeleton (`createBriefingSkeleton`) builds the land identity and the
 * routed resources synchronously; this module fills the horizons. Each horizon
 * runs its source fetches concurrently and reports its own status, so a slow
 * or failing source for one horizon never blocks another and never blocks the
 * panel. The master `signal` cancels every in-flight fetch on panel close or
 * reopen (CLAUDE.md section 6 invariant 5); `onUpdate` re-renders the panel in
 * place after each horizon settles.
 *
 * Source-to-horizon mapping (ddm-drought-impact-modeling temporal framing):
 *   Current     USDM category at the point, active NIFC perimeters, active NWS
 *               red-flag and extreme-heat alerts. Observations, plainly stated.
 *   Near-term   Selected NWS HeatRisk forecast classification, NWS point
 *               forecast (temperature tendency), plus the cited CPC 6-10 and
 *               8-14 day outlooks. Outlooks, stated as tendencies.
 *   Long-range  the cited CPC Seasonal Drought Outlook; the ENSO phase tilt is
 *               layered onto this horizon by Phase 6.
 */

import {
  fetchCpcOutlookClaims,
  fetchDsciTrendClaims,
  fetchHeatRiskClaims,
  fetchNifcClaims,
  fetchNwsAlertClaims,
  fetchNwsForecastClaims,
  fetchUsdmClaims,
  type SourceResult
} from './sources';
import { fetchEnsoClaims } from './enso';
import { makeClaim } from './evidence';
import { fillHorizon } from './heat-horizon';
import { fetchWaterSupplyClaims } from './water-supply';
import type { ImpactBriefing, SourcedClaim } from './types';

/** Re-render hook; the panel passes `refreshOpenBriefing` bound to its token. */
export type UpdateHook = () => void;

const HEATRISK_FRAMES_EVENT = 'ddm:heatrisk-frames';

/**
 * The cited long-range CPC Seasonal Drought Outlook claim. Fixed prose, not a
 * fetch, so `dates.retrieved` is the date the statement and its link were last
 * verified against the live product (the T-P0-2 contract rule for fixed
 * claims); re-stamp it whenever this text is re-checked.
 */
const CPC_SEASONAL_OUTLOOK: SourcedClaim = makeClaim({
  // vocab-allow: honesty disclaimer, denies being a forecast
  text: 'The CPC Seasonal Drought Outlook is the authoritative long-range drought tendency (drought persists, develops, improves, or is removed) over the coming season. In the Pacific Northwest the El Nino / Southern Oscillation phase shifts these odds; the long-range read is a probability tilt, not a forecast of outcomes.',
  source: 'NOAA CPC Seasonal Drought Outlook',
  sourceUrl: 'https://www.cpc.ncep.noaa.gov/products/expert_assessment/sdo_summary.php',
  evidence: 'outlook',
  dates: { retrieved: '2026-07-21' },
  // vocab-allow: honesty disclaimer, denies being a forecast
  uncertainty: { kind: 'categorical', text: 'a seasonal tendency category (persists, develops, improves, removed), not a forecast of outcomes' }
});

/**
 * Hydrate every horizon of `briefing`. Returns when all horizons have settled
 * (or the signal aborted). Calls `onUpdate` after each horizon is filled so the
 * panel re-renders progressively; the panel's `onUpdate` is a no-op once the
 * panel is closed or superseded.
 */
export async function hydrateBriefing(
  briefing: ImpactBriefing,
  signal: AbortSignal,
  onUpdate: UpdateHook
): Promise<void> {
  const { context, horizons } = briefing;
  let heatGeneration = 0;
  let nearTermBase: readonly [SourceResult, SourceResult] | null = null;
  let latestHeatRisk: SourceResult | null = null;

  const publishNearTerm = (): void => {
    if (signal.aborted || !nearTermBase || !latestHeatRisk) return;
    fillHorizon(horizons.nearTerm, [
      latestHeatRisk,
      nearTermBase[0],
      nearTermBase[1]
    ]);
    onUpdate();
  };

  const refreshHeatRisk = (generation: number): void => {
    void fetchHeatRiskClaims(context, signal).then((heatRisk) => {
      if (signal.aborted || generation !== heatGeneration) return;
      latestHeatRisk = heatRisk;
      publishNearTerm();
    });
  };

  // Establish the generation and listener before any source begins. A frame
  // event invalidates the initial read immediately, so a later current-source
  // completion cannot publish a classification for a superseded raster.
  const onHeatRiskFrame = (): void => {
    const generation = ++heatGeneration;
    latestHeatRisk = { claims: [], ok: true };
    publishNearTerm();
    refreshHeatRisk(generation);
  };
  const removeHeatListener = (): void => {
    window.removeEventListener(HEATRISK_FRAMES_EVENT, onHeatRiskFrame);
  };
  window.addEventListener(HEATRISK_FRAMES_EVENT, onHeatRiskFrame);
  signal.addEventListener('abort', removeHeatListener, { once: true });

  const initialHeatGeneration = heatGeneration;
  const initialHeatRisk = fetchHeatRiskClaims(context, signal);

  const longRange = (async (): Promise<void> => {
    // The ENSO phase tilt leads, then the NWRFC water-supply pairing
    // (observed runoff to date plus the seasonal volume forecast; the
    // projection partner to the snowpack observations), then the cited CPC
    // Seasonal Drought Outlook.
    const [enso, waterSupply] = await Promise.all([
      fetchEnsoClaims(context, signal),
      fetchWaterSupplyClaims(context, signal)
    ]);
    if (signal.aborted) return;
    fillHorizon(horizons.longRange, [enso, waterSupply], [CPC_SEASONAL_OUTLOOK]);
    onUpdate();
  })();

  const current = (async (): Promise<void> => {
    const results = await Promise.all([
      fetchUsdmClaims(context, signal),
      fetchDsciTrendClaims(context, signal),
      fetchNifcClaims(context, signal),
      fetchNwsAlertClaims(context, signal)
    ]);
    if (signal.aborted) return;
    fillHorizon(horizons.current, results);
    onUpdate();
  })();

  const nearTerm = (async (): Promise<void> => {
    // Selected HeatRisk frame, NWS point forecast (the immediate days), then
    // the CPC 6-10 and 8-14 day probability tilt, so the claims read
    // chronologically outward.
    const [heatRisk, forecast, cpc] = await Promise.all([
      initialHeatRisk,
      fetchNwsForecastClaims(context, signal),
      fetchCpcOutlookClaims(context, signal)
    ]);
    if (signal.aborted) return;
    nearTermBase = [forecast, cpc];
    if (initialHeatGeneration === heatGeneration) {
      latestHeatRisk = heatRisk;
    }
    publishNearTerm();
  })();

  await Promise.all([longRange, current, nearTerm]);
}
