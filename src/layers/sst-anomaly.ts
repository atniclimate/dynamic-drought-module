/**
 * Sea surface temperature (SST) anomaly layer (0.4.0 B2 slice 2; the
 * temporal axis and Play loop are 0.5.0b).
 *
 * The ENSO ocean surface: NASA Global Imagery Browse Services (GIBS) GHRSST
 * Level 4 MUR daily SST anomaly, rendered as raster tiles so a user can SEE
 * the El Nino / Southern Oscillation (ENSO) warm or cool tongue along the
 * equatorial Pacific and connect it to the drought, heat, and fire reads on
 * land. Registered as an exclusive condition surface (one surface at a time).
 *
 * THE ONE TRUE PLAY LOOP (critical-review Section 5 item 2). This is the
 * only wired surface that is a genuinely continuous daily field (the
 * provider's own Level-4 gap-filled analysis), so it is the only surface
 * that ever declares a Play affordance to the time bar. Authored products
 * (USDM, outlooks) get Step and a date rail, never Play; the affordance
 * difference is the lesson. Honesty mechanics:
 *
 *   - Dates are enumerated LIVE from the WMTS DescribeDomains resource
 *     (compact per-layer XML; ranges like `2026-01-11/2026-07-07/P1D`,
 *     with real gaps preserved; never assume contiguity).
 *   - Each frame is a real dated tile set; steps crossfade opacity between
 *     two mounted frames (frame-stepper doctrine: never fabricate).
 *   - The loop holds a fixed cadence and shows the date per frame; a frame
 *     whose tiles are still arriving buffers behind the canonical loading
 *     pill instead of skipping ahead silently.
 *   - `prefers-reduced-motion` disables Play (with the reason in the
 *     control's title); stepping stays available and instant.
 *   - The selected frame date round-trips through the URL (`sst=`); a
 *     shared link always lands PAUSED on the sender's frame
 *     (maintainer-ratified 2026-07-08). Playback is never serialized.
 *
 * Two pedagogical touches make the surface teach rather than decorate:
 *   - The Nino 3.4 box (170W-120W, 5S-5N), drawn dashed with a label: this is
 *     the region the ENSO index in the sidebar driver line actually measures.
 *   - A one-shot toast when the current view does not include the equatorial
 *     Pacific, telling the user to zoom out.
 *
 * Endpoints: verified 2026-07-06 and re-verified 2026-07-08 (see the
 * URLS.gibsSstAnomalyWmts / gibsSstAnomalyWmtsTime / gibsSstDescribeDomains
 * stamps): keyless WMTS, wildcard CORS, daily cadence with a one-day lag,
 * tile matrix capped at z=7 (maxzoom is load-bearing). The anomaly
 * climatology baseline is NOT stated in the GIBS metadata, so the legend
 * deliberately reads qualitatively and does not assert one.
 */

import type maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import { timeline } from '../state/timeline';
import { fetchWithBudget, sleepUnlessAborted } from '../util/fetch';
import { prefersReducedMotion } from '../util/motion';
import { prefetchAllowed, crossfadeFrames, FRAME_FADE_MS } from '../util/frame-stepper';
import { watchRasterTiles, type RasterTileWatch } from '../util/raster-status';
import { setTimeBar, clearTimeBar } from '../ui/time-bar';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';
import { showToast } from '../ui/overlay';

const LAYER_KEY = 'sst-anomaly';
const SOURCE_ID = 'sst-anomaly';
const LAYER_ID = 'sst-anomaly';
const NINO_SOURCE_ID = 'nino34-box';
const NINO_LINE_ID = 'nino34-box-line';
const NINO_LABEL_ID = 'nino34-box-label';

/** Dated frame ids. */
const frameSourceId = (date: string): string => `sst-frame-${date}`;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract).
 * Dated frame layers are dynamic and clean themselves up in deactivate. */
export const fadeLayerIds = [LAYER_ID, NINO_LINE_ID, NINO_LABEL_ID] as const;

const RASTER_OPACITY = 0.78;
/** How many most-recent dates the rail and loop cover. */
const LOOP_DAYS = 30;
/** Fixed loop cadence (the steady clock); the crossfade rides inside it. */
const STEP_MS = 900;
/** How long a frame may buffer before we advance anyway (pill shows it). */
const BUFFER_TIMEOUT_MS = 6_000;
const DOMAINS_TIMEOUT_MS = 15_000;

let masterController: AbortController | null = null;
let tileWatch: RasterTileWatch | null = null;
let pacificHintShown = false;

/** Available dates (ascending YYYY-MM-DD), enumerated from DescribeDomains. */
let dates: string[] = [];
let dateIndex = 0;
/** Dated frames currently mounted on the map (bounded to two). */
let mountedFrames: string[] = [];
let playing = false;
let buffering = false;
/** Supersede counter (invariant 5). */
let stepEpoch = 0;

type SstStatus = 'loading' | 'ready' | 'error';

function reportStatus(state: SstStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

const NINO34_BOX: GeoJSON.Feature = {
  type: 'Feature',
  properties: { label: 'Nino 3.4 (the ENSO index region)' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-170, -5],
        [-120, -5],
        [-120, 5],
        [-170, 5],
        [-170, -5]
      ]
    ]
  }
};

function viewIncludesNino34(map: maplibregl.Map): boolean {
  const b = map.getBounds();
  return b.getWest() < -120 && b.getEast() > -170 && b.getSouth() < 5 && b.getNorth() > -5;
}

// ---------------------------------------------------------------------------
// Date enumeration (DescribeDomains)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function isoToMs(iso: string): number {
  return Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))
  );
}

function msToIso(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function dateLabel(iso: string): string {
  return new Date(isoToMs(iso)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/**
 * Parse the `<Domain>` text of a DescribeDomains response: comma-separated
 * `start/end/P1D` ranges with real gaps between them. Returns the last
 * `LOOP_DAYS` available dates, ascending. Gaps are preserved: a missing
 * publication day is simply absent from the rail, never interpolated.
 */
export function parseTimeDomain(xml: string, loopDays: number = LOOP_DAYS): string[] {
  const match = /<Domain>([^<]+)<\/Domain>/.exec(xml);
  if (!match) return [];
  const all: string[] = [];
  for (const range of match[1]!.split(',')) {
    const parts = range.trim().split('/');
    if (parts.length !== 3 || parts[2] !== 'P1D') continue;
    const start = isoToMs(parts[0]!);
    const end = isoToMs(parts[1]!);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    for (let ms = start; ms <= end; ms += DAY_MS) {
      all.push(msToIso(ms));
    }
  }
  all.sort();
  return all.slice(-loopDays);
}

// ---------------------------------------------------------------------------
// Frame mounting
// ---------------------------------------------------------------------------

function frameTileTemplate(date: string): string {
  return URLS.gibsSstAnomalyWmtsTime.replace('{TIME}', date);
}

/** The layer id a mounted frame renders under (same as its source id). */
function mountFrame(map: maplibregl.Map, date: string, opacity: number): void {
  const id = frameSourceId(date);
  if (!map.getSource(id)) {
    map.addSource(id, {
      type: 'raster',
      tiles: [frameTileTemplate(date)],
      tileSize: 256,
      // Load-bearing: the GIBS tile matrix set tops out at z=7 (URLS stamp).
      maxzoom: 7,
      attribution: 'NASA EOSDIS GIBS · GHRSST MUR SST anomaly'
    });
  }
  if (!map.getLayer(id)) {
    // Dated frames slot under the Nino box line so the pedagogy stays on top.
    const beforeId = map.getLayer(NINO_LINE_ID) ? NINO_LINE_ID : undefined;
    map.addLayer(
      {
        id,
        type: 'raster',
        source: id,
        paint: {
          'raster-opacity': opacity
        }
      },
      beforeId
    );
    // Frame steps animate opacity themselves; kill the default paint
    // transition so a zeroed frame starts genuinely invisible. (Set via
    // setPaintProperty: the addLayer paint typing rejects *-transition.)
    map.setPaintProperty(id, 'raster-opacity-transition', { duration: 0, delay: 0 });
  }
  if (!mountedFrames.includes(date)) mountedFrames.push(date);
}

function unmountFrame(map: maplibregl.Map, date: string): void {
  const id = frameSourceId(date);
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  mountedFrames = mountedFrames.filter((d) => d !== date);
}

/** Wait until a source's visible tiles are loaded, bounded by a timeout. */
async function waitForSourceTiles(
  map: maplibregl.Map,
  sourceId: string,
  signal: AbortSignal
): Promise<void> {
  if (map.isSourceLoaded(sourceId)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      map.off('sourcedata', onData);
      window.clearTimeout(timer);
      resolve();
    };
    const onData = (): void => {
      if (signal.aborted || map.isSourceLoaded(sourceId)) finish();
    };
    // The timeout keeps a dead tile edge from hanging the loop; the tile
    // watcher's status pill carries the honest loading/error state.
    const timer = window.setTimeout(finish, BUFFER_TIMEOUT_MS);
    map.on('sourcedata', onData);
    onData();
  });
}

// ---------------------------------------------------------------------------
// Stepping and the loop
// ---------------------------------------------------------------------------

/**
 * Show the frame at `index`: mount it, buffer its tiles (pill: loading),
 * crossfade from whatever dated frame is visible (or from the boot-time
 * `default` layer on the first step), then unmount all but the last two
 * frames so memory stays bounded while the browser HTTP cache keeps the
 * loop's tiles warm.
 */
async function showFrame(map: maplibregl.Map, index: number): Promise<void> {
  if (dates.length === 0) return;
  const signal = masterController?.signal ?? null;
  if (!signal) return;
  const myEpoch = ++stepEpoch;

  const clamped = Math.min(dates.length - 1, Math.max(0, index));
  const date = dates[clamped]!;
  const previous = mountedFrames[mountedFrames.length - 1] ?? null;
  if (previous === date && dateIndex === clamped) return;

  mountFrame(map, date, 0);

  buffering = true;
  reportStatus('loading');
  installTimeBar(map);
  await waitForSourceTiles(map, frameSourceId(date), signal);
  if (signal.aborted || myEpoch !== stepEpoch) return;
  buffering = false;

  dateIndex = clamped;
  timeline.setSstDate(clamped === dates.length - 1 ? null : date);
  reportStatus('ready');

  const incoming = [
    { layerId: frameSourceId(date), prop: 'raster-opacity', target: RASTER_OPACITY }
  ];
  const outgoing = [];
  if (previous && previous !== date) {
    outgoing.push({
      layerId: frameSourceId(previous),
      prop: 'raster-opacity',
      target: RASTER_OPACITY
    });
  }
  if (map.getLayer(LAYER_ID)) {
    // First dated step: fade the boot-time `default` layer out for good.
    outgoing.push({ layerId: LAYER_ID, prop: 'raster-opacity', target: RASTER_OPACITY });
  }

  installTimeBar(map);
  await crossfadeFrames(map, outgoing, incoming);
  if (signal.aborted || myEpoch !== stepEpoch) return;

  if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
  while (mountedFrames.length > 2) {
    unmountFrame(map, mountedFrames[0]!);
  }
}

/** The Play loop: fixed cadence, visible clock, wraps at the window end. */
async function playLoop(map: maplibregl.Map): Promise<void> {
  const signal = masterController?.signal ?? null;
  if (!signal) return;
  while (playing && !signal.aborted) {
    const next = dateIndex >= dates.length - 1 ? 0 : dateIndex + 1;
    await showFrame(map, next);
    if (!playing || signal.aborted) break;
    // The crossfade rides inside the cadence; sleep the remainder so each
    // frame holds for a steady, predictable beat (the radar recipe).
    try {
      await sleepUnlessAborted(Math.max(0, STEP_MS - FRAME_FADE_MS), signal);
    } catch {
      break;
    }
  }
}

function togglePlay(map: maplibregl.Map): void {
  if (playing) {
    playing = false;
    installTimeBar(map);
    return;
  }
  if (prefersReducedMotion()) return; // the control is disabled; belt and braces
  playing = true;
  installTimeBar(map);
  void playLoop(map).finally(() => {
    playing = false;
  });
}

// ---------------------------------------------------------------------------
// Time bar
// ---------------------------------------------------------------------------

function installTimeBar(map: maplibregl.Map): void {
  if (dates.length === 0) return;
  const date = dates[dateIndex] ?? dates[dates.length - 1]!;
  const reduced = prefersReducedMotion();

  setTimeBar(LAYER_KEY, {
    ariaLabel: 'Sea surface temperature anomaly timeline',
    stamp: {
      headline: `Observed ${dateLabel(date)}`,
      detail: buffering
        ? 'GHRSST MUR daily SST anomaly · buffering tiles'
        : 'GHRSST MUR daily SST anomaly · a measured daily field; Play replays real days',
      register: 'observed'
    },
    rail: {
      count: dates.length,
      index: dateIndex,
      valueText: (i) => dateLabel(dates[i] ?? date),
      onStep: (i) => {
        playing = false;
        void showFrame(map, i);
      }
    },
    play: {
      playing,
      disabled: buffering || reduced,
      onToggle: () => togglePlay(map)
    }
  });
}

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------

/**
 * Add the SST anomaly raster (the `default` latest frame for instant
 * paint), the Nino 3.4 box, and the legend, then enumerate the TIME axis
 * and stand up the loop controls. Date enumeration failing is not an
 * error for the surface itself: the current field still renders; only the
 * temporal controls stay down (an honest absence, logged).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  reportStatus('loading');

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [URLS.gibsSstAnomalyWmts],
        tileSize: 256,
        // Load-bearing: the GIBS tile matrix set tops out at z=7 (see the
        // URLS stamp). MapLibre overzooms from here.
        maxzoom: 7,
        attribution: 'NASA EOSDIS GIBS · GHRSST MUR SST anomaly'
      });
    }

    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          'raster-opacity': RASTER_OPACITY
        }
      });
    } else {
      map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
    }

    if (!map.getSource(NINO_SOURCE_ID)) {
      map.addSource(NINO_SOURCE_ID, {
        type: 'geojson',
        data: NINO34_BOX
      });
    }

    if (!map.getLayer(NINO_LINE_ID)) {
      map.addLayer({
        id: NINO_LINE_ID,
        type: 'line',
        source: NINO_SOURCE_ID,
        paint: {
          'line-color': '#e2e8f0',
          'line-width': 1.4,
          'line-dasharray': [2, 2],
          'line-opacity': 0.9
        }
      });
    }

    if (!map.getLayer(NINO_LABEL_ID)) {
      map.addLayer({
        id: NINO_LABEL_ID,
        type: 'symbol',
        source: NINO_SOURCE_ID,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 0.4],
          'text-justify': 'center'
        },
        paint: {
          'text-color': '#e2e8f0',
          'text-halo-color': '#0b1220',
          'text-halo-width': 1.2
        }
      });
    }

    tileWatch?.detach();
    tileWatch = watchRasterTiles(map, SOURCE_ID, reportStatus);

    showLegend(LAYER_KEY, {
      order: LEGEND_ORDER.surface,
      render: (body) =>
        renderSwatchLegend(
          body,
          'Ocean temperature anomaly',
          [
            { color: '#b2182b', label: 'Warmer than usual' },
            { color: '#f7f7f7', label: 'Near usual' },
            { color: '#2166ac', label: 'Cooler than usual' }
          ],
          'NASA GHRSST MUR daily anomaly · the dashed box is Nino 3.4, the region the ENSO index measures'
        )
    });

    if (!pacificHintShown && !viewIncludesNino34(map)) {
      pacificHintShown = true;
      showToast('Ocean temperature anomaly is global; zoom out toward the equatorial Pacific to see the ENSO signal.');
    }

    reportStatus('ready');
  } catch (err) {
    console.warn('[sst-anomaly] activation failed.', err);
    reportStatus('error');
    return;
  }

  // ---- The temporal axis: enumerate real dates, then offer the loop. ----
  try {
    const response = await fetchWithBudget(
      URLS.gibsSstDescribeDomains,
      null,
      signal,
      DOMAINS_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const xml = await response.text();
    if (signal.aborted) return;
    dates = parseTimeDomain(xml);
  } catch (err) {
    if (signal.aborted) return;
    // The surface stays useful without a time axis; say so and stop here.
    console.warn('[sst-anomaly] TIME enumeration failed; Play/step disabled this session.', err);
    dates = [];
    return;
  }

  if (dates.length === 0) return;
  dateIndex = dates.length - 1;

  // URL restore: land PAUSED on the shared frame (never auto-play).
  const urlDate = timeline.sstDate;
  if (urlDate !== null) {
    const idx = dates.indexOf(urlDate);
    if (idx >= 0 && idx !== dates.length - 1) {
      await showFrame(map, idx);
      return; // showFrame installed the bar
    }
    // A date outside the window (or a gap day) falls back to the latest
    // frame; the URL heals on the next timeline sync.
    timeline.setSstDate(null);
  }
  installTimeBar(map);

  // Politely pre-warm the previous frame so the first step back is instant.
  if (prefetchAllowed() && dates.length >= 2) {
    mountFrame(map, dates[dates.length - 2]!, 0);
  }
}

/**
 * Stop the loop, abort in-flight work, and remove the SST raster, every
 * dated frame, the Nino 3.4 box, and the legend. Resets the URL's `sst=`
 * so a paused historical frame never outlives the surface.
 */
export function deactivate(map: maplibregl.Map): void {
  playing = false;
  buffering = false;
  stepEpoch++;
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  tileWatch?.detach();
  tileWatch = null;
  for (const date of [...mountedFrames]) {
    unmountFrame(map, date);
  }
  for (const id of [NINO_LABEL_ID, NINO_LINE_ID, LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [NINO_SOURCE_ID, SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
  dates = [];
  dateIndex = 0;
  clearTimeBar(LAYER_KEY);
  hideLegend(LAYER_KEY);
  timeline.setSstDate(null);
}

/**
 * No-op popup binder: the anomaly is a server-rendered raster with no
 * per-pixel attributes on the client. Same uniform-shape rationale as
 * usfs-whp.ts.
 */
export function bindPopups(_map: maplibregl.Map): void {
  // Intentionally empty; see JSDoc above.
}
