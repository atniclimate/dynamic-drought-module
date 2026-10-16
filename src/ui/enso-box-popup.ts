/**
 * The Nino 3.4 box popup (ENSO B1): a compact read of the bundled ENSO index
 * snapshot (public/data/enso-indices.json) when the dashed box is clicked.
 *
 * Reads the snapshot through the same shared, page-lifetime transport the
 * briefing's loader uses (ENSO_INDICES_SHARED_KEY), so the box, the minimap
 * label and the briefing share one fetch. It does not import
 * src/impact/enso.ts: that module belongs to the briefing's first-use cost,
 * so the few fields read here are typed and checked locally.
 */

import type { ChartDetail, IssuedModel, PopupClock, ValueRow } from './popup-frame';
import { URLS } from '../config/urls';
import { standingBriefingDoor } from '../state/place-selection';
import { ENSO_INDICES_SHARED_KEY, fetchSharedJsonWithBudget } from '../util/fetch';

const TITLE = 'Nino 3.4 (the ENSO index region)';
const ISSUER = 'NOAA Climate Prediction Center';
const CHART_KEY = 'enso-box-roni';
const DEG = '°C';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
// The index names as the briefing labels them (src/impact/enso.ts).
const RONI_LABEL = 'Relative Oceanic Nino Index (RONI)';
const ONI_LABEL = 'Oceanic Nino Index (ONI)';
const SOI_LABEL = 'Southern Oscillation Index (SOI)';
const WEEKLY_LABEL = 'Weekly Nino 3.4 sea surface temperature';

interface SeasonPoint {
  readonly seas: string;
  readonly year: number;
  readonly anom: number;
  readonly preliminary?: boolean;
}

interface SeasonalIndex {
  readonly source: string;
  readonly sourceUrl: string;
  readonly published?: string;
  readonly method?: { readonly basePeriod?: string };
  readonly latest: SeasonPoint;
  readonly values: readonly SeasonPoint[];
}

export interface EnsoBoxSnapshot {
  readonly retrieved: string;
  readonly roni: SeasonalIndex;
  readonly oni: SeasonalIndex;
  readonly nino34Weekly?: {
    readonly published?: string;
    readonly basePeriod?: string;
    readonly dateMeaning?: string;
    readonly latest: { readonly year: number; readonly month: number; readonly day: number; readonly total: number; readonly anom: number };
  };
  readonly soi?: {
    readonly published?: string;
    readonly latest: { readonly year: number; readonly month: number; readonly value: number | null };
  };
}

/** What the popup can say: the snapshot, or one of the six layer-state words. */
export type EnsoBoxRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly snapshot: EnsoBoxSnapshot };

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12;

function isSeason(v: unknown): v is SeasonPoint {
  return isObj(v) && typeof v.seas === 'string' && isNum(v.year) && isNum(v.anom);
}

function isSeasonal(v: unknown): v is SeasonalIndex {
  return (
    isObj(v) &&
    typeof v.source === 'string' &&
    typeof v.sourceUrl === 'string' &&
    isSeason(v.latest) &&
    Array.isArray(v.values) &&
    v.values.every(isSeason)
  );
}

/**
 * Check the parts of the snapshot the popup reads. RONI and ONI are required
 * (as in the briefing's loader); a malformed weekly or SOI block is dropped,
 * so the seasonal rows still show. Null when the required parts fail.
 */
export function readEnsoBoxSnapshot(json: unknown): EnsoBoxSnapshot | null {
  if (!isObj(json) || !isDay(json.retrieved) || !isSeasonal(json.roni) || !isSeasonal(json.oni)) return null;
  // The source link is the frame's one required href, and the frame refuses a non-https one.
  if (!json.roni.sourceUrl.startsWith('https://')) return null;
  const w = isObj(json.nino34Weekly) ? json.nino34Weekly : null;
  const wl = w && isObj(w.latest) ? w.latest : null;
  const weeklyOk = wl !== null && isNum(wl.year) && isMonth(wl.month) && isNum(wl.day) && isNum(wl.total) && isNum(wl.anom);
  const s = isObj(json.soi) ? json.soi : null;
  const sl = s && isObj(s.latest) ? s.latest : null;
  const soiOk = sl !== null && isNum(sl.year) && isMonth(sl.month) && (sl.value === null || isNum(sl.value));
  return {
    retrieved: json.retrieved,
    roni: json.roni,
    oni: json.oni,
    ...(weeklyOk ? { nino34Weekly: w as unknown as NonNullable<EnsoBoxSnapshot['nino34Weekly']> } : {}),
    ...(soiOk ? { soi: s as unknown as NonNullable<EnsoBoxSnapshot['soi']> } : {})
  };
}

/** Read the bundled snapshot (shared transport); rejects on a failed or aborted fetch. */
export async function loadEnsoBoxSnapshot(signal: AbortSignal): Promise<EnsoBoxRead> {
  const json = await fetchSharedJsonWithBudget(
    ENSO_INDICES_SHARED_KEY,
    URLS.ensoIndicesLocal,
    { headers: { Accept: 'application/json' } },
    signal,
    6000
  );
  const snapshot = readEnsoBoxSnapshot(json);
  return snapshot === null ? { kind: 'unavailable' } : { kind: 'ready', snapshot };
}

let current: EnsoBoxRead = { kind: 'loading' };
let inFlight: AbortController | null = null;

/** The popup's read as it stands (the coordinator's respond is synchronous). */
export function currentEnsoBoxRead(): EnsoBoxRead {
  return current;
}

/**
 * Start reading the snapshot unless it is already read or being read. A
 * ready read is kept for the page, as the shared transport keeps it; a failed
 * one reads unavailable until the next start. A cancelled or superseded read
 * writes nothing.
 */
export function startEnsoBoxRead(): void {
  if (current.kind === 'ready' || inFlight !== null) return;
  const controller = new AbortController();
  inFlight = controller;
  const settle = (read: EnsoBoxRead): void => {
    if (inFlight !== controller) return;
    inFlight = null;
    current = read;
  };
  void loadEnsoBoxSnapshot(controller.signal).then(settle, () => settle({ kind: 'unavailable' }));
}

/** Abort an in-flight read (the layer's deactivate); a ready read stays. */
export function cancelEnsoBoxRead(): void {
  inFlight?.abort();
  inFlight = null;
  if (current.kind !== 'ready') current = { kind: 'loading' };
}

const signed = (v: number, digits: number): string => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;

function published(date: string | undefined): PopupClock | undefined {
  return isDay(date) ? { kind: 'point', meaning: 'published', label: 'Published', at: { precision: 'date', date } } : undefined;
}

function seasonalRow(label: string, index: SeasonalIndex): ValueRow {
  const p = index.latest;
  const clock = published(index.published);
  return {
    label,
    text: `${signed(p.anom, 2)} ${DEG}, ${p.seas} ${p.year}${p.preliminary === true ? ' (preliminary)' : ''}`,
    ...(clock ? { clock } : {})
  };
}

/** The popup's model for the current read (the chart SVG is mounted later by `mountEnsoBoxChart`). */
export function buildEnsoBoxPopupModel(read: EnsoBoxRead): IssuedModel {
  const issuer = { role: 'issued-by', name: ISSUER, productKey: 'ensoIndex' } as const;
  // The box is no place: its door opens the briefing for the selected place, else the region's, else Technical information.
  const actions = standingBriefingDoor();
  if (read.kind !== 'ready') {
    return {
      kind: 'event',
      title: TITLE,
      issuer,
      value: [{ text: 'ENSO indices', state: read.kind }],
      clocks: [{ kind: 'not-stated', label: 'Retrieved', reason: read.kind }],
      source: { none: read.kind },
      actions
    };
  }
  const snap = read.snapshot;
  const rows: ValueRow[] = [seasonalRow(RONI_LABEL, snap.roni), seasonalRow(ONI_LABEL, snap.oni)];
  const qualifications: string[] = [];
  if (snap.roni.method?.basePeriod) qualifications.push(`RONI base period: ${snap.roni.method.basePeriod}`);

  const weekly = snap.nino34Weekly;
  if (weekly) {
    const w = weekly.latest;
    const clock = published(weekly.published);
    rows.push({
      label: WEEKLY_LABEL,
      text: `${w.total.toFixed(1)} ${DEG}, anomaly ${signed(w.anom, 1)} ${DEG}, ${w.day} ${MONTHS[w.month - 1]} ${w.year}`,
      ...(clock ? { clock } : {})
    });
    if (weekly.basePeriod) qualifications.push(`Weekly Nino 3.4 base period: ${weekly.basePeriod}`);
    if (weekly.dateMeaning) qualifications.push(`Weekly Nino 3.4 date: ${weekly.dateMeaning}`);
  }

  const soi = snap.soi;
  if (soi && soi.latest.value !== null) {
    const clock = published(soi.published);
    rows.push({
      label: SOI_LABEL,
      text: `${signed(soi.latest.value, 1)}, ${MONTHS[soi.latest.month - 1]} ${soi.latest.year}`,
      ...(clock ? { clock } : {})
    });
  }

  const data = snap.roni.values.map((p) => p.anom);
  const latest = snap.roni.latest;
  const chart: ChartDetail = {
    kind: 'chart',
    label: RONI_LABEL,
    chartKey: CHART_KEY,
    summary: `${data.length} seasons, min ${signed(Math.min(...data), 2)} ${DEG}, max ${signed(Math.max(...data), 2)} ${DEG}, latest ${signed(latest.anom, 2)} ${DEG} (${latest.seas} ${latest.year})`,
    data,
    options: { title: RONI_LABEL, unit: DEG, guides: [0.5, -0.5] },
    unit: DEG,
    attribution: `NOAA CPC RONI, retrieved ${snap.retrieved}`
  };

  return {
    kind: 'event',
    title: TITLE,
    issuer,
    value: [rows[0]!, ...rows.slice(1)],
    clocks: [{ kind: 'point', meaning: 'retrieved', label: 'Retrieved', at: { precision: 'date', date: snap.retrieved } }],
    details: data.length >= 2 ? [chart] : [],
    qualifications,
    source: { link: { label: snap.roni.source, href: snap.roni.sourceUrl } },
    actions
  };
}

/**
 * Draw the RONI sparkline into the painted popup's chart mount. The chart
 * module is loaded on demand so it never rides the SST layer's chunk.
 */
export async function mountEnsoBoxChart(root: ParentNode, model: IssuedModel): Promise<void> {
  const chart = model.details?.find((d): d is ChartDetail => d.kind === 'chart' && d.chartKey === CHART_KEY);
  if (!chart) return;
  const { sparklineSvg } = await import('./charts');
  const figure = root.querySelector(`[data-popup-chart="${CHART_KEY}"]`);
  if (figure && !figure.querySelector('svg')) figure.insertAdjacentHTML('beforeend', sparklineSvg(chart.data, chart.options));
}
