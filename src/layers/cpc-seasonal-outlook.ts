import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LayerActivation, LayerModule } from '../config/layers';
import { CPC_SEASONAL_COLORS } from '../config/palette';
import { registry } from '../state/registry';
import { createCpcSeasonalReader, type CpcSeasonalReadLimits, type CpcSeasonalReadState,
  type CpcSeasonalVariable } from './cpc-seasonal-read';

export interface CpcSeasonalAdapterOptions {
  readonly variable: CpcSeasonalVariable;
  readonly limits: CpcSeasonalReadLimits;
  /** Required presentation declaration; must match the admitted key swatches. */
  readonly fillOpacity: number;
  readonly beforeId?: string;
}
export interface CpcSeasonalSnapshot extends CpcSeasonalReadState {
  /** Raw collection includes unknown classes and unmodified per-feature clocks. */
  readonly unknownFeatures: number;
}

export function createCpcSeasonalAdapter(options: CpcSeasonalAdapterOptions):
  LayerModule & { getSnapshot(): CpcSeasonalSnapshot | null } {
  if (!Number.isFinite(options.fillOpacity) || options.fillOpacity < 0 || options.fillOpacity > 1) {
    throw new RangeError('Invalid CPC fill opacity.');
  }
  const key = options.variable === 'precipitation' ? 'cpc-seasonal-precip' : 'cpc-seasonal-temp';
  const fillId = `${key}-fill`;
  const lineId = `${key}-line`;
  const rows = CPC_SEASONAL_COLORS[options.variable];
  const known = (properties: Record<string, unknown> | null): boolean =>
    rows.some(row => properties?.['cat'] === row.cat && properties['prob'] === row.prob);
  const color: maplibregl.ExpressionSpecification = ['match',
    ['concat', ['get', 'cat'], ',', ['to-string', ['get', 'prob']]],
    `${rows[0].cat},${rows[0].prob}`,
    `rgba(${rows[0].color[0]},${rows[0].color[1]},${rows[0].color[2]},${rows[0].color[3] / 255})`,
    ...rows.slice(1).flatMap(row => [`${row.cat},${row.prob}`,
      `rgba(${row.color[0]},${row.color[1]},${row.color[2]},${row.color[3] / 255})`]),
    'rgba(0,0,0,0)'
  ];
  let map: maplibregl.Map | null = null;
  let live = false;
  let releaseSignal: (() => void) | null = null;
  let snapshot: CpcSeasonalSnapshot | null = null;
  function clear(target: maplibregl.Map): void {
    if (target.getLayer(lineId)) target.removeLayer(lineId);
    if (target.getLayer(fillId)) target.removeLayer(fillId);
    if (target.getSource(key)) target.removeSource(key);
  }
  const reader = createCpcSeasonalReader(state => {
    const target = map;
    if (!target || !live) return;
    if (state.status === 'loading') {
      snapshot = null;
      clear(target);
      registry.setStatus(key, 'loading');
      return;
    }
    const features = state.collection.features.filter(feature => known(feature.properties));
    const unknownFeatures = state.collection.features.length - features.length;
    const status = unknownFeatures ? features.length ? 'degraded' : 'error' : state.status;
    try {
      const data: FeatureCollection = { type: 'FeatureCollection', features };
      if (features.length === 0) clear(target);
      else {
        const source = target.getSource(key) as maplibregl.GeoJSONSource | undefined;
        if (source) source.setData(data);
        else target.addSource(key, { type: 'geojson', data });
        const before = options.beforeId && target.getLayer(options.beforeId) ? options.beforeId : undefined;
        if (!target.getLayer(fillId)) target.addLayer({
          id: fillId, type: 'fill', source: key,
          paint: { 'fill-color': color, 'fill-opacity': options.fillOpacity }
        }, before);
        if (!target.getLayer(lineId)) target.addLayer({
          id: lineId, type: 'line', source: key,
          paint: { 'line-color': 'rgb(110,110,110)', 'line-width': 1 }
        }, before);
      }
      snapshot = { ...state, status, unknownFeatures };
      registry.setStatus(key, status);
    } catch {
      // A removed style can also reject cleanup; keep the failed draw unavailable.
      try { clear(target); } catch { /* No successful frame is claimed. */ }
      snapshot = { ...state, status: 'error', unknownFeatures };
      registry.setStatus(key, 'error');
    }
  });
  function cancelActivation(): void {
    live = false;
    reader.cancel();
    releaseSignal?.();
    releaseSignal = null;
  }
  function deactivate(target: maplibregl.Map): void {
    // A delayed teardown for a previous map must not erase a newer activation.
    if (map !== target) return;
    cancelActivation();
    clear(target);
    map = null;
    snapshot = null;
    // Active membership belongs to the layer controller.
  }
  async function activate(target: maplibregl.Map, activation?: LayerActivation): Promise<void> {
    if (activation?.signal.aborted) return;
    cancelActivation();
    if (map && map !== target) clear(map);
    map = target;
    snapshot = null;
    live = true;
    if (activation) {
      const onAbort = (): void => cancelActivation();
      activation.signal.addEventListener('abort', onAbort, { once: true });
      releaseSignal = () => activation.signal.removeEventListener('abort', onAbort);
    }
    await reader.read(options.variable, options.limits);
  }
  return { activate, deactivate, cancelActivation, fadeLayerIds: [fillId, lineId],
    getSnapshot: () => snapshot };
}
