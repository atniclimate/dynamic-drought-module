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

import type * as maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import {
  SST_ANOMALY_LEGEND_TITLE,
  SST_ANOMALY_SCALE
} from '../config/palette';
import { registry } from '../state/registry';
import { timeline } from '../state/timeline';
import { fetchBufferedWithBudget, sleepUnlessAborted } from '../util/fetch';
import { prefersReducedMotion } from '../util/motion';
import { prefetchAllowed, crossfadeFrames, FRAME_FADE_MS } from '../util/frame-stepper';
import {
  RASTER_PROOF_DEADLINE_MS,
  watchRasterTiles,
  type RasterTileOutcome,
  type RasterTileWatch
} from '../util/raster-status';
import { TILE_PROOF_WATCH, waitForRasterTileProof } from '../util/raster-proof';
import { setTimeBar, clearTimeBar } from '../ui/time-bar';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';
import { showToast } from '../ui/overlay';
import { activateEnsoFlow, cancelEnsoFlowLoad, deactivateEnsoFlow } from './enso-flow';

const LAYER_KEY = 'sst-anomaly';
/**
 * On-map key snapshot event (the map-key module's established snapshot
 * pattern, e.g. ddm:nadm-snapshot): announces the displayed frame's
 * observed date so the compact key can state it without reaching into
 * this module. Dispatched with a null date while only the provider's
 * `default` (latest) frame is up, with the real date once the TIME axis
 * is enumerated, and as inactive on deactivate.
 */
const SST_SNAPSHOT_EVENT = 'ddm:sst-snapshot';
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
/** How long a frame may buffer before the loop advances anyway. The pill
 * never follows it: the frame's own tile proof decides live (DDM-P14-T04). */
const BUFFER_TIMEOUT_MS = 6_000;
/**
 * The DescribeDomains budget (header and body). The time axis is the frame
 * proof and precedes ready (adapter-matrix M1, row C1), so this read now
 * sits on the path to the pill's first terminal state; it shares the tile
 * proof's deadline, which sits below the 10 s boot-idle budget (M8), so a
 * stalled axis reaches its stated fallback inside a settled boot. It was
 * 15 s while the latest frame's verdict did not wait for it.
 */
const DOMAINS_TIMEOUT_MS = RASTER_PROOF_DEADLINE_MS;

let masterController: AbortController | null = null;
let tileWatch: RasterTileWatch | null = null;
/** The default frame watcher's latest verdict; null until a cycle ends. */
let tileVerdict: RasterTileOutcome | null = null;
/**
 * True from the start of an activation until its time axis (DescribeDomains)
 * has answered, failed, or been read as empty. While it holds, the default
 * (latest) frame's verdict is recorded but never reported: the frame proof
 * precedes ready (adapter-matrix M1, row C1), and a link that names a
 * historical `sst=` date must not read live from the latest frame before
 * that date is resolved (DDM-P14-T04, review finding C2).
 */
let axisPending = false;
/**
 * The stamp's statement of a link fallback: the linked `sst=` date the axis
 * does not list, so the latest frame is shown instead. Null when there is
 * nothing to state; cleared by the first step to a frame and on deactivate.
 */
let restoreNote: string | null = null;
let pacificHintShown = false;

/** Available dates (ascending YYYY-MM-DD), enumerated from DescribeDomains. */
let dates: string[] = [];
let dateIndex = 0;
/** Dated frames currently mounted on the map (bounded to three: the
 * displayed frame, the one it faded from, and at most one lookahead). */
let mountedFrames: string[] = [];
/** The dated frame the module last mounted AS THE DISPLAYED frame; null
 * while only the boot-time `default` (latest) layer is up. Tracked
 * separately from `mountedFrames` because a lookahead frame is mounted at
 * opacity 0 and must never be mistaken for the frame on screen. */
let displayedFrame: string | null = null;
/** The frame mounted purely as lookahead (opacity 0), or null. */
let prefetchedFrame: string | null = null;
/** Each dated frame is its own source, so each proves its own tiles, from the
 * moment it is mounted (DDM-P14-T04): a lookahead frame that loaded while
 * hidden is already proven when it is stepped to. Keyed by date. */
const frameWatches = new Map<string, RasterTileWatch>();
/** Each mounted frame's latest tile verdict; absent until its first cycle ends. */
const frameVerdicts = new Map<string, RasterTileOutcome>();
let playing = false;
let buffering = false;
/** Supersede counter (invariant 5). */
let stepEpoch = 0;

type SstStatus = 'loading' | RasterTileOutcome;

function reportStatus(state: SstStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

/** Announce the displayed frame date to the on-map key (see the constant). */
function emitSstSnapshot(
  status: 'ready' | 'inactive',
  date: string | null
): void {
  window.dispatchEvent(
    new CustomEvent(SST_SNAPSHOT_EVENT, { detail: { status, date } })
  );
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

/**
 * What the surface shows once its time axis has answered, or failed to.
 *
 *   - `latest`: no date was linked, or the linked date is the newest frame,
 *     which is the latest frame already on the map (the URL canonicalizes
 *     to no date).
 *   - `restore`: the linked date is an enumerated historical frame, shown by
 *     its index; that frame's own tiles decide live.
 *   - `fallback`: the linked date cannot be shown. Either the axis does not
 *     list it (`outside-window`: a verified absence, outside the window or a
 *     gap day), or there is no axis to read it against (`axis-unavailable`:
 *     a failed, empty or unreadable enumeration). The latest frame is shown,
 *     the link's date is cleared, and the stamp says which date that was.
 */
export type SstRestorePlan =
  | { readonly kind: 'latest' }
  | { readonly kind: 'restore'; readonly index: number }
  | {
      readonly kind: 'fallback';
      readonly requested: string;
      readonly reason: 'outside-window' | 'axis-unavailable';
    };

/** Decide the restore for a linked `sst=` date against the enumerated dates (ascending). */
export function planSstRestore(
  requested: string | null,
  available: readonly string[]
): SstRestorePlan {
  if (requested === null) return { kind: 'latest' };
  if (available.length === 0) return { kind: 'fallback', requested, reason: 'axis-unavailable' };
  const index = available.indexOf(requested);
  if (index === available.length - 1) return { kind: 'latest' };
  if (index >= 0) return { kind: 'restore', index };
  return { kind: 'fallback', requested, reason: 'outside-window' };
}

/** A linked date as a stamp states it: its label for a real calendar day, else verbatim. */
function linkedDateText(iso: string): string {
  const ms = isoToMs(iso);
  return Number.isFinite(ms) && msToIso(ms) === iso ? dateLabel(iso) : iso;
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
    // The frame's own tile proof, attached before the add so no tile of it
    // can load unseen. It speaks for the surface only while it is the
    // displayed frame; a lookahead frame records its verdict silently.
    frameWatches.get(date)?.detach();
    frameVerdicts.delete(date);
    frameWatches.set(
      date,
      watchRasterTiles(
        map,
        id,
        (state) => {
          frameVerdicts.set(date, state);
          if (displayedFrame === date) reportStatus(state);
        },
        TILE_PROOF_WATCH
      )
    );
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
  frameWatches.get(date)?.detach();
  frameWatches.delete(date);
  frameVerdicts.delete(date);
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  mountedFrames = mountedFrames.filter((d) => d !== date);
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
  const previous = displayedFrame;
  if (previous === date && dateIndex === clamped) return;
  // A step replaces whatever the link asked for, so its fallback statement
  // no longer describes the frame on screen.
  restoreNote = null;

  // Already mounted when this frame was the lookahead: mountFrame no-ops
  // on the source, the frame's own watcher already holds its verdict, and
  // the buffer wait below resolves at once.
  mountFrame(map, date, 0);
  displayedFrame = date;
  if (prefetchedFrame === date) prefetchedFrame = null;

  // The pill is this frame's own tile verdict, never the frame it fades
  // from: loading until the frame's watcher has one. The shared wait below
  // only paces the loop; it writes no status, so an unproven wait (a dead
  // tile edge, a timeout) never reads live.
  const verdict = frameVerdicts.get(date);
  buffering = true;
  reportStatus(verdict ?? 'loading');
  dateIndex = clamped;
  installTimeBar(map);
  await waitForRasterTileProof(
    map,
    frameSourceId(date),
    signal,
    BUFFER_TIMEOUT_MS,
    verdict === 'ready' || verdict === 'degraded'
  );
  if (signal.aborted || myEpoch !== stepEpoch) return;
  buffering = false;

  timeline.setSstDate(clamped === dates.length - 1 ? null : date);

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

  // Look ONE frame ahead at opacity 0 so the next step (and every Play
  // beat) starts warm instead of buffering from cold for up to
  // BUFFER_TIMEOUT_MS. Polite about the network budget: prefetchAllowed()
  // is false on Save-Data and 2g, and a paused rail sitting on the newest
  // stop looks ahead to nothing (only the wrapping loop needs frame 0).
  // Cancellation: the guard above already returned for an aborted or
  // superseded step, and nothing awaits between it and here.
  const aheadIndex =
    clamped < dates.length - 1 ? clamped + 1 : playing ? 0 : -1;
  if (aheadIndex >= 0 && prefetchAllowed()) {
    const ahead = dates[aheadIndex]!;
    if (ahead !== date && !mountedFrames.includes(ahead)) {
      mountFrame(map, ahead, 0);
      prefetchedFrame = ahead;
    }
  }

  while (mountedFrames.length > 3) {
    const oldest = mountedFrames[0]!;
    // Never unmount what is painted; the bound is already satisfied.
    if (oldest === displayedFrame) break;
    if (oldest === prefetchedFrame) prefetchedFrame = null;
    unmountFrame(map, oldest);
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

/**
 * The honest fallback bar for a surface that IS painted but has no
 * enumerated dates: the provider's `default` frame is the latest one it
 * publishes, and we cannot say which day that is. A dated raster with no
 * stated date breaks the date-honesty rule, so the bar states the absence
 * itself rather than staying down (which read as "no dated product is
 * displayed" while a real field was on the map).
 *
 * `linked` is the `sst=` date the link asked for and the layer could not
 * resolve without an axis; the detail names it, so the fallback is stated
 * rather than silent (review finding C2).
 */
function installStampOnlyTimeBar(linked: string | null = null): void {
  setTimeBar(LAYER_KEY, {
    ariaLabel: 'Sea surface temperature anomaly date',
    stamp: {
      horizon: 'current',
      headline: 'Latest available frame · date unavailable from the provider',
      detail:
        linked === null
          ? 'GHRSST MUR daily SST anomaly · the provider did not answer its time axis this session, so the frame date cannot be stated and stepping stays off'
          : `GHRSST MUR daily SST anomaly · the provider's time axis could not be read this session, so the linked date, ${linkedDateText(linked)}, cannot be shown; the latest frame is shown undated and stepping stays off`,
      register: 'observed'
    }
  });
}

/** The stamp detail for a linked date the enumerated axis does not list. */
function outsideWindowNote(linked: string): string {
  return `GHRSST MUR daily SST anomaly · the linked date, ${linkedDateText(linked)}, is not among the ${dates.length} most recent frames the provider lists, so the latest frame is shown`;
}

/**
 * End the wait for the time axis: from here the default (latest) frame's
 * watcher speaks for the surface while no dated frame is displayed, and the
 * verdict it already holds is reported now. A caller that falls back from a
 * linked date clears `sst=` BEFORE this, so the pill never reads live while
 * the link names a frame that is not on the map.
 */
function releaseLatestVerdict(): void {
  axisPending = false;
  if (displayedFrame === null && tileVerdict !== null) reportStatus(tileVerdict);
}

function installTimeBar(map: maplibregl.Map): void {
  if (dates.length === 0) return;
  const date = dates[dateIndex] ?? dates[dates.length - 1]!;
  const reduced = prefersReducedMotion();
  emitSstSnapshot('ready', date);

  setTimeBar(LAYER_KEY, {
    ariaLabel: 'Sea surface temperature anomaly timeline',
    stamp: {
      // A measured daily field is the observed register at every ENSO
      // horizon chip; the stamp says Current Conditions even under the Long
      // Range chip, because that is what the surface is.
      horizon: 'current',
      headline: `Observed ${dateLabel(date)}`,
      detail: buffering
        ? 'GHRSST MUR daily SST anomaly · buffering tiles'
        : (restoreNote ??
          'GHRSST MUR daily SST anomaly · a measured daily field; Play replays real days'),
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
 * and stand up the loop controls.
 *
 * The time axis is the frame proof and precedes ready (adapter-matrix M1,
 * row C1; DDM-P14-T04, review finding C2): the pill reads loading until it
 * answers, even once the latest frame's tiles are proven, so a link that
 * names a historical `sst=` date never reads live from the latest frame.
 * Once it answers, a linked historical frame is shown and its own tiles
 * decide live; otherwise the latest frame's verdict speaks. A linked date
 * the axis does not list, or an axis that fails or cannot be read, falls
 * back to the latest frame: `sst=` is cleared first, and the stamp states
 * which date could not be shown. Enumeration failing is not an error for
 * the latest frame itself: it still renders on its own tile verdict; only
 * the temporal controls stay down (an honest absence, logged).
 *
 * Worst case to a terminal state (M8): a plain boot is bounded by the
 * larger of DOMAINS_TIMEOUT_MS and the tile proof's deadline, both below
 * the 10 s boot-idle budget. A historical link proves its own frame after
 * the axis answers, so its worst case is the two deadlines in sequence,
 * above that budget: the declared mismatch.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  reportStatus('loading');

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  axisPending = true;

  try {
    // A re-activation over the source its watcher has been proving (no
    // deactivate between) keeps both; see the watcher below.
    const kept = tileWatch !== null && map.getSource(SOURCE_ID) !== undefined;
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
    } else if (displayedFrame === null) {
      // Only while no dated frame is on screen. A re-activation over a
      // displayed dated frame (no deactivate between) leaves the latest
      // frame's layer as the step left it: showFrame hid it once that frame
      // faded in, and showing it again would paint the latest imagery
      // beneath the dated one (LATER:163). A step the re-activation aborted
      // before its fade never hid it, so it is left showing, not forced off.
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
          // Explicitly the self-hosted fontstack (U0a): MapLibre's implicit
          // default stack is not in public/fonts/glyphs/ and would 404.
          'text-font': ['Noto Sans Regular'],
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

    // Tile proof for the boot-time `default` (latest) frame: live only once
    // the view's tiles load, live (partial) when some fail, unavailable when
    // none load or none were requested (DR-050 a). It speaks for the surface
    // only after the time axis has answered (axisPending) and until a dated
    // frame is displayed; that frame's own watcher (mountFrame) speaks from
    // then on. A kept source keeps its watcher and evidence: a rendered
    // source whose tiles are cached emits no new tile event, so a fresh
    // watcher would read unavailable on its deadline alone. A source this
    // call adds is proven afresh.
    if (!kept) {
      tileWatch?.detach();
      tileVerdict = null;
      tileWatch = watchRasterTiles(
        map,
        SOURCE_ID,
        (state) => {
          tileVerdict = state;
          if (displayedFrame === null && !axisPending) reportStatus(state);
        },
        TILE_PROOF_WATCH
      );
    }
    activateEnsoFlow(map);

    showLegend(LAYER_KEY, {
      order: LEGEND_ORDER.surface,
      render: (body) =>
        renderSwatchLegend(
          body,
          SST_ANOMALY_LEGEND_TITLE,
          // The one shared scale (src/config/palette.ts): the sidebar legend
          // and the on-map key read the same table so they cannot drift.
          SST_ANOMALY_SCALE,
          'NASA GHRSST MUR daily anomaly · the dashed box is Nino 3.4, the region the ENSO index measures'
        )
    });

    if (!pacificHintShown && !viewIncludesNino34(map)) {
      pacificHintShown = true;
      showToast('Ocean temperature anomaly is global; zoom out toward the equatorial Pacific to see the ENSO signal.');
    }

    // No `ready` here (DDM-P14-T04, found-001): the status stays `loading`
    // until a watcher proves the view's tiles. A re-activation over a dated
    // frame left on the map (it stays mounted until deactivate, and an
    // earlier axis proved it) re-reports the verdict its watcher already
    // holds. The latest frame's verdict waits for this activation's time
    // axis (releaseLatestVerdict). The key can state the surface before the
    // TIME axis resolves; the observed date follows once installTimeBar runs
    // with real dates.
    const held = displayedFrame === null ? undefined : frameVerdicts.get(displayedFrame);
    if (held) reportStatus(held);
    emitSstSnapshot('ready', null);
  } catch (err) {
    console.warn('[sst-anomaly] activation failed.', err);
    reportStatus('error');
    return;
  }

  // ---- The temporal axis: enumerate real dates, then offer the loop. ----
  try {
    const response = await fetchBufferedWithBudget(
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
    // The surface stays useful without a time axis; say so below.
    console.warn('[sst-anomaly] TIME enumeration failed; Play/step disabled this session.', err);
    dates = [];
  }

  // A failed, empty or unreadable enumeration is one user-visible situation:
  // the provider's latest frame is painted with no date to state. A linked
  // date cannot be resolved without an axis, so the link heals and the
  // stamp names the date it could not show; a dated frame already on the
  // map (a re-activation) keeps its own date.
  if (dates.length === 0) {
    const plan = planSstRestore(displayedFrame === null ? timeline.sstDate : null, dates);
    const linked = plan.kind === 'fallback' ? plan.requested : null;
    if (linked !== null) timeline.setSstDate(null);
    installStampOnlyTimeBar(linked);
    releaseLatestVerdict();
    return;
  }
  dateIndex = dates.length - 1;

  // URL restore: land PAUSED on the shared frame (never auto-play).
  const plan = planSstRestore(timeline.sstDate, dates);
  if (plan.kind === 'restore') {
    // showFrame makes the linked frame the displayed one before its first
    // await, so that frame's own watcher speaks from here and the latest
    // frame's verdict never does.
    const restoring = showFrame(map, plan.index);
    axisPending = false;
    await restoring;
    return; // showFrame installed the bar
  }
  // The newest date is the latest frame already up (the URL canonicalizes to
  // no date). A date the axis does not list (outside the window, or a gap
  // day) falls back to the latest frame and the stamp says so. Either way
  // the URL heals BEFORE the latest frame's verdict is released. (A dated
  // frame already on the map, from a re-activation, is not the latest
  // frame, so the note is never written over it.)
  if (plan.kind === 'fallback' && displayedFrame === null) {
    restoreNote = outsideWindowNote(plan.requested);
  }
  timeline.setSstDate(null);
  releaseLatestVerdict();
  installTimeBar(map);

  // Politely pre-warm the previous frame so the first step back is instant.
  if (prefetchAllowed() && dates.length >= 2) {
    const warm = dates[dates.length - 2]!;
    mountFrame(map, warm, 0);
    prefetchedFrame = warm;
  }
}

/** Stop activation requests immediately; the layer controller serializes teardown. */
export function cancelActivation(): void {
  masterController?.abort();
  cancelEnsoFlowLoad();
}

/**
 * Stop the loop, abort in-flight work, and remove the SST raster, every
 * dated frame, the Nino 3.4 box, and the legend. Resets the URL's `sst=`
 * so a paused historical frame never outlives the surface.
 */
export function deactivate(map: maplibregl.Map): void {
  deactivateEnsoFlow();
  playing = false;
  buffering = false;
  stepEpoch++;
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  tileWatch?.detach();
  tileWatch = null;
  axisPending = false;
  restoreNote = null;
  for (const date of [...mountedFrames]) {
    unmountFrame(map, date);
  }
  displayedFrame = null;
  prefetchedFrame = null;
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
  emitSstSnapshot('inactive', null);
}

/**
 * No-op popup binder: the anomaly is a server-rendered raster with no
 * per-pixel attributes on the client. Same uniform-shape rationale as
 * usfs-whp.ts.
 */
export function bindPopups(_map: maplibregl.Map): void {
  // Intentionally empty; see JSDoc above.
}
