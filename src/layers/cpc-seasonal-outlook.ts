import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { getLayerDef, type LayerActivation, type LayerModule } from '../config/layers';
import { CPC_SEASONAL_COLORS } from '../config/palette';
import { registry } from '../state/registry';
import { hideLegend, LEGEND_ORDER, showLegend } from '../ui/legend-registry';
import { escapeHtml } from '../util/escape';
import { createCpcSeasonalReader, type CpcSeasonalReadLimits, type CpcSeasonalReadState,
  type CpcSeasonalVariable } from './cpc-seasonal-read';

/**
 * The admitted read and display for both outlook layers (ENSO Season ahead,
 * 2026-11-05). maxAllowableOffset 0.05 is the smallest of 0.01, 0.02, 0.05 and
 * 0.1 whose live national body measured under 100 kB gzip (96,953 and 95,212
 * bytes; 529,645 and 527,406 decoded; 18 features each). The decoded cap
 * refuses a body near twice that as unavailable rather than drawing it;
 * 0.48 is the CPC Drought Outlook's fill (src/layers/drought.ts), and the
 * legend swatches carry the same alpha.
 */
export const CPC_SEASONAL_PRODUCTION = {
  limits: { timeoutMs: 10_000, maxDecodedBytes: 1_000_000, maxFeatures: 200, maxAllowableOffset: 0.05 },
  fillOpacity: 0.48
} as const;

/** The issuer renderer's one outline, drawn round every class including Equal Chances. */
const OUTLINE = 'rgb(110,110,110)';

/** fcst_date is a UTC midnight; a local read would show the day before west of Greenwich. */
const formatDay = (time: number): string => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
}).format(new Date(time));

/** One line per distinct issuer clock among the drawn polygons, never two clocks joined. */
function clockLines(features: readonly Feature[]): string[] {
  const lines = new Set<string>();
  for (const feature of features) {
    const season = feature.properties?.['valid_seas'];
    const issued = feature.properties?.['fcst_date'];
    const parts: string[] = [];
    // DRAFT wording (DR-177): the issuer's two field aliases, each with its value, joined by " · "
    if (typeof season === 'string' && season.trim()) parts.push(`Valid Season ${season.trim()}`);
    // vocab-allow: "Forecast Date" is the issuer's own alias for fcst_date, verbatim
    if (typeof issued === 'number' && Number.isFinite(issued)) parts.push(`Forecast Date ${formatDay(issued)}`);
    if (parts.length) lines.add(parts.join(' · '));
  }
  return [...lines];
}

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
  LayerModule & Required<Pick<LayerModule, 'cancelActivation' | 'fadeLayerIds'>> &
  { getSnapshot(): CpcSeasonalSnapshot | null } {
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
    hideLegend(key);
    if (target.getLayer(lineId)) target.removeLayer(lineId);
    if (target.getLayer(fillId)) target.removeLayer(fillId);
    if (target.getSource(key)) target.removeSource(key);
  }
  /** This layer's own key: the renderer's 17 classes and labels as drawn, plus the drawn polygons' clock. */
  function showKey(features: readonly Feature[]): void {
    const title = getLayerDef(key)?.name ?? key;
    const items = rows.map(row => {
      const [r, g, b, a] = row.color;
      return `<li data-cpc-class="${escapeHtml(`${row.cat},${row.prob}`)}"><span class="swatch" style="background:rgba(${r},${g},${b},${(a / 255) * options.fillOpacity});border-color:${OUTLINE}"></span>${escapeHtml(row.label)}</li>`;
    }).join('');
    const clocks = clockLines(features).map(line => `<p class="legend-note" data-cpc-clock>${escapeHtml(line)}</p>`).join('');
    showLegend(key, {
      order: LEGEND_ORDER.surface + (options.variable === 'precipitation' ? 1 : 2),
      render: (body) => {
        body.innerHTML = `<h3 class="legend-section-title">${escapeHtml(title)}</h3>${clocks}<ul class="legend">${items}</ul>`;
      }
    });
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
          paint: { 'line-color': OUTLINE, 'line-width': 1 }
        }, before);
        showKey(features);
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
