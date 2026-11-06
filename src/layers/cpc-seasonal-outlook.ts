import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { getLayerDef, type LayerActivation, type LayerModule } from '../config/layers';
import { CPC_EXTENDED_COLORS, CPC_SEASONAL_COLORS } from '../config/palette';
import { registerClickTarget } from '../map/interaction-coordinator';
import { registry } from '../state/registry';
import { hideLegend, LEGEND_ORDER, showLegend } from '../ui/legend-registry';
import type { ClockValue, IssuedModel, PopupClock } from '../ui/popup-frame';
import { escapeHtml } from '../util/escape';
import { createCpcSeasonalReader, type CpcOutlookWindow, type CpcSeasonalReadLimits,
  type CpcSeasonalReadState, type CpcSeasonalVariable } from './cpc-seasonal-read';

/**
 * The admitted read and display for every CPC outlook layer: the seasonal
 * pair (ENSO Season ahead, 2026-11-05) and the 6-10 and 8-14 day four (ENSO
 * Weeks ahead, 2026-11-06). maxAllowableOffset 0.05 is the smallest of 0.01,
 * 0.02, 0.05 and 0.1 whose live seasonal bodies measured under 100 kB gzip
 * (96,953 and 95,212 bytes; 529,645 and 527,406 decoded; 18 features each);
 * the four day-range bodies measured 95,887 to 97,911 bytes gzip at the same
 * offset. The decoded cap refuses a body near twice that as unavailable
 * rather than drawing it; 0.48 is the CPC Drought Outlook's fill
 * (src/layers/drought.ts), and the legend swatches carry the same alpha.
 */
export const CPC_SEASONAL_PRODUCTION = {
  limits: { timeoutMs: 10_000, maxDecodedBytes: 1_000_000, maxFeatures: 200, maxAllowableOffset: 0.05 },
  fillOpacity: 0.48
} as const;

/** The issuer renderers' one outline colour, drawn round every class including Equal Chances. */
const OUTLINE = 'rgb(110,110,110)';

/** One renderer class as both palettes record it; a row with no width has the renderer's 1. */
interface OutlookClass {
  readonly cat: string;
  readonly prob: number;
  readonly label: string;
  readonly color: readonly [number, number, number, number];
  readonly outline?: number;
}

/** The date fields are UTC midnights; a local read would show the day before west of Greenwich. */
const formatDay = (time: number): string => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
}).format(new Date(time));

// vocab-allow: "Forecast Date" is the issuer's own alias for fcst_date, verbatim
const FORECAST_DATE = 'Forecast Date';
/** Each product's clock fields and the issuer's own field aliases, in key order. */
const CLOCK_FIELDS = {
  seasonal: [['valid_seas', 'Valid Season'], ['fcst_date', FORECAST_DATE]],
  extended: [['start_date', 'Start Date'], ['end_date', 'End Date'], ['fcst_date', FORECAST_DATE]]
} as const;

/** One line per distinct issuer clock among the drawn polygons, never two clocks joined. */
function clockLines(features: readonly Feature[], fields: readonly (readonly [string, string])[]): string[] {
  const lines = new Set<string>();
  for (const feature of features) {
    const parts = fields.flatMap(([field, alias]) => {
      const value = feature.properties?.[field];
      if (typeof value === 'string' && value.trim()) return [`${alias} ${value.trim()}`];
      return typeof value === 'number' && Number.isFinite(value) ? [`${alias} ${formatDay(value)}`] : [];
    });
    // DRAFT wording (DR-177): the issuer's field aliases, each with its value, joined by " · "
    if (parts.length) lines.add(parts.join(' · '));
  }
  return [...lines];
}

/** The frame's explanation for issuer time text DDM does not parse (as src/layers/drought.ts states it). */
const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';
/** The UTC midnights the legend reads, as the frame's date (years 0 to 9999 only). */
const LAST_DATE_MS = Date.UTC(9999, 11, 31);

/** One issuer clock field at its own precision: a UTC-midnight date, other text as supplied, else absent. */
function clockValue(value: unknown): ClockValue | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= LAST_DATE_MS
      ? { precision: 'date', date: new Date(value).toISOString().slice(0, 10) }
      : null;
  }
  return typeof value === 'string' && value.trim()
    ? { precision: 'supplied', text: value.trim(), explanation: SUPPLIED_TIME_EXPLANATION }
    : null;
}

/** The issuer pages these layers already cite (src/impact/sources.ts, src/impact/cpc-extended.ts). */
const SOURCE_HREF = {
  seasonal: 'https://www.cpc.ncep.noaa.gov/products/predictions/long_range/',
  extended: 'https://www.cpc.ncep.noaa.gov/'
} as const;

/** The key slots after the active surface's, one per outlook layer, so two never tie. */
const KEY_ORDER = ['cpc-seasonal-precip', 'cpc-seasonal-temp', 'cpc-610-precip', 'cpc-610-temp', 'cpc-814-precip', 'cpc-814-temp'];

export interface CpcSeasonalAdapterOptions {
  readonly variable: CpcSeasonalVariable;
  /** The outlook product; the seasonal Lead 1 when omitted. */
  readonly window?: CpcOutlookWindow;
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
  LayerModule & Required<Pick<LayerModule, 'cancelActivation' | 'fadeLayerIds' | 'bindPopups'>> &
  { getSnapshot(): CpcSeasonalSnapshot | null } {
  if (!Number.isFinite(options.fillOpacity) || options.fillOpacity < 0 || options.fillOpacity > 1) {
    throw new RangeError('Invalid CPC fill opacity.');
  }
  const outlook = options.window ?? 'seasonal';
  const short = options.variable === 'precipitation' ? 'precip' : 'temp';
  const key = outlook === 'seasonal' ? `cpc-seasonal-${short}` : `cpc-${outlook.replace('-', '')}-${short}`;
  const fillId = `${key}-fill`;
  const lineId = `${key}-line`;
  const rows: readonly OutlookClass[] = (outlook === 'seasonal' ? CPC_SEASONAL_COLORS : CPC_EXTENDED_COLORS)[options.variable];
  const clockFields = CLOCK_FIELDS[outlook === 'seasonal' ? 'seasonal' : 'extended'];
  const rowFor = (properties: Record<string, unknown> | null): OutlookClass | undefined =>
    rows.find(row => properties?.['cat'] === row.cat && properties['prob'] === row.prob);
  const known = (properties: Record<string, unknown> | null): boolean => rowFor(properties) !== undefined;
  const title = getLayerDef(key)?.name ?? key;
  /**
   * The drawn polygon's identify popup (the look at 6748f25, D6): its class as
   * the key words it, then each issuer clock field under the key's own alias.
   * Null for a class outside the renderer (never drawn, so never clicked).
   */
  function popupModel(properties: Record<string, unknown> | null): IssuedModel | null {
    const row = rowFor(properties);
    if (!row) return null;
    const [r, g, b, a] = row.color;
    const hex = `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
    const clocks = clockFields.flatMap(([field, alias]): PopupClock[] => {
      const at = clockValue(properties?.[field]);
      return at ? [{ kind: 'point', meaning: field === 'fcst_date' ? 'issued' : 'valid', label: alias, at }] : [];
    });
    const [first, ...later] = clocks;
    return {
      kind: 'surface',
      title,
      // The CPC products are not protected geography; the cast narrows LayerDef's ProductKey for the frame.
      issuer: { role: 'issued-by', name: 'NOAA Climate Prediction Center',
        productKey: (getLayerDef(key)?.product ?? key) as IssuedModel['issuer']['productKey'] },
      // Equal Chances is drawn clear, so it carries no swatch.
      value: [a === 0 ? { text: row.label }
        : { text: row.label, swatch: { table: outlook === 'seasonal' ? 'CPC_SEASONAL_COLORS' : 'CPC_EXTENDED_COLORS', classKey: `${row.cat},${row.prob}`, color: hex } }],
      // DRAFT wording: "not stated" as the alert popup words an absent time.
      clocks: first ? [first, ...later] : [{ kind: 'not-stated', label: FORECAST_DATE, reason: 'not stated' }],
      source: { link: { label: title, href: SOURCE_HREF[outlook === 'seasonal' ? 'seasonal' : 'extended'] } }
    };
  }
  /** One click target per outlook fill; outlooks rank as condition surfaces, under every boundary. */
  function bindPopups(target: maplibregl.Map): void {
    registerClickTarget({
      kind: 'condition-surface',
      layerIds: [fillId],
      label: (feature) => {
        const row = rowFor(feature.properties);
        return row ? `${title}: ${row.label}` : null;
      },
      respond: (feature) => {
        const model = popupModel(feature.properties);
        return model ? { model } : null;
      }
    });
    target.on('mouseenter', fillId, () => {
      target.getCanvas().style.cursor = 'pointer';
    });
    target.on('mouseleave', fillId, () => {
      target.getCanvas().style.cursor = '';
    });
  }
  const pair: maplibregl.ExpressionSpecification = ['concat', ['get', 'cat'], ',', ['to-string', ['get', 'prob']]];
  const [first, ...rest] = rows;
  if (!first) throw new RangeError('A CPC outlook needs its renderer classes.');
  const rgba = (row: OutlookClass): string => `rgba(${row.color[0]},${row.color[1]},${row.color[2]},${row.color[3] / 255})`;
  const color: maplibregl.ExpressionSpecification = ['match', pair, `${first.cat},${first.prob}`, rgba(first),
    ...rest.flatMap(row => [`${row.cat},${row.prob}`, rgba(row)]), 'rgba(0,0,0,0)'];
  // The renderer's own outline width per class (1, or 0.4 on some day-range classes).
  const lineWidth: number | maplibregl.ExpressionSpecification = rows.every(row => (row.outline ?? 1) === 1) ? 1
    : ['match', pair, `${first.cat},${first.prob}`, first.outline ?? 1,
      ...rest.flatMap(row => [`${row.cat},${row.prob}`, row.outline ?? 1]), 1];
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
  /** This layer's own key: its renderer's classes and labels as drawn, plus the drawn polygons' clock. */
  function showKey(features: readonly Feature[]): void {
    const items = rows.map(row => {
      const [r, g, b, a] = row.color;
      return `<li data-cpc-class="${escapeHtml(`${row.cat},${row.prob}`)}"><span class="swatch" style="background:rgba(${r},${g},${b},${(a / 255) * options.fillOpacity});border-color:${OUTLINE}"></span>${escapeHtml(row.label)}</li>`;
    }).join('');
    const clocks = clockLines(features, clockFields).map(line => `<p class="legend-note" data-cpc-clock>${escapeHtml(line)}</p>`).join('');
    showLegend(key, {
      order: LEGEND_ORDER.surface + 1 + KEY_ORDER.indexOf(key) / 10,
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
          paint: { 'line-color': OUTLINE, 'line-width': lineWidth }
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
    await reader.read(options.variable, options.limits, outlook);
  }
  return { activate, deactivate, cancelActivation, bindPopups, fadeLayerIds: [fillId, lineId],
    getSnapshot: () => snapshot };
}
