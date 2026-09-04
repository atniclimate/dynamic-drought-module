/**
 * Briefing hydration: fill the twelve cells of an `ImpactBriefing` from the
 * live sources, updating the panel progressively as each lane settles.
 *
 * The skeleton (`createBriefingSkeleton`) builds the land identity and the
 * routed resources synchronously; this module fills the matrix. Every source
 * family is one lane, each lane fetches concurrently, and each lane settles
 * into only the cells `src/impact/matrix.ts` declares for it, so a slow or
 * failing source for one hazard never blocks another hazard and never blocks
 * the panel. The master `signal` cancels every in-flight fetch on panel close
 * or reopen (the cancellation invariant); `onUpdate` re-renders the panel in
 * place after each lane settles.
 *
 * Lane-to-cell mapping (ddm-drought-impact-modeling temporal framing; the
 * authoritative table is `LANE_PLACEMENT` in `src/impact/matrix.ts`):
 *   Drought     USDM point category and statewide DSCI now, the CPC
 *               extended-range outlooks near-term, the NWRFC water-supply
 *               outlook and the cited CPC Seasonal Drought Outlook
 *               season-ahead.
 *   Fire        mapped NIFC perimeters and active NWS red-flag products now.
 *               The near-term and season-ahead cells name the outlooks they
 *               do not yet read (DR-022).
 *   Heat        active NWS extreme-heat products now, the selected HeatRisk
 *               classification and the NWS point temperature tendency
 *               near-term. The season-ahead cell names the CPC seasonal
 *               outlook it does not yet read (DR-019).
 *   ENSO        the observed CPC index state now, the regional tendency and
 *               the official probabilities season-ahead.
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
import { synthesizeHeatSources } from './heat-synthesis';
import {
  applyMatrix,
  markHorizonCells,
  MATRIX_LANE_KEYS,
  type MatrixLaneKey
} from './matrix';
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
 * Hydrate every cell of `briefing`. Returns when every lane has settled (or
 * the signal aborted). Calls `onUpdate` after each lane settles so the panel
 * re-renders progressively; the panel's `onUpdate` is a no-op once the panel
 * is closed or superseded.
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

  // The matrix is rendered only where the capability matrix validates impact
  // synthesis for the selection; elsewhere the panel replaces it with one
  // named unavailable state, so the lanes below settle without publishing.
  const matrixEnabled = sourcePolicy.droughtImpact.enabled;
  const laneResults = new Map<MatrixLaneKey, SourceResult>();

  const publishMatrix = (): void => {
    if (signal.aborted || !matrixEnabled) return;
    applyMatrix(horizons, laneResults);
    onUpdate();
  };

  /** Record one lane's outcome and repaint every cell it can reach. */
  const settleLane = (key: MatrixLaneKey, result: SourceResult): void => {
    if (signal.aborted) return;
    laneResults.set(key, result);
    publishMatrix();
  };

  if (!matrixEnabled) {
    const note =
      sourcePolicy.droughtImpact.note ??
      'Drought impact synthesis is unavailable for this selection.';
    for (const horizon of [
      horizons.current,
      horizons.nearTerm,
      horizons.longRange
    ]) {
      markHorizonCells(horizon, 'unavailable', note);
      horizon.note = note;
    }
    onUpdate();
  }

  // A source the policy gates off settles immediately with the policy's own
  // sentence, so its cells name what is missing and why from the first paint
  // instead of spinning on a fetch that will never start.
  for (const key of MATRIX_LANE_KEYS) {
    if (!sourceMayRun(sourcePolicy, key)) {
      laneResults.set(key, {
        claims: [],
        ok: false,
        note: sourcePolicy.sources[key].note
      });
    }
  }
  // The seasonal outlook is fixed cited prose rather than a fetch, so its
  // lane settles with the briefing's first paint.
  if (sourceMayRun(sourcePolicy, 'cpcSeasonal')) {
    laneResults.set('cpcSeasonal', {
      claims: [CPC_SEASONAL_OUTLOOK],
      ok: true
    });
  }
  publishMatrix();

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
  ): void => {
    heatResults.set(key, result);
    heatPending = Math.max(0, heatPending - 1);
    settleLane(key, result);
    publishHeatSynthesis();
  };

  const settleHeatRisk = (generation: number, result: SourceResult): void => {
    if (signal.aborted || generation !== heatGeneration) return;
    heatResults.set('heatRisk', result);
    if (!heatRiskSettled) {
      heatRiskSettled = true;
      heatPending = Math.max(0, heatPending - 1);
    }
    settleLane('heatRisk', result);
    publishHeatSynthesis();
  };

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

  const refreshHeatRisk = (generation: number): void => {
    void fetchHeatRiskClaims(context, signal).then((heatRisk) => {
      if (signal.aborted || generation !== heatGeneration) return;
      settleHeatRisk(generation, heatRisk);
    });
  };

  if (sourceMayRun(sourcePolicy, 'heatRisk')) {
    // Establish the generation and listener before any source begins. A frame
    // event invalidates the initial read immediately, so a later source
    // completion cannot publish a classification for a superseded raster.
    const onHeatRiskFrame = (): void => {
      const generation = ++heatGeneration;
      heatResults.delete('heatRisk');
      // The lane returns to in flight, so the superseded classification
      // leaves the heat near-term cell at once instead of standing while the
      // new frame is read.
      laneResults.delete('heatRisk');
      if (heatRiskSettled) {
        heatRiskSettled = false;
        heatPending += 1;
      }
      publishMatrix();
      publishHeatSynthesis();
      refreshHeatRisk(generation);
    };
    const removeHeatListener = (): void => {
      window.removeEventListener(HEATRISK_FRAMES_EVENT, onHeatRiskFrame);
    };
    window.addEventListener(HEATRISK_FRAMES_EVENT, onHeatRiskFrame);
    signal.addEventListener('abort', removeHeatListener, { once: true });
  }

  const initialHeatGeneration = heatGeneration;
  const initialHeatRisk: Promise<void> = sourceMayRun(sourcePolicy, 'heatRisk')
    ? fetchHeatRiskClaims(context, signal).then((result) => {
        settleHeatRisk(initialHeatGeneration, result);
      })
    : Promise.resolve();
  const forecast: Promise<void> = sourceMayRun(sourcePolicy, 'nwsForecast')
    ? fetchNwsForecastClaims(context, signal, nwsSession).then((result) => {
        settleHeatResult('nwsForecast', result);
      })
    : Promise.resolve();
  const alerts: Promise<void> = sourceMayRun(sourcePolicy, 'nwsAlerts')
    ? fetchNwsAlertClaims(context, signal, nwsSession).then((result) => {
        settleHeatResult('nwsAlerts', result);
      })
    : Promise.resolve();

  /** Run one fetched lane, or resolve at once when its policy gated it off. */
  const runLane = (
    key: MatrixLaneKey,
    fetcher: () => Promise<SourceResult>
  ): Promise<void> =>
    sourceMayRun(sourcePolicy, key)
      ? fetcher().then((result) => {
          settleLane(key, result);
        })
      : Promise.resolve();

  if (heatPending === 0) publishHeatSynthesis();

  await Promise.all([
    runLane('usdm', () => fetchUsdmClaims(context, signal)),
    runLane('dsci', () => fetchDsciTrendClaims(context, signal)),
    runLane('nifc', () => fetchNifcClaims(context, signal)),
    runLane('cpcExtended', () => fetchCpcOutlookClaims(context, signal)),
    runLane('enso', () => loadEnsoClaims(context, signal)),
    runLane('waterSupply', () => fetchWaterSupplyClaims(context, signal)),
    initialHeatRisk,
    forecast,
    alerts,
    pointHeat
  ]);
}
