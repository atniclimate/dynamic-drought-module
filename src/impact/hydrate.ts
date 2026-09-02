/**
 * Briefing hydration: fill the three horizons of an `ImpactBriefing` from the
 * live sources, updating the panel progressively as each horizon resolves.
 *
 * The skeleton (`createBriefingSkeleton`) builds the land identity and the
 * routed resources synchronously; this module fills the horizons. Each horizon
 * runs its source fetches concurrently and reports its own status, so a slow
 * or failing source for one horizon never blocks another and never blocks the
 * panel. The master `signal` cancels every in-flight fetch on panel close or
 * reopen (the cancellation invariant); `onUpdate` re-renders the panel in
 * place after each horizon settles.
 *
 * Source-to-horizon mapping (ddm-drought-impact-modeling temporal framing):
 *   Current     USDM category at the point, mapped NIFC perimeters, active NWS
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
import { makeClaim } from './evidence';
import { fillHorizon } from './heat-horizon';
import { synthesizeHeatSources } from './heat-synthesis';
import { createNwsRequestSession } from './nws-point';
import { sourceMayRun } from './source-policy';
import { fetchWaterSupplyClaims } from './water-supply';
import type {
  BoundarySelectionContext,
  ImpactBriefing,
  SourcedClaim
} from './types';

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
 * Load the ENSO reader on demand.
 *
 * The long-range horizon gates the ENSO read on its own capability cell, so
 * outside the validated regional impact synthesis `fetchEnsoClaims` is never
 * called; a static import downloaded the whole ENSO module (its guards, its
 * chart builder and its cited prose) on every briefing regardless. The import
 * runs inside the horizon's existing await, after the panel is open and while
 * the other horizons fetch, so it costs no visible latency, and the minimap's
 * phase-label consumer already reaches this module the same way.
 *
 * A failed module load is reported exactly as a failed snapshot read, because
 * that is what it is from the panel's side: no ENSO claims, `ok: false`, and
 * the same note the module itself returns. It never rejects, so it can never
 * take down the horizon it shares with the water-supply read.
 */
async function loadEnsoClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  try {
    const { fetchEnsoClaims } = await import('./enso');
    if (signal.aborted) return { claims: [], ok: false };
    return await fetchEnsoClaims(context, signal);
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] ENSO snapshot read failed.', err);
    return { claims: [], ok: false, note: 'The ENSO index snapshot was unavailable.' };
  }
}

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
  const { context, horizons, sourcePolicy } = briefing;
  const nwsSession = createNwsRequestSession(signal);
  const heatResults = new Map<
    'heatRisk' | 'nwsForecast' | 'nwsAlerts',
    SourceResult
  >();
  const initialHeatSources = (
    ['heatRisk', 'nwsForecast', 'nwsAlerts'] as const
  ).filter((key) => sourceMayRun(sourcePolicy, key));
  let heatGeneration = 0;
  let heatRiskSettled = !initialHeatSources.includes('heatRisk');
  let heatPending =
    initialHeatSources.length +
    (sourceMayRun(sourcePolicy, 'pointHeat') ? 1 : 0);

  const publishHeatSynthesis = (): void => {
    if (signal.aborted) return;
    briefing.heatSynthesis = synthesizeHeatSources(
      briefing.pointHeat,
      [...heatResults.values()],
      heatPending === 0
    );
    onUpdate();
  };

  const settleHeatResult = (
    key: 'nwsForecast' | 'nwsAlerts',
    result: SourceResult
  ): SourceResult => {
    heatResults.set(key, result);
    heatPending = Math.max(0, heatPending - 1);
    publishHeatSynthesis();
    return result;
  };

  const settleHeatRisk = (
    generation: number,
    result: SourceResult
  ): SourceResult => {
    if (signal.aborted || generation !== heatGeneration) return result;
    heatResults.set('heatRisk', result);
    if (!heatRiskSettled) {
      heatRiskSettled = true;
      heatPending = Math.max(0, heatPending - 1);
    }
    publishHeatSynthesis();
    return result;
  };

  if (!sourcePolicy.droughtImpact.enabled) {
    const note =
      sourcePolicy.droughtImpact.note ??
      'Drought impact synthesis is unavailable for this selection.';
    for (const horizon of [
      horizons.current,
      horizons.nearTerm,
      horizons.longRange
    ]) {
      horizon.status = 'unavailable';
      horizon.claims = [];
      horizon.note = note;
    }
    onUpdate();
  }

  const pointHeat = sourceMayRun(sourcePolicy, 'pointHeat')
    ? import('./point-heat')
        .then(({ fetchPointHeat }) => fetchPointHeat(context, nwsSession))
        .then((pointHeatResult) => {
          if (signal.aborted) return;
          briefing.pointHeat = pointHeatResult;
          heatPending = Math.max(0, heatPending - 1);
          publishHeatSynthesis();
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          console.warn('[impact] point heat hydration failed.', err);
          const note = 'The NWS point heat source did not respond.';
          briefing.pointHeat = {
            status: 'error',
            note,
            point: { ...context.lngLat },
            observation: { status: 'error', note, metrics: [] },
            grid: { status: 'error', note, metrics: [] }
          };
          heatPending = Math.max(0, heatPending - 1);
          publishHeatSynthesis();
        })
    : Promise.resolve();

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
      settleHeatRisk(generation, heatRisk);
      publishNearTerm();
    });
  };

  if (sourceMayRun(sourcePolicy, 'heatRisk')) {
    // Establish the generation and listener before any source begins. A frame
    // event invalidates the initial read immediately, so a later source
    // completion cannot publish a classification for a superseded raster.
    const onHeatRiskFrame = (): void => {
      const generation = ++heatGeneration;
      latestHeatRisk = { claims: [], ok: true };
      heatResults.delete('heatRisk');
      if (heatRiskSettled) {
        heatRiskSettled = false;
        heatPending += 1;
      }
      publishHeatSynthesis();
      publishNearTerm();
      refreshHeatRisk(generation);
    };
    const removeHeatListener = (): void => {
      window.removeEventListener(HEATRISK_FRAMES_EVENT, onHeatRiskFrame);
    };
    window.addEventListener(HEATRISK_FRAMES_EVENT, onHeatRiskFrame);
    signal.addEventListener('abort', removeHeatListener, { once: true });
  }

  const initialHeatGeneration = heatGeneration;
  const initialHeatRisk: Promise<SourceResult | null> = sourceMayRun(
    sourcePolicy,
    'heatRisk'
  )
    ? fetchHeatRiskClaims(context, signal).then((result) =>
        settleHeatRisk(initialHeatGeneration, result)
      )
    : Promise.resolve(null);
  const forecast: Promise<SourceResult | null> = sourceMayRun(
    sourcePolicy,
    'nwsForecast'
  )
    ? fetchNwsForecastClaims(context, signal, nwsSession).then((result) =>
        settleHeatResult('nwsForecast', result)
      )
    : Promise.resolve(null);
  const alerts: Promise<SourceResult | null> = sourceMayRun(
    sourcePolicy,
    'nwsAlerts'
  )
    ? fetchNwsAlertClaims(context, signal, nwsSession).then((result) =>
        settleHeatResult('nwsAlerts', result)
      )
    : Promise.resolve(null);

  const longRange = (async (): Promise<void> => {
    if (!sourcePolicy.droughtImpact.enabled) return;
    // Each long-range source is gated by its own declared capability cell
    // (IB-06 / ENSO-09): all three were declared in BRIEFING_SOURCE_KEYS but
    // only the horizon as a whole was gated, so the cells were never enforced.
    const runEnso = sourceMayRun(sourcePolicy, 'enso');
    const runWaterSupply = sourceMayRun(sourcePolicy, 'waterSupply');
    const runCpcSeasonal = sourceMayRun(sourcePolicy, 'cpcSeasonal');
    if (!runEnso && !runWaterSupply && !runCpcSeasonal) {
      horizons.longRange.status = 'unavailable';
      horizons.longRange.claims = [];
      horizons.longRange.note = sourcePolicy.sources.enso.note;
      onUpdate();
      return;
    }

    // The ENSO phase tilt leads, then the NWRFC water-supply pairing
    // (observed runoff to date plus the seasonal volume forecast; the
    // projection partner to the snowpack observations), then the cited CPC
    // Seasonal Drought Outlook.
    //
    // The two fetches settle INDEPENDENTLY: the ENSO read is a bundled
    // snapshot that returns almost at once, while the proxied NWRFC round
    // trip carries a 20 second budget, and a single Promise.all made the
    // whole horizon wait on the slower one. Ordering is preserved by keying
    // the settled results, not by arrival.
    const settled = new Map<'enso' | 'waterSupply', SourceResult>();
    const order: ReadonlyArray<'enso' | 'waterSupply'> = ['enso', 'waterSupply'];
    let pending = (runEnso ? 1 : 0) + (runWaterSupply ? 1 : 0);

    const publishLongRange = (): void => {
      if (signal.aborted) return;
      const results = order
        .map((key) => settled.get(key))
        .filter((result): result is SourceResult => result !== undefined);
      fillHorizon(
        horizons.longRange,
        results,
        runCpcSeasonal ? [CPC_SEASONAL_OUTLOOK] : []
      );
      if (pending > 0) {
        // A source is still in flight, so the horizon has NOT settled: what is
        // already in hand reads live (partial), and an empty horizon keeps its
        // loading state rather than announcing an absence that may yet fill.
        horizons.longRange.status =
          horizons.longRange.claims.length > 0 ? 'partial' : 'loading';
      }
      onUpdate();
    };

    const settle = (
      key: 'enso' | 'waterSupply',
      result: SourceResult
    ): void => {
      if (signal.aborted) return;
      settled.set(key, result);
      pending = Math.max(0, pending - 1);
      publishLongRange();
    };

    await Promise.all([
      runEnso
        ? loadEnsoClaims(context, signal).then((result) => settle('enso', result))
        : Promise.resolve(),
      runWaterSupply
        ? fetchWaterSupplyClaims(context, signal).then((result) =>
            settle('waterSupply', result)
          )
        : Promise.resolve()
    ]);
    if (signal.aborted) return;
    // Both sources are gated off but the fixed seasonal claim may still run.
    if (pending === 0 && settled.size === 0) publishLongRange();
  })();

  const current = (async (): Promise<void> => {
    if (!sourcePolicy.droughtImpact.enabled) return;
    const results = (await Promise.all([
      sourceMayRun(sourcePolicy, 'usdm')
        ? fetchUsdmClaims(context, signal)
        : Promise.resolve(null),
      sourceMayRun(sourcePolicy, 'dsci')
        ? fetchDsciTrendClaims(context, signal)
        : Promise.resolve(null),
      sourceMayRun(sourcePolicy, 'nifc')
        ? fetchNifcClaims(context, signal)
        : Promise.resolve(null),
      alerts
    ])).filter((result): result is SourceResult => result !== null);
    if (signal.aborted) return;
    fillHorizon(horizons.current, results);
    onUpdate();
  })();

  const nearTerm = (async (): Promise<void> => {
    const [heatRisk, forecastResult, cpc] = await Promise.all([
      initialHeatRisk,
      forecast,
      sourcePolicy.droughtImpact.enabled &&
      sourceMayRun(sourcePolicy, 'cpcExtended')
        ? fetchCpcOutlookClaims(context, signal)
        : Promise.resolve(null)
    ]);
    if (signal.aborted) return;
    if (!sourcePolicy.droughtImpact.enabled) return;
    nearTermBase = [
      forecastResult ?? { claims: [], ok: true },
      cpc ?? { claims: [], ok: true }
    ];
    if (initialHeatGeneration === heatGeneration) {
      latestHeatRisk = heatRisk ?? { claims: [], ok: true };
    }
    publishNearTerm();
  })();

  if (heatPending === 0) publishHeatSynthesis();
  await Promise.all([longRange, current, nearTerm, pointHeat]);
}
