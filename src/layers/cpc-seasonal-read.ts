import type { FeatureCollection } from 'geojson';
import { URLS } from '../config/urls';
import { parseArcGisPolygonFeatureCollection } from '../config/wildfire-presentation';
import { fetchBufferedWithBudget } from '../util/fetch';

export type CpcSeasonalVariable = 'precipitation' | 'temperature';
/** The CPC outlook product: the seasonal Lead 1, or the 6-10 or 8-14 day outlook. */
export type CpcOutlookWindow = 'seasonal' | '6-10' | '8-14';
export interface CpcSeasonalReadLimits {
  readonly timeoutMs: number;
  readonly maxDecodedBytes: number;
  readonly maxFeatures: number;
  readonly maxAllowableOffset: number;
}
export interface CpcSeasonalReadState {
  readonly variable: CpcSeasonalVariable;
  readonly status: 'loading' | 'ready' | 'degraded' | 'no-data' | 'error';
  readonly collection: FeatureCollection;
}
const ENDPOINTS: Record<CpcSeasonalVariable, string> = {
  precipitation: URLS.cpcSeasonalPrecipOutlookMapServer,
  temperature: URLS.cpcSeasonalTempOutlookMapServer
};
/** REST layer 0 is the seasonal Lead 1; each 6-10 and 8-14 day service draws
 * temperature in layer 0 and precipitation in layer 1 (its own layer names). */
function layerUrl(variable: CpcSeasonalVariable, outlook: CpcOutlookWindow): string {
  if (outlook === 'seasonal') return `${ENDPOINTS[variable]}/0`;
  return `${outlook === '6-10' ? URLS.cpc610OutlookMapServer : URLS.cpc814OutlookMapServer}/${variable === 'temperature' ? 0 : 1}`;
}
const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function validateLimits(limits: CpcSeasonalReadLimits): void {
  for (const value of [limits.timeoutMs, limits.maxDecodedBytes, limits.maxFeatures]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid CPC read limit.');
  }
  // A default ENSO source must fit the adopted 10-second body deadline.
  if (limits.timeoutMs > 10_000 || !Number.isFinite(limits.maxAllowableOffset) || limits.maxAllowableOffset <= 0) {
    throw new RangeError('Invalid CPC read limit.');
  }
}

/** A required-limit runtime seam; no provider activation or budget defaults.
 * Limits describe decoded bytes, not gzip transfer size. All geometry and
 * raw issuer cat/prob and clock fields (valid_seas and fcst_date; for the
 * 6-10 and 8-14 day outlooks fcst_date, start_date and end_date) survive the shared parser.
 * The map consumer owns clock/legend rendering and must not treat an unknown
 * category as Equal Chances or join two source clocks into one issuance.
 */
export function createCpcSeasonalReader(publish: (state: CpcSeasonalReadState) => void) {
  let generation = 0;
  let current: AbortController | null = null;
  function cancel(): void {
    generation += 1;
    current?.abort();
    current = null;
  }
  async function read(variable: CpcSeasonalVariable, limits: CpcSeasonalReadLimits,
    outlook: CpcOutlookWindow = 'seasonal'): Promise<void> {
    validateLimits(limits);
    cancel();
    const owner = new AbortController();
    const mine = generation;
    current = owner;
    const owns = (): boolean => current === owner && generation === mine && !owner.signal.aborted;
    publish({ variable, status: 'loading', collection: empty() });
    const seasonal = outlook === 'seasonal';
    const params = new URLSearchParams({
      where: '1=1', outFields: seasonal ? 'cat,prob,valid_seas,fcst_date' : 'cat,prob,fcst_date,start_date,end_date',
      returnGeometry: 'true', outSR: '4326', f: 'geojson',
      maxAllowableOffset: String(limits.maxAllowableOffset),
      resultRecordCount: String(limits.maxFeatures)
    });
    let state: CpcSeasonalReadState;
    try {
      // REST layer indexes, never WMS order (layerUrl above).
      const response = await fetchBufferedWithBudget(`${layerUrl(variable, outlook)}/query?${params}`, null, owner.signal, limits.timeoutMs, limits.maxDecodedBytes);
      if (!owns()) return;
      if (!response.ok) throw new Error(`CPC HTTP ${response.status}`);
      const parsed = parseArcGisPolygonFeatureCollection(await response.json(), 'CPC seasonal outlook');
      if (parsed.collection.features.length > limits.maxFeatures) throw new RangeError('CPC feature limit exceeded.');
      state = { variable, collection: parsed.collection,
        status: parsed.truncated ? 'degraded' : parsed.collection.features.length ? 'ready' : 'no-data' };
    } catch {
      // A timeout is unavailable; only this reader's owner abort is silent.
      if (!owns()) return;
      state = { variable, status: 'error', collection: empty() };
    }
    if (!owns()) return;
    current = null;
    publish(state);
  }
  return { read, cancel };
}
