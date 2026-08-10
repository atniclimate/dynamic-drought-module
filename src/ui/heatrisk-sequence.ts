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
    activationGeneration += 1;
    activationOpen = false;
    clearActivationRead();
  } else if (!activationOpen || freshLoading) {
    activationGeneration += 1;
    activationOpen = true;
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
    if (!dock || !foot) return;
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
    validThrough: frame.validTime + VALID_PERIOD_MS
  };
}
