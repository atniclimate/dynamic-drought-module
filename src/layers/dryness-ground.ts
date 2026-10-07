import type { AddProtocolAction, Map as MapLibreMap } from 'maplibre-gl';
import { readDrynessTile, type DrynessTileLimits } from './dryness-grey-protocol';
import { readRelativeGreennessTimes, isRelativeGreennessServiceException, type DrynessMetadataLimits } from './dryness-discovery';

export interface DrynessFrame {
  readonly productKey: 'star-vhi' | 'usgs-relative-greenness';
  readonly frame: string;
  readonly issuer: string;
  readonly legendRows: readonly string[];
  readonly clockLabel: string;
  readonly coverage: string;
  readonly qualification: string;
  readonly creditKey: string;
  readonly tileUrl: (z: number, x: number, y: number) => string;
  readonly tileSize: number;
  readonly maxZoom: number;
  readonly bounds: readonly [number, number, number, number];
}
export interface DrynessFailure {
  readonly productKey: DrynessFrame['productKey'];
  readonly frame: string | null;
  readonly reason: 'source-failed' | 'service-exception' | 'deadline';
}
export interface DrynessSnapshot {
  readonly state: 'loading' | 'live' | 'live (partial)' | 'unavailable' | 'no data' | 'zoom in to load';
  /** Exactly the record mounted in the current source, or null if none is mounted. */
  readonly selected: DrynessFrame | null;
  readonly attempted: DrynessFrame | null;
  readonly sourceId: string | null;
  readonly failures: readonly DrynessFailure[];
}
export interface DrynessGroundOptions {
  readonly protocolName: string;
  readonly layerId: string;
  readonly beforeId: string;
  readonly allowedOrigins: readonly string[];
  readonly star: readonly [DrynessFrame, DrynessFrame];
  readonly rg: { readonly capabilitiesUrl: string; readonly layerName: string; readonly frame: (time: string) => DrynessFrame };
  readonly tileLimits: DrynessTileLimits;
  readonly metadataLimits: DrynessMetadataLimits;
  readonly selectionDeadlineMs: number;
  readonly publish: (snapshot: DrynessSnapshot | null) => void;
  /** View/coverage classification supplied by the eventual owner, never guessed from a probe. */
  readonly readyState: (frame: DrynessFrame, map: MapLibreMap) => 'live' | 'live (partial)' | 'no data' | 'zoom in to load';
}

/** Dormant factory. Caller owns protocol registration; no application/global registration occurs here. */
export function createDrynessGround(options: DrynessGroundOptions): {
  protocol: AddProtocolAction;
  activate(map: MapLibreMap, owner: AbortSignal): Promise<void>;
  deactivate(): void;
} {
  if (!/^[a-z][a-z0-9-]*$/.test(options.protocolName) || !options.layerId || !options.beforeId ||
      !Number.isSafeInteger(options.selectionDeadlineMs) || options.selectionDeadlineMs <= 0 ||
      options.selectionDeadlineMs > 2_147_483_647) throw new RangeError('Invalid dryness selection options');
  if (![options.tileLimits.timeoutMs, options.tileLimits.maxDecodedBytes, options.tileLimits.maxPixels,
    options.tileLimits.maxOutputBytes, options.metadataLimits.timeoutMs, options.metadataLimits.maxDecodedBytes,
    options.metadataLimits.maxTimes].every(n => Number.isSafeInteger(n) && n > 0) ||
    options.tileLimits.timeoutMs > 15_000 || options.metadataLimits.timeoutMs > 15_000) throw new RangeError('Invalid dryness reader limits');
  const permitted = new Set(options.allowedOrigins);
  const url = (value: string): string => {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        !permitted.has(parsed.origin)) throw new Error('Unadmitted dryness URL');
    return parsed.href;
  };
  const record = (input: DrynessFrame, productKey: DrynessFrame['productKey'], frame?: string): DrynessFrame => {
    const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (input.productKey !== productKey || !text(input.frame) || (frame !== undefined && input.frame !== frame) ||
        ![input.issuer, input.clockLabel, input.coverage, input.qualification, input.creditKey].every(text) ||
        !Array.isArray(input.legendRows) || input.legendRows.length === 0 || !input.legendRows.every(text) ||
        typeof input.tileUrl !== 'function' ||
        !Number.isSafeInteger(input.tileSize) || input.tileSize <= 0 || !Number.isSafeInteger(input.maxZoom) ||
        input.maxZoom < 5 || input.maxZoom > 30 || (productKey === 'star-vhi' && input.maxZoom > 7) ||
        input.bounds.length !== 4 || !input.bounds.every(Number.isFinite) ||
        input.bounds[0] < -180 || input.bounds[2] > 180 || input.bounds[1] < -90 || input.bounds[3] > 90 ||
        input.bounds[0] >= input.bounds[2] || input.bounds[1] >= input.bounds[3]) throw new Error('Invalid dryness frame');
    return Object.freeze({ ...input, legendRows: Object.freeze([...input.legendRows]), bounds: Object.freeze([...input.bounds]) as DrynessFrame['bounds'] });
  };
  const star = options.star.map(value => record(value, 'star-vhi'));
  const currentWeek = /^(\d{4})0(\d{2})$/.exec(star[0]!.frame);
  const year = Number(currentWeek?.[1]), week = Number(currentWeek?.[2]);
  if (!currentWeek || year < 1 || week < 1 || week > 52) throw new Error('Invalid STAR frame');
  // Saved issuer navigation uses 52/1, not ISO weeks or an inferred publication lag.
  const previous = week === 1 ? `${String(year - 1).padStart(4, '0')}052` : `${currentWeek[1]}0${String(week - 1).padStart(2, '0')}`;
  if (star[1]!.frame !== previous) throw new Error('Invalid STAR predecessor');
  url(options.rg.capabilitiesUrl);
  let generation = 0;
  type Session = {
    generation: number; map: MapLibreMap; owner: AbortSignal; controller: AbortController;
    frames: DrynessFrame[]; rgRead: boolean; index: number; busy: boolean;
    selected: DrynessFrame | null; attempted: DrynessFrame | null; sourceId: string | null;
    requests: Set<AbortController>;
    failures: DrynessFailure[]; timer: ReturnType<typeof setTimeout> | undefined; deadline: number;
    cancel: () => void; view: () => void; data: (event: { sourceId?: string }) => void;
    error: (event: { sourceId?: string; error?: unknown }) => void;
  };
  let active: Session | undefined;
  const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
  const current = (s: Session): boolean => active === s && !s.controller.signal.aborted;
  const emit = (s: Session, state: DrynessSnapshot['state']): void => {
    if (!current(s)) return;
    options.publish(Object.freeze({ state, selected: s.selected, attempted: s.attempted,
      sourceId: s.sourceId, failures: Object.freeze([...s.failures]) }));
  };
  const disarm = (s: Session): void => { if (s.timer !== undefined) clearTimeout(s.timer); s.timer = undefined; };
  const clear = (s: Session): void => {
    for (const controller of s.requests) controller.abort(abortError());
    s.requests.clear();
    // Each operation is independent because a removed map may reject cleanup.
    try { if (s.map.getLayer(options.layerId)) s.map.removeLayer(options.layerId); } catch { /* Removed map. */ }
    try { if (s.sourceId && s.map.getSource(s.sourceId)) s.map.removeSource(s.sourceId); } catch { /* Removed map. */ }
    s.selected = null; s.sourceId = null;
  };
  const stop = (s: Session): void => {
    if (active !== s) return;
    active = undefined; disarm(s); s.controller.abort(abortError());
    s.owner.removeEventListener('abort', s.cancel);
    try { s.map.off('sourcedata', s.data); s.map.off('error', s.error); s.map.off('moveend', s.view); } catch { /* Removed map. */ }
    clear(s); options.publish(null);
  };
  const expire = (s: Session): void => {
    if (!current(s)) return;
    if (s.attempted) s.failures.push({ productKey: s.attempted.productKey, frame: s.attempted.frame, reason: 'deadline' });
    clear(s); emit(s, 'unavailable');
    disarm(s); s.controller.abort(new DOMException('Dryness selection timed out', 'TimeoutError'));
  };
  const arm = (s: Session): void => {
    if (s.timer !== undefined) return;
    s.deadline = performance.now() + options.selectionDeadlineMs;
    s.timer = setTimeout(() => expire(s), options.selectionDeadlineMs);
  };
  const checkpoint = (s: Session): void => {
    if (!current(s)) throw abortError();
    if (s.timer !== undefined && performance.now() >= s.deadline) { expire(s); throw s.controller.signal.reason; }
  };
  const settle = <T>(s: Session, work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = (): void => { cleanup(); reject(s.controller.signal.reason); };
    const cleanup = (): void => s.controller.signal.removeEventListener('abort', cancel);
    s.controller.signal.addEventListener('abort', cancel, { once: true });
    if (s.controller.signal.aborted) cancel();
    void work.then(value => { cleanup(); try { checkpoint(s); resolve(value); } catch (error) { reject(error); } },
      error => { cleanup(); reject(error); });
  });
  const fail = (s: Session, error: unknown): void => {
    const frame = s.attempted;
    if (frame) s.failures.push({ productKey: frame.productKey, frame: frame.frame,
      reason: isRelativeGreennessServiceException(error) ? 'service-exception' : 'source-failed' });
    // Only the first RG ServiceException permits the one preceding exact TIME.
    if (frame?.productKey === 'usgs-relative-greenness' && (s.index !== 2 || !isRelativeGreennessServiceException(error))) {
      s.index = 4;
    } else s.index++;
  };
  const advance = async (s: Session, error?: unknown): Promise<void> => {
    if (!current(s) || s.busy) return;
    s.busy = true; arm(s);
    if (error !== undefined) fail(s, error);
    clear(s); emit(s, 'loading');
    try {
      while (current(s) && s.index < 4) {
        checkpoint(s);
        if (s.index === 2 && !s.rgRead) {
          s.rgRead = true;
          s.attempted = null;
          emit(s, 'loading');
          let times: readonly string[];
          try {
            times = await settle(s, readRelativeGreennessTimes(url(options.rg.capabilitiesUrl), options.rg.layerName,
              s.controller.signal, options.metadataLimits));
            checkpoint(s);
            const records = times.slice(0, 2).map(time => record(options.rg.frame(time), 'usgs-relative-greenness', time));
            s.frames.push(...records);
          } catch (failure) {
            checkpoint(s);
            s.attempted = null;
            s.failures.push({ productKey: 'usgs-relative-greenness', frame: null, reason: 'source-failed' });
            throw failure;
          }
        }
        const frame = s.frames[s.index];
        if (!frame) break;
        s.attempted = frame;
        try {
          await settle(s, readDrynessTile(url(frame.tileUrl(5, 5, 11)), frame.productKey === 'star-vhi' ? 'star-vhi' : 'relative-greenness',
            s.controller, options.tileLimits));
          checkpoint(s);
          s.sourceId = `${options.layerId}-${s.generation}-${s.index}`;
          s.map.addSource(s.sourceId, { type: 'raster', tiles: [`${options.protocolName}://${s.generation}/${s.index}/{z}/{x}/{y}`],
            tileSize: frame.tileSize, minzoom: 0, maxzoom: frame.maxZoom, bounds: [...frame.bounds] });
          // This narrow internal setting controls actual categorical request resolution.
          const source = s.map.getSource(s.sourceId);
          if (source) (source as typeof source & { roundZoom: boolean }).roundZoom = false;
          s.map.addLayer({ id: options.layerId, type: 'raster', source: s.sourceId,
            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, options.beforeId);
          s.selected = frame;
          emit(s, 'loading');
          s.busy = false;
          s.data({ sourceId: s.sourceId });
          return;
        } catch (failure) {
          checkpoint(s);
          clear(s); fail(s, failure);
        }
      }
      disarm(s); emit(s, 'unavailable');
    } catch {
      if (current(s)) { clear(s); disarm(s); emit(s, 'unavailable'); }
    } finally { s.busy = false; }
  };
  const protocol: AddProtocolAction = async (request, owner) => {
    const s = active;
    const parsed = new URL(request.url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!s || parsed.protocol !== `${options.protocolName}:` || parsed.hostname !== String(s.generation) ||
        parts.length !== 4 || parts[0] !== String(s.index) || !s.selected) throw abortError();
    const coordinates = parts.slice(1).map(Number);
    const [z, x, y] = coordinates as [number, number, number];
    if (!coordinates.every(Number.isSafeInteger) || z < 0 || z > s.selected.maxZoom || x < 0 || y < 0 ||
        x >= 2 ** z || y >= 2 ** z) throw new Error('Invalid dryness tile coordinate');
    const child = new AbortController();
    s.requests.add(child);
    const selected = s.selected;
    const index = s.index;
    const cancel = (): void => child.abort(abortError());
    owner.signal.addEventListener('abort', cancel, { once: true });
    s.controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (owner.signal.aborted || !current(s)) throw abortError();
      const frame = selected;
      const data = await readDrynessTile(url(frame.tileUrl(z, x, y)), frame.productKey === 'star-vhi' ? 'star-vhi' : 'relative-greenness', child, options.tileLimits);
      if (owner.signal.aborted || !current(s) || s.selected !== frame) throw abortError();
      return { data };
    } catch (error) {
      if (!owner.signal.aborted && current(s) && s.selected === selected && s.index === index) void advance(s, error);
      throw error;
    } finally {
      owner.signal.removeEventListener('abort', cancel); s.controller.signal.removeEventListener('abort', cancel); child.abort();
      s.requests.delete(child);
    }
  };
  return {
    protocol,
    async activate(map, owner) {
      if (owner.aborted) return;
      if (active) stop(active);
      const s: Session = { generation: ++generation, map, owner, controller: new AbortController(), frames: [...star], rgRead: false,
        index: 0, busy: false, selected: null, attempted: null, sourceId: null, failures: [], timer: undefined, deadline: 0,
        requests: new Set(),
        cancel: () => {}, view: () => {}, data: () => {}, error: () => {} };
      s.cancel = () => stop(s);
      s.data = event => {
        if (!current(s) || s.busy || !s.selected || event.sourceId !== s.sourceId) return;
        try {
          if (s.map.isSourceLoaded(s.sourceId!)) { disarm(s); emit(s, options.readyState(s.selected, s.map)); }
        } catch (error) { void advance(s, error); }
      };
      s.error = event => { if (current(s) && event.sourceId === s.sourceId) void advance(s, event.error ?? new Error('Dryness source failed')); };
      s.view = () => { if (s.sourceId) s.data({ sourceId: s.sourceId }); };
      active = s;
      owner.addEventListener('abort', s.cancel, { once: true });
      map.on('sourcedata', s.data); map.on('error', s.error); map.on('moveend', s.view);
      if (owner.aborted) { stop(s); return; }
      await advance(s);
    },
    deactivate() { if (active) stop(active); }
  };
}
