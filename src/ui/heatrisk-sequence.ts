/**
 * Selected-place National Weather Service (NWS) HeatRisk sequence.
 *
 * Loaded only after the HeatRisk layer emits its first frame event. Values
 * come from exact-time ImageServer identify responses, never rendered pixels.
 */

import {
  HEATRISK_CATEGORIES,
  type HeatRiskValue
} from '../config/palette';
import { URLS } from '../config/urls';
import {
  getPlaceSelection,
  onPlaceSelectionChange,
  type PlaceSelection
} from '../state/place-selection';
import { registry } from '../state/registry';
import { escapeHtml } from '../util/escape';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';

const FRAMES_EVENT = 'ddm:heatrisk-frames';
const DAY_SELECT_EVENT = 'ddm:heatrisk-day-select';
const FETCH_TIMEOUT_MS = 10_000;
const VALID_PERIOD_MS = 24 * 60 * 60 * 1000;

type FrameStatus =
  | 'loading'
  | 'ready'
  | 'degraded'
  | 'error'
  | 'no-data'
  | 'inactive';

export interface HeatRiskFrame {
  readonly day: number;
  readonly validTime: number;
  readonly name: string;
}

export interface HeatRiskFrameDetail {
  readonly status: FrameStatus;
  readonly frames: readonly HeatRiskFrame[];
  readonly selectedDay: number | null;
  readonly hasCoverage: boolean | null;
}

export interface HeatRiskIdentify {
  readonly frame: HeatRiskFrame;
  readonly value: HeatRiskValue | null;
  readonly retrievedAt: number;
  readonly validThrough: number;
  /**
   * Whether `frame` came from the map's displayed selection (the layer is on
   * and a day is showing) or was fetched independently from the catalog's own
   * earliest advertised granule because no displayed frame was available
   * (DR-014 a: the briefing describes the place, not the map).
   */
  readonly frameSource: 'selected' | 'catalog';
}

interface SequenceRead {
  readonly key: string;
  readonly lng: number;
  readonly lat: number;
  readonly frames: readonly HeatRiskFrame[];
  readonly values: readonly (HeatRiskValue | null)[];
  readonly retrievedAt: number;
}

let mounted = false;
let host: HTMLElement | null = null;
let frameStatus: FrameStatus = 'inactive';
let frames: readonly HeatRiskFrame[] = [];
let selectedDay: number | null = null;
let selection: PlaceSelection | null = null;
let requestController: AbortController | null = null;
let cachedRead: SequenceRead | null = null;
let pendingRead: {
  readonly key: string;
  readonly promise: Promise<SequenceRead>;
} | null = null;
let activationGeneration = 0;
let activationOpen = false;
/**
 * The moment `activationOpen` last flipped from true to false (a genuine
 * deactivation, not a boot with the layer already off), or null when the
 * layer has never been active. Drives the briefing fallback's settle wait
 * below: a toggle off then quickly on must not cost a new /identify.
 */
let deactivatedAt: number | null = null;
/**
 * The briefing's independent-catalog fallback result, memoized per point and
 * per catalog extent (the correction to the RACE finding: the layer-off
 * fallback used to fire a brand-new catalog read plus an /identify on every
 * call). Invalidated on a new advertised extent (the key includes it) and on
 * a place-selection change (cleared where `cachedRead` is, in
 * `mountHeatRiskSequence`'s `onPlaceSelectionChange` handler). NOT
 * invalidated by activation or deactivation: memoizing across a toggle is
 * the whole point.
 *
 * DDM-P7-T05 F4: the memo above carried no age bound, and HeatRisk revises
 * the current-day grid in place (the service can update today's raster
 * class without moving the catalog's advertised extent), so an unbounded
 * memo could serve an hour-old, now-wrong class forever once the extent
 * stopped changing. Keying on the calendar day was the other option
 * considered; a plain TTL is chosen instead because it bounds staleness
 * with no extra UTC-day arithmetic and matches how the layer itself is
 * read (a raster cell, re-read on a clock, not on a day boundary).
 */
const FALLBACK_CACHE_TTL_MS = 60 * 60 * 1000;

let fallbackCache: {
  readonly lng: number;
  readonly lat: number;
  readonly extentStart: number;
  readonly extentEnd: number;
  readonly identify: HeatRiskIdentify;
} | null = null;

function categoryFor(value: HeatRiskValue) {
  return HEATRISK_CATEGORIES[value]!;
}

function frameForSelectedDay(): HeatRiskFrame | null {
  return (
    frames.find((frame) => frame.day === selectedDay) ??
    null
  );
}

function waitForSelectedFrame(
  signal: AbortSignal
): Promise<HeatRiskFrame | null> {
  const current = activationOpen ? frameForSelectedDay() : null;
  if (current || !registry.getActiveKeys().has('heatrisk')) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (frame: HeatRiskFrame | null): void => {
      window.clearTimeout(timer);
      window.removeEventListener(FRAMES_EVENT, onFrame);
      signal.removeEventListener('abort', onAbort);
      resolve(frame);
    };
    const onAbort = (): void => finish(null);
    const onFrame = (event: Event): void => {
      const detail = (event as CustomEvent<HeatRiskFrameDetail>).detail;
      if (!detail) return;
      const frame =
        detail.frames.find(
          (candidate) => candidate.day === detail.selectedDay
        ) ?? null;
      if (frame || detail.status === 'error' || detail.status === 'inactive') {
        finish(frame);
      }
    };
    timer = window.setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
    window.addEventListener(FRAMES_EVENT, onFrame);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function formatDay(validTime: number): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'UTC'
  }).format(new Date(validTime));
}

function formatCellDate(validTime: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(validTime));
}

function formatDate(validTime: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(validTime));
}

function formatMoment(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short'
  }).format(new Date(time));
}

function readKey(
  sequenceFrames: readonly HeatRiskFrame[],
  lng: number,
  lat: number,
  generation: number
): string {
  return `${generation}|${lng},${lat}|${sequenceFrames.map((frame) => frame.validTime).join(',')}`;
}

/** The issuer contract is seven distinct daily periods (mirrors heatrisk.ts). */
export const REQUIRED_FRAME_COUNT = 7;

/**
 * DR-070 amended 2026-09-08, DR-071: the briefing's HeatRisk claim
 * (src/impact/sources.ts fetchHeatRiskClaims) and the map layer's time bar
 * (src/layers/heatrisk.ts frameStamp/framePhase) must agree on when a
 * HeatRisk claim is "in force." A 24-hour period is in force, the outlook
 * register, while `now` has not reached its end; once the period has ended
 * the claim reads observed, the same "the spent claim the doctrine
 * forbids" boundary framePhase draws (`now < end` covers both not-begun and
 * in-progress, which framePhase and this both treat as one outlook phase;
 * `now >= end` is ended). Exported so sources.ts reads the SAME boundary
 * rather than a second copy of it.
 */
export function heatRiskClaimRegister(
  periodEnd: number,
  now: number
): 'observed' | 'outlook' {
  return now < periodEnd ? 'outlook' : 'observed';
}

/**
 * Enumerate the catalog independently of the layer module's `frames` state,
 * with the SAME integrity gate `src/layers/heatrisk.ts` runs at activation:
 * a usable time extent, and exactly seven distinct granules, sorted, spanning
 * that extent at a consistent 24-hour cadence. A catalog the map's own
 * activation would reject must not quietly seed an independent claim; this
 * duplicates the check rather than trusting one arbitrary row.
 */
function buildMetadataUrl(): string {
  return `${URLS.nwsHeatRisk}?f=json`;
}

function buildFullCatalogUrl(): string {
  const params = new URLSearchParams({
    where: 'category=1',
    outFields: 'name,idp_validtime',
    returnGeometry: 'false',
    orderByFields: 'idp_validtime ASC',
    f: 'json'
  });
  return `${URLS.nwsHeatRisk}/query?${params.toString()}`;
}

function parseTimeExtent(json: unknown): readonly [number, number] | null {
  if (!isObject(json) || !isObject(json.timeInfo)) return null;
  const extent = json.timeInfo.timeExtent;
  if (!Array.isArray(extent) || extent.length !== 2) return null;
  const [start, end] = extent;
  if (
    typeof start !== 'number' ||
    !Number.isFinite(start) ||
    typeof end !== 'number' ||
    !Number.isFinite(end) ||
    start > end
  ) {
    return null;
  }
  return [start, end];
}

function parseCatalogFrames(
  json: unknown,
  extent: readonly [number, number]
): readonly HeatRiskFrame[] | null {
  if (
    !isObject(json) ||
    json.exceededTransferLimit === true ||
    !Array.isArray(json.features)
  ) {
    return null;
  }
  const byTime = new Map<number, string>();
  for (const feature of json.features) {
    if (!isObject(feature) || !isObject(feature.attributes)) return null;
    const validTime = feature.attributes.idp_validtime;
    const name = feature.attributes.name;
    if (
      typeof validTime !== 'number' ||
      !Number.isFinite(validTime) ||
      !Number.isSafeInteger(validTime) ||
      typeof name !== 'string' ||
      name.length === 0
    ) {
      return null;
    }
    if (byTime.has(validTime)) return null;
    byTime.set(validTime, name);
  }
  const advertised = Array.from(byTime, ([validTime, name]) => ({
    validTime,
    name
  })).sort((a, b) => a.validTime - b.validTime);
  if (
    advertised.length !== REQUIRED_FRAME_COUNT ||
    advertised[0]?.validTime !== extent[0] ||
    advertised.at(-1)?.validTime !== extent[1] ||
    advertised.some(
      (frame, index) =>
        index > 0 &&
        frame.validTime - advertised[index - 1]!.validTime !== VALID_PERIOD_MS
    )
  ) {
    return null;
  }
  return advertised.map((frame, index) => ({
    day: index + 1,
    validTime: frame.validTime,
    name: frame.name
  }));
}

/**
 * The catalog's own advertised time extent: the cheap half of the fallback
 * read (a single metadata fetch, no `/identify`). Callers use this to decide
 * whether a memoized fallback result is still current before paying for the
 * full catalog enumeration and the counted identify request.
 */
async function fetchCatalogExtent(
  signal: AbortSignal
): Promise<readonly [number, number] | null> {
  const metadataJson = await fetchJsonWithBudget(
    buildMetadataUrl(),
    null,
    signal,
    FETCH_TIMEOUT_MS
  );
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return parseTimeExtent(metadataJson);
}

/**
 * Fetch today's frame (the catalog's earliest advertised granule) straight
 * from the catalog, with no dependency on the layer module's activation
 * state, for an extent already read by `fetchCatalogExtent`. Used only when
 * no displayed frame is available to read (the layer is off, or never turned
 * on).
 */
async function fetchTodayFrame(
  extent: readonly [number, number],
  signal: AbortSignal
): Promise<HeatRiskFrame | null> {
  const catalogJson = await fetchJsonWithBudget(
    buildFullCatalogUrl(),
    null,
    signal,
    FETCH_TIMEOUT_MS
  );
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const frames = parseCatalogFrames(catalogJson, extent);
  return frames?.[0] ?? null;
}

/**
 * The settle window a fallback read waits, after a genuine active-to-inactive
 * transition, before treating the layer as durably off. A toggle off then
 * quickly on must not cost the fallback's own /identify; the layer's own
 * reactivation event re-runs the claim through the selected-frame path once
 * it is open again.
 */
const DEACTIVATION_SETTLE_MS = 500;

/**
 * Wait out the remainder of the deactivation settle window, or resolve at
 * once when there is none to wait (the layer was never active, or the window
 * has already elapsed). Resolves early on abort; callers re-check
 * `activationOpen` and `activationGeneration` immediately after, so an abort
 * and a natural elapse are handled identically.
 */
function waitForDeactivationSettle(signal: AbortSignal): Promise<void> {
  if (deactivatedAt === null || signal.aborted) return Promise.resolve();
  const remaining = DEACTIVATION_SETTLE_MS - (Date.now() - deactivatedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, remaining);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildIdentifyUrl(
  frame: HeatRiskFrame,
  lng: number,
  lat: number
): string {
  const params = new URLSearchParams({
    geometry: JSON.stringify({
      x: lng,
      y: lat,
      spatialReference: { wkid: 4326 }
    }),
    geometryType: 'esriGeometryPoint',
    time: String(frame.validTime),
    returnGeometry: 'false',
    returnCatalogItems: 'true',
    returnPixelValues: 'true',
    f: 'json'
  });
  return `${URLS.nwsHeatRisk}/identify?${params.toString()}`;
}

function identifyValue(json: unknown, requestedTime: number): HeatRiskValue | null {
  if (!isObject(json)) throw new Error('invalid HeatRisk identify payload');
  const raw = json.value;
  if (
    raw === null ||
    (typeof raw === 'string' && raw.toLowerCase() === 'nodata')
  ) {
    return null;
  }
  if (raw === undefined || raw === '') {
    throw new Error('HeatRisk identify omitted its value');
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error('HeatRisk identify returned an unknown class');
  }

  const catalogItems = json.catalogItems;
  if (!isObject(catalogItems) || !Array.isArray(catalogItems.features)) {
    throw new Error('HeatRisk identify omitted its catalog time');
  }
  const returnedTimes = catalogItems.features.map((feature) => {
    if (!isObject(feature) || !isObject(feature.attributes)) return null;
    return feature.attributes.idp_validtime;
  });
  if (
    returnedTimes.length === 0 ||
    returnedTimes.some((time) => time !== requestedTime)
  ) {
    throw new Error('HeatRisk identify time did not match the displayed frame');
  }
  return value as HeatRiskValue;
}

async function fetchFrameValue(
  frame: HeatRiskFrame,
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<HeatRiskValue | null> {
  const json = await fetchJsonWithBudget(
    buildIdentifyUrl(frame, lng, lat),
    null,
    signal,
    FETCH_TIMEOUT_MS
  );
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return identifyValue(json, frame.validTime);
}

async function fetchSequence(
  sequenceFrames: readonly HeatRiskFrame[],
  lng: number,
  lat: number,
  generation: number,
  signal: AbortSignal
): Promise<SequenceRead> {
  const key = readKey(sequenceFrames, lng, lat, generation);
  const values = await Promise.all(
    sequenceFrames.map((frame) =>
      fetchFrameValue(frame, lng, lat, signal)
    )
  );
  return {
    key,
    lng,
    lat,
    frames: sequenceFrames,
    values,
    retrievedAt: Date.now()
  };
}

function sequenceCell(
  frame: HeatRiskFrame,
  value: HeatRiskValue | null
): string {
  const selected = frame.day === selectedDay;
  const category = value === null ? null : categoryFor(value);
  const valueText = value === null ? 'ND' : String(value);
  const spokenValue =
    value === null
      ? 'no data'
      : `value ${value}, ${category!.label}`;
  return (
    `<button type="button" class="heatrisk-sequence-cell${selected ? ' selected' : ''}" ` +
    `data-heatrisk-sequence-day="${frame.day}" data-value="${value === null ? 'no-data' : value}" ` +
    `aria-pressed="${selected}" aria-label="Day ${frame.day}, ${escapeHtml(
      formatDay(frame.validTime)
    )} ${escapeHtml(formatDate(frame.validTime))}, ${escapeHtml(spokenValue)}" ` +
    `style="--heatrisk-cell-color:${escapeHtml(category?.color ?? 'transparent')}">` +
    `<span class="heatrisk-sequence-day">${escapeHtml(formatDay(frame.validTime))}</span>` +
    `<span class="heatrisk-sequence-date">${escapeHtml(formatCellDate(frame.validTime))}</span>` +
    `<strong class="heatrisk-sequence-value">${valueText}</strong>` +
    '</button>'
  );
}

function textAlternative(read: SequenceRead): string {
  return read.frames
    .map((frame, index) => {
      const value = read.values[index] ?? null;
      if (value === null) {
        return `${formatDate(frame.validTime)}: no data`;
      }
      return `${formatDate(frame.validTime)}: value ${value}, ${categoryFor(value).label}`;
    })
    .join('; ');
}

function selectedReadHtml(read: SequenceRead): string {
  const index = read.frames.findIndex((frame) => frame.day === selectedDay);
  const frame = read.frames[index];
  if (!frame) return '';
  const value = read.values[index] ?? null;
  const validThrough = frame.validTime + VALID_PERIOD_MS;
  const validity =
    `${formatMoment(frame.validTime)} to ${formatMoment(validThrough)}`;
  if (value === null) {
    return (
      '<p class="heatrisk-sequence-selected" data-heatrisk-selected-read>' +
      `<strong>no data</strong> · Experimental · Valid ${escapeHtml(validity)}. ` +
      'The National Weather Service returned no HeatRisk value for this point and period.</p>'
    );
  }
  const category = categoryFor(value);
  return (
    '<p class="heatrisk-sequence-selected" data-heatrisk-selected-read>' +
    `<strong>${value} · ${escapeHtml(category.label)}</strong> · Experimental · ` +
    `Valid ${escapeHtml(validity)}. ${escapeHtml(category.meaning)}</p>`
  );
}

function renderRead(read: SequenceRead): void {
  if (!host || !selection) return;
  if (
    !activationOpen ||
    frameStatus === 'inactive' ||
    read.key !==
      readKey(
        frames,
        selection.context.lngLat.lng,
        selection.context.lngLat.lat,
        activationGeneration
      )
  ) {
    hide();
    return;
  }
  const alternative = textAlternative(read);
  host.innerHTML =
    '<div class="heatrisk-sequence-heading">' +
    `<strong>HeatRisk at the selected point for ${escapeHtml(selection.label)}</strong>` +
    '<span>7 days</span></div>' +
    '<div class="heatrisk-sequence-grid" role="list">' +
    read.frames
      .map((frame, index) => sequenceCell(frame, read.values[index] ?? null))
      .join('') +
    '</div>' +
    selectedReadHtml(read) +
    `<p id="heatrisk-sequence-alt" class="sr-only">Seven-day HeatRisk text alternative. ${escapeHtml(alternative)}.</p>` +
    '<p class="heatrisk-sequence-source">' +
    `<a href="${escapeHtml(URLS.nwsHeatRisk)}/info/iteminfo" target="_blank" rel="noopener">National Weather Service HeatRisk</a> · ` +
    `Retrieved ${escapeHtml(formatMoment(read.retrievedAt))}. Selected valid period shown above.</p>`;
  host.setAttribute(
    'aria-label',
    `National Weather Service HeatRisk seven-day sequence at the selected point for ${selection.label}`
  );
  host.setAttribute('aria-describedby', 'heatrisk-sequence-alt');
  host.hidden = false;
}

function renderState(copy: string): void {
  if (!host || !selection) return;
  host.innerHTML =
    '<div class="heatrisk-sequence-heading">' +
    `<strong>HeatRisk at the selected point for ${escapeHtml(selection.label)}</strong>` +
    '</div>' +
    `<p class="heatrisk-sequence-state">${escapeHtml(copy)}</p>`;
  host.removeAttribute('aria-describedby');
  host.setAttribute(
    'aria-label',
    `National Weather Service HeatRisk sequence at the selected point for ${selection.label}: ${copy}`
  );
  host.hidden = false;
}

function hide(): void {
  if (host) host.hidden = true;
}

async function refreshRead(): Promise<void> {
  if (
    !selection ||
    frames.length === 0 ||
    selectedDay === null ||
    frameStatus === 'inactive'
  ) {
    requestController?.abort();
    requestController = null;
    hide();
    return;
  }

  const { lng, lat } = selection.context.lngLat;
  const generation = activationGeneration;
  const key = readKey(frames, lng, lat, generation);
  if (cachedRead?.key === key) {
    renderRead(cachedRead);
    return;
  }

  let controller = requestController;
  let promise = pendingRead?.key === key ? pendingRead.promise : null;
  if (!promise || !controller || controller.signal.aborted) {
    requestController?.abort();
    controller = new AbortController();
    requestController = controller;
    promise = fetchSequence(
      frames,
      lng,
      lat,
      generation,
      controller.signal
    );
    pendingRead = { key, promise };
    renderState('loading...');
  }
  try {
    const read = await promise;
    if (
      controller.signal.aborted ||
      !selection ||
      !activationOpen ||
      activationGeneration !== generation ||
      readKey(
        frames,
        selection.context.lngLat.lng,
        selection.context.lngLat.lat,
        activationGeneration
      ) !== key
    ) {
      return;
    }
    cachedRead = read;
    if (pendingRead?.promise === promise) pendingRead = null;
    renderRead(read);
  } catch (err) {
    if (controller.signal.aborted) return;
    console.warn('[heatrisk-sequence] identify failed.', err);
    if (pendingRead?.promise === promise) pendingRead = null;
    renderState('unavailable');
  }
}

function clearActivationRead(): void {
  requestController?.abort();
  requestController = null;
  cachedRead = null;
  pendingRead = null;
}

function applyFrameDetail(detail: HeatRiskFrameDetail): void {
  const sequenceUnchanged =
    detail.frames === frames && detail.selectedDay === selectedDay;
  const freshLoading =
    detail.status === 'loading' && detail.frames.length === 0;
  let activationChanged = false;
  if (detail.status === 'inactive') {
    const wasOpen = activationOpen;
    activationGeneration += 1;
    activationOpen = false;
    clearActivationRead();
    // Only a genuine active-to-inactive transition starts the settle clock;
    // a boot that arrives already inactive must not delay the fallback.
    if (wasOpen) deactivatedAt = Date.now();
  } else if (!activationOpen || freshLoading) {
    activationGeneration += 1;
    activationOpen = true;
    deactivatedAt = null;
    clearActivationRead();
    activationChanged = true;
  }
  frameStatus = detail.status;
  frames = detail.frames;
  selectedDay = detail.selectedDay;
  if (detail.status === 'inactive') {
    hide();
    return;
  }
  // Raster status updates do not change sequence content. Preserve the live
  // buttons and focus while the current identify read is pending or cached.
  if (
    !activationChanged &&
    sequenceUnchanged &&
    (cachedRead !== null || pendingRead !== null)
  ) {
    return;
  }
  void refreshRead();
}

function onFrameEvent(event: Event): void {
  const detail = (event as CustomEvent<HeatRiskFrameDetail>).detail;
  if (detail) applyFrameDetail(detail);
}

function selectDay(day: number): void {
  window.dispatchEvent(
    new CustomEvent(DAY_SELECT_EVENT, { detail: { day } })
  );
}

function onHostClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>(
    'button[data-heatrisk-sequence-day]'
  );
  if (!button) return;
  const day = Number(button.dataset['heatriskSequenceDay']);
  if (Number.isSafeInteger(day) && day > 0) selectDay(day);
}

function onHostKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    !(target instanceof HTMLButtonElement) ||
    !target.matches('[data-heatrisk-sequence-day]')
  ) {
    return;
  }
  const buttons = Array.from(
    host?.querySelectorAll<HTMLButtonElement>(
      'button[data-heatrisk-sequence-day]'
    ) ?? []
  );
  const index = buttons.indexOf(target);
  if (index < 0) return;
  let next = index;
  if (event.key === 'ArrowRight') next = Math.min(buttons.length - 1, index + 1);
  else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else return;
  event.preventDefault();
  const button = buttons[next];
  if (!button) return;
  button.focus();
  const day = Number(button.dataset['heatriskSequenceDay']);
  if (Number.isSafeInteger(day) && day > 0) selectDay(day);
}

/**
 * Mount once inside the map dock. Later calls apply the newest frame snapshot.
 */
export function mountHeatRiskSequence(initial: HeatRiskFrameDetail): void {
  if (!mounted) {
    const dock = document.getElementById('map-bottom-dock');
    const foot = dock?.querySelector('.map-dock-foot') ?? null;
    if (!dock || !foot) {
      // DDM-P7-T05 F9: index.html always ships the dock, so this should
      // never fire in production; if it ever does, this module's mirror of
      // the layer's activation never updates (activationOpen stays false),
      // so identifyHeatRiskForBriefing answers the briefing from the
      // independent-catalog fallback while the map may be displaying a
      // different day.
      console.warn(
        '[heatrisk-sequence] map dock not found; the HeatRisk sequence will not mount and the briefing claim will read the catalog fallback instead of the displayed frame.'
      );
      return;
    }
    host = document.createElement('section');
    host.id = 'heatrisk-sequence';
    host.className = 'heatrisk-sequence';
    host.hidden = true;
    dock.insertBefore(host, foot);
    host.addEventListener('click', onHostClick);
    host.addEventListener('keydown', onHostKeyDown);
    window.addEventListener(FRAMES_EVENT, onFrameEvent);
    selection = getPlaceSelection();
    onPlaceSelectionChange((next) => {
      selection = next;
      cachedRead = null;
      fallbackCache = null;
      void refreshRead();
    });
    mounted = true;
  }
  applyFrameDetail(initial);
}

/**
 * Identify the active displayed frame for a briefing. A completed seven-day
 * read is reused, so opening the briefing does not duplicate its request.
 */
export async function identifySelectedHeatRisk(
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<HeatRiskIdentify | null> {
  const frame = await waitForSelectedFrame(signal);
  const generation = activationGeneration;
  if (
    !frame ||
    !activationOpen ||
    frameStatus === 'inactive'
  ) {
    return null;
  }
  const key = readKey(frames, lng, lat, generation);
  let read = cachedRead?.key === key ? cachedRead : null;
  if (!read && pendingRead?.key === key) {
    read = await pendingRead.promise;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (
      !activationOpen ||
      activationGeneration !== generation
    ) {
      return null;
    }
  }
  let value: HeatRiskValue | null;
  let retrievedAt: number;
  if (read) {
    const index = read.frames.findIndex(
      (candidate) => candidate.validTime === frame.validTime
    );
    if (index < 0) throw new Error('selected HeatRisk frame left the sequence');
    value = read.values[index] ?? null;
    retrievedAt = read.retrievedAt;
  } else {
    value = await fetchFrameValue(frame, lng, lat, signal);
    retrievedAt = Date.now();
  }
  if (
    !activationOpen ||
    activationGeneration !== generation
  ) {
    return null;
  }
  return {
    frame,
    value,
    retrievedAt,
    validThrough: frame.validTime + VALID_PERIOD_MS,
    frameSource: 'selected'
  };
}

/**
 * The outcome of {@link identifyHeatRiskForBriefing} (DDM-P7-T05 F3): a
 * discriminated result rather than a bare `null`, so `src/impact/sources.ts`
 * can tell apart the three different nulls the old signature collapsed into
 * one honest-sounding note:
 *
 *   identified          a value was read, from the displayed frame or the
 *                       catalog fallback; carries it
 *   no-displayed-frame  the layer is on (`activationOpen`) but has no
 *                       displayed frame to read (still loading past the
 *                       wait, errored, or empty); the map itself already
 *                       ran its own integrity gate and came up with nothing
 *                       to show, so the briefing reports the same
 *                       unavailable result the map does, quietly
 *   catalog-failed      the independent catalog read itself failed (no
 *                       usable time extent, or no consistent seven-granule
 *                       cadence); the one case that earns the briefing's
 *                       own "did not respond" note
 *   superseded          the read was aborted, or a reactivation or a new
 *                       place selection overtook it before it finished; the
 *                       fresher read (the layer's own, or a later call to
 *                       this function) answers instead, so this one reports
 *                       nothing
 */
export type HeatRiskBriefingRead =
  | { readonly kind: 'identified'; readonly identify: HeatRiskIdentify }
  | { readonly kind: 'no-displayed-frame' }
  | { readonly kind: 'catalog-failed' }
  | { readonly kind: 'superseded' };

/**
 * Identify HeatRisk at a point for the near-term heat claim in the briefing,
 * independent of whether the HeatRisk map layer is on (DR-014 a: the
 * briefing describes the place, not the map, so it does not vanish when the
 * map layer is off). When the layer is on and showing a frame, that frame is
 * read, so the briefing matches what the map displays. Otherwise (the layer
 * is off, still enumerating its catalog, or errored) this fetches the
 * catalog's own earliest advertised granule directly, with the same abort
 * signal and the same per-request catalog-time verification `fetchFrameValue`
 * always performs.
 *
 * Three guards correct a RACE the plain fallback used to run (a toggle off
 * then quickly on cost an extra /identify the old code never made):
 * memoization (a result already read for this point and this catalog extent,
 * within {@link FALLBACK_CACHE_TTL_MS}, is returned without a new
 * /identify), a settle wait after a genuine deactivation (the layer's own
 * reactivation, if it comes within `DEACTIVATION_SETTLE_MS`, is let win, and
 * this reports `superseded` without fetching), and an abort/reactivation
 * check after every await (a reactivated layer's own selected-frame path,
 * not this fallback, answers the claim, and a stale fallback result is
 * never cached over a fresher one).
 */
export async function identifyHeatRiskForBriefing(
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<HeatRiskBriefingRead> {
  const selected = await identifySelectedHeatRisk(lng, lat, signal);
  if (selected) return { kind: 'identified', identify: selected };
  if (signal.aborted) return { kind: 'superseded' };
  // Fall back to the catalog's own earliest granule only when the layer is
  // truly inactive (off, or never turned on). A displayed layer that is
  // loading, degraded, errored, or reports no data already ran the map's own
  // seven-frame catalog integrity check (heatrisk.ts `extractFrames`) and
  // came up with nothing honest to show; this briefing must not invent an
  // independent read the map itself would not stand behind, so it reports
  // the same unavailable result the map does instead.
  if (activationOpen) return { kind: 'no-displayed-frame' };

  const generation = activationGeneration;
  const stillCurrent = (): boolean =>
    !activationOpen && activationGeneration === generation;

  // A layer that was never active needs no wait, so the briefing opens with
  // the claim promptly; a layer that just went inactive gets its
  // reactivation window before this pays for a request of its own.
  await waitForDeactivationSettle(signal);
  if (signal.aborted) return { kind: 'superseded' };
  if (!stillCurrent()) return { kind: 'superseded' };

  const extent = await fetchCatalogExtent(signal);
  if (signal.aborted) return { kind: 'superseded' };
  if (extent === null) {
    // Mirrors heatrisk.ts:612-614's own refusal of the same shape of
    // failure (kept as a duplicated, not shared, parser: see the module
    // doc above `buildMetadataUrl`; a change to either copy's gate must be
    // made to both).
    console.warn('[heatrisk-sequence] service metadata carried no usable time extent.');
    return { kind: 'catalog-failed' };
  }
  if (!stillCurrent()) return { kind: 'superseded' };

  const cached = fallbackCache;
  if (
    cached &&
    cached.lng === lng &&
    cached.lat === lat &&
    cached.extentStart === extent[0] &&
    cached.extentEnd === extent[1] &&
    Date.now() - cached.identify.retrievedAt < FALLBACK_CACHE_TTL_MS
  ) {
    return { kind: 'identified', identify: cached.identify };
  }

  const frame = await fetchTodayFrame(extent, signal);
  if (signal.aborted) return { kind: 'superseded' };
  if (frame === null) {
    // Mirrors heatrisk.ts:626-628's own refusal of the same shape of
    // failure (see the note on the extent check above: kept in sync by
    // hand, not by sharing code, because heatrisk.ts is the map's own
    // chunk).
    console.warn('[heatrisk-sequence] catalog carried no consistent granule times.');
    return { kind: 'catalog-failed' };
  }
  if (!stillCurrent()) return { kind: 'superseded' };
  const value = await fetchFrameValue(frame, lng, lat, signal);
  if (signal.aborted) return { kind: 'superseded' };
  if (!stillCurrent()) return { kind: 'superseded' };

  const identify: HeatRiskIdentify = {
    frame,
    value,
    retrievedAt: Date.now(),
    validThrough: frame.validTime + VALID_PERIOD_MS,
    frameSource: 'catalog'
  };
  fallbackCache = {
    lng,
    lat,
    extentStart: extent[0],
    extentEnd: extent[1],
    identify
  };
  return { kind: 'identified', identify };
}
