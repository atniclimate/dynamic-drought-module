/**
 * The ENSO flowing paths' lazy chunk root (ENSO-FLOW-PLAN section 3, block
 * E2 unit E2-1). src/layers/enso-flow.ts reaches every flow module through
 * one dynamic `import()` of this file, so nothing here enters the eager
 * closure or the sst-anomaly chunk.
 *
 * It exports the NODD reader and one view controller, `mountFlowView`, that
 * puts a decoded FlowField on the map and keeps it honest:
 * - the moving form: the WebGL2 ribbon custom layer `flow-paths`, driven by
 *   the 30 Hz motion loop (Pause, reduced motion, a hidden tab, the map off
 *   screen, SST playback and a lost context each stop it);
 * - the still form and the past-grid node arrows: the native layers
 *   `flow-still-casing`, `flow-still` and `flow-still-marks` on the
 *   `flow-still` GeoJSON source, rebuilt 150 ms after a moveend or resize;
 * - the coverage of the view (covered, partial, masked or outside the
 *   field's grid), so a masked view never reads as calm and a view outside
 *   the wave crop never reads as land;
 * - the frame's 24-hour limit: past cycle + 24 h nothing draws.
 *
 * The view never chooses words: it reports a FlowViewState and the panel
 * module composes the sentences (src/layers/enso-flow-data.ts FLOW_WORDS).
 * `halt()` is the off-intent half (it stops the loop and every repaint and
 * touches no map layer); `dispose()` removes the layers and the source.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { reassertThematicOrder } from '../../map/layer-order';
import { type FlowDensity, type ViewQuad, PHONE_MAX_WIDTH_PX, planForm } from './advect';
import { type FlowField, MERCATOR_MAX_LAT, isStale, latOf, lonOf, mercY } from './field';
import type { FlowInkName } from './ink';
import { type MotionHold, type MotionLoop, type MotionState, createMotionLoop, listenMotionRequests } from './motion-loop';
import { FlowRibbonLayer, viewQuadOf } from './ribbon-layer';
import { STILL_LAYER_IDS, STILL_SOURCE_ID, buildStillForm, nodeArrows, stillLayers } from './still';

export { readFlowFrame, FlowUnavailableError, candidateCycle, forecastHourFor, MAX_CYCLE_TRIES } from './nodd';
export { isStale } from './field';
export type { FlowField, FlowKind } from './field';
export type { MotionHold, MotionState } from './motion-loop';

/** The moving form's custom layer id (src/map/layer-order.ts seats it). */
export const FLOW_PATHS_ID = 'flow-paths';
/** Every map layer id the view adds, bottom to top. */
export const FLOW_LAYER_IDS: readonly string[] = [
  STILL_LAYER_IDS.casing, STILL_LAYER_IDS.paths, STILL_LAYER_IDS.marks, FLOW_PATHS_ID
];
/** The still-form rebuild debounce after moveend and resize (moving-paths section 14). */
export const REBUILD_DEBOUNCE_MS = 150;

/**
 * How the field meets the view.
 * - covered: valid nodes in view and the view inside the grid.
 * - partial: valid nodes in view, and part of the view outside the grid (the wave crop).
 * - masked: the view inside the grid and every node in it masked (an all-land wave view).
 * - outside: no valid node in view and part or all of the view outside the grid.
 */
export type FlowCoverage = 'covered' | 'partial' | 'masked' | 'outside';
export type FlowDrawnForm = 'moving' | 'still' | 'arrows' | 'none';

export interface FlowViewState {
  readonly form: FlowDrawnForm;
  /** The snapshot's `motion`: 'none' wherever the lines cannot move (no lines, node arrows, no WebGL2). */
  readonly motion: MotionState;
  readonly hold: MotionHold | null;
  readonly coverage: FlowCoverage;
  /** Past cycle + 24 h: nothing draws and the panel reads unavailable. */
  readonly stale: boolean;
  /** Features in the still source (still paths, crest marks or node arrows). */
  readonly features: number;
  /** The moving form's rebuild after a context restore threw: only the still form draws from then on. */
  readonly rebuildFailed: boolean;
  /**
   * Past the grid ('arrows'): whether any model node lies inside the view.
   * When none does, nothing is drawn (no arrow off screen, and no value at a
   * point that is not a model point) and the panel says so. True in every
   * other form.
   */
  readonly nodesInView: boolean;
}

export interface FlowViewOptions {
  readonly ink: FlowInkName;
  readonly onState: (state: FlowViewState) => void;
  /** Each MapLibre `render` while the view is mounted: the running count and the ribbon's advection steps so far. */
  readonly onRender?: (count: number, steps: number) => void;
  /** Epoch ms; defaults to Date.now. */
  readonly now?: () => number;
  readonly density?: FlowDensity;
}

export interface FlowView {
  readonly state: FlowViewState;
  readonly field: FlowField;
  setInk(ink: FlowInkName): void;
  /** Off intent: stop the loop and every repaint now; no map layer is touched. */
  halt(): void;
  /** Teardown: halt, then remove the layers and the source. */
  dispose(): void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The coverage of `view` by `field`: every grid node inside the view's
 * longitude and latitude box is visited once (at most the grid's own node
 * count), and the box is compared with the grid's extent.
 */
export function viewCoverage(field: FlowField, view: ViewQuad): FlowCoverage {
  const g = field.grid;
  const c = view.c;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    minX = Math.min(minX, c[i * 2] as number);
    maxX = Math.max(maxX, c[i * 2] as number);
    minY = Math.min(minY, c[i * 2 + 1] as number);
    maxY = Math.max(maxY, c[i * 2 + 1] as number);
  }
  const lonMin = lonOf(minX);
  const lonMax = lonOf(maxX);
  const latMax = latOf(minY);
  const latMin = latOf(maxY);
  // Only a grid that does not wrap in longitude (the wave crop) has an
  // outside; a global grid covers every view MapLibre's Mercator can show.
  let outside = false;
  if (!g.wrapsLon) {
    const gridLatMin = g.lat0 - (g.ny - 1) * g.dlat;
    // Longitudes are measured east of the box's west edge, across 180 when it crosses it.
    const west = (((lonMin - g.lon0) % 360) + 360) % 360;
    outside = latMax > g.lat0 + 1e-9 || latMin < gridLatMin - 1e-9 ||
      lonMax - lonMin >= 360 || west + (lonMax - lonMin) > (g.nx - 1) * g.dlon + 1e-9;
  }
  // The nodes are counted on the view's box widened by one cell, so a view
  // zoomed in between nodes reads the nodes of the cells it shows: inside a
  // valid grid it is covered, and the past-grid arrows draw at those nodes.
  const rowFirst = Math.max(0, Math.floor((g.lat0 - latMax) / g.dlat + 1e-9) - 1);
  const rowLast = Math.min(g.ny - 1, Math.ceil((g.lat0 - latMin) / g.dlat - 1e-9) + 1);
  const kFirst = Math.floor((lonMin - g.lon0) / g.dlon + 1e-9) - 1;
  const kLast = Math.min(Math.ceil((lonMax - g.lon0) / g.dlon - 1e-9) + 1, kFirst + Math.round(360 / g.dlon) - 1);
  const perWorld = Math.round(360 / g.dlon);
  let inGrid = 0;
  for (let row = rowFirst; row <= rowLast; row++) {
    for (let k = kFirst; k <= kLast; k++) {
      const column = g.wrapsLon ? ((k % g.nx) + g.nx) % g.nx : ((k % perWorld) + perWorld) % perWorld;
      if (column > g.nx - 1) continue;
      inGrid++;
      if (field.mask[row * g.nx + column] === 1) return outside ? 'partial' : 'covered';
    }
  }
  // No valid node: a view that leaves the crop is outside it (even if the part
  // inside is land); a view inside the grid is masked, never calm.
  return outside || inGrid === 0 ? (g.wrapsLon ? 'masked' : 'outside') : 'masked';
}

/**
 * The view's quad widened by one grid cell on every side (unrotated box),
 * so the past-grid arrows include the nodes of the cells the view shows
 * even when no node falls inside it.
 */
function widenedQuad(field: FlowField, view: ViewQuad): ViewQuad {
  const c = view.c;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    minX = Math.min(minX, c[i * 2] as number);
    maxX = Math.max(maxX, c[i * 2] as number);
    minY = Math.min(minY, c[i * 2 + 1] as number);
    maxY = Math.max(maxY, c[i * 2 + 1] as number);
  }
  const dx = field.grid.dlon / 360;
  const north = mercY(Math.min(MERCATOR_MAX_LAT, latOf(minY) + field.grid.dlat));
  const south = mercY(Math.max(-MERCATOR_MAX_LAT, latOf(maxY) - field.grid.dlat));
  const x0 = minX - dx;
  const x1 = maxX + dx;
  return { ...view, c: Float64Array.from([x0, north, x1, north, x1, south, x0, south]) };
}

/** Put `field` on `map` in the form the view and the motion state allow. */
export function mountFlowView(map: MlMap, field: FlowField, options: FlowViewOptions): FlowView {
  const now = options.now ?? Date.now;
  let halted = false;
  let renders = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let failureTimer: ReturnType<typeof setTimeout> | null = null;
  let density = Number.NaN;
  let rebuildFailed = false;
  let moving = false;
  let ready = false;
  let ink = options.ink;
  let state: FlowViewState = {
    form: 'none', motion: 'none', hold: null, coverage: 'covered', stale: false, features: 0, rebuildFailed: false,
    nodesInView: true
  };

  /** The still source and its three layers, added wherever the style lacks them. */
  const attachStill = (): void => {
    if (!map.getSource(STILL_SOURCE_ID)) map.addSource(STILL_SOURCE_ID, { type: 'geojson', data: EMPTY });
    for (const layer of stillLayers(ink)) if (!map.getLayer(layer.id)) map.addLayer(layer);
  };
  /** Add the ribbon layer; its onAdd builds the programs from CPU state. False if that throws. */
  const attachRibbon = (layer: FlowRibbonLayer): boolean => {
    try {
      map.addLayer(layer);
      return map.getLayer(FLOW_PATHS_ID) !== undefined;
    } catch {
      if (map.getLayer(FLOW_PATHS_ID)) map.removeLayer(FLOW_PATHS_ID);
      else layer.detach(map);
      return false;
    }
  };
  /** Remove every layer and the source this view added, whatever is left of them. */
  const removeAll = (): void => {
    for (const id of [...FLOW_LAYER_IDS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(STILL_SOURCE_ID)) map.removeSource(STILL_SOURCE_ID);
  };

  // The moving form needs WebGL2 and its programs. If they fail here, at the
  // first mount, the still form stands alone and says why, as after a failed
  // rebuild (review lead 7).
  let ribbon: FlowRibbonLayer | null = new FlowRibbonLayer({
    id: FLOW_PATHS_ID, field, ink,
    // A rebuild inside MapLibre's render that throws (moving-paths section 14).
    onRebuildFailed: () => failMoving()
  });

  /**
   * The motion loop exists only while the moving form could draw in this
   * view (review lead 2): node arrows, an empty view, a stale frame or a
   * failed ribbon run no loop and request no frame. While it exists it asks
   * MapLibre for a repaint only when the moving form draws, so 'idle' is
   * never starved by a still view.
   */
  let loop: MotionLoop | null = null;
  let stopRequests: () => void = () => undefined;
  const loopMap = {
    triggerRepaint: (): void => { if (moving && !halted) map.triggerRepaint(); },
    getCanvas: (): HTMLCanvasElement => map.getCanvas(),
    getContainer: (): HTMLElement => map.getContainer()
  };
  const startLoop = (): MotionLoop => {
    if (loop) return loop;
    const wasReady = ready;
    ready = false; // its first onChange must not re-enter update()
    loop = createMotionLoop({
      map: loopMap,
      stillByDefault: map.getCanvas().clientWidth <= PHONE_MAX_WIDTH_PX,
      onChange: () => { if (ready) update(); },
      onFrame: () => { if (isStale(field, now())) update(); }
    });
    stopRequests = listenMotionRequests(loop);
    ready = wasReady;
    return loop;
  };
  const stopLoop = (): void => {
    if (!loop) return;
    const wasReady = ready;
    ready = false;
    loop.dispose();
    stopRequests();
    stopRequests = () => undefined;
    loop = null;
    ready = wasReady;
  };

  /**
   * The moving form cannot come back (its programs failed to build on a
   * restored context): from here on only the still form draws, the loop and
   * the Pause requests stop for good, and the state says so. Deferred, since
   * it can be called from inside MapLibre's render.
   */
  function failMoving(): void {
    rebuildFailed = true;
    moving = false;
    if (halted || failureTimer !== null) return;
    failureTimer = setTimeout(() => {
      failureTimer = null;
      if (halted) return;
      if (map.getLayer(FLOW_PATHS_ID)) map.removeLayer(FLOW_PATHS_ID);
      update();
    }, 0);
  }

  function publish(next: FlowViewState): void {
    const same = next.form === state.form && next.motion === state.motion && next.hold === state.hold &&
      next.coverage === state.coverage && next.stale === state.stale && next.features === state.features &&
      next.rebuildFailed === state.rebuildFailed && next.nodesInView === state.nodesInView;
    state = next;
    if (!same) options.onState(next);
  }

  function update(): void {
    if (halted) return;
    const source = map.getSource(STILL_SOURCE_ID) as GeoJSONSource | undefined;
    if (isStale(field, now())) {
      moving = false;
      ribbon?.setRunning(false);
      stopLoop();
      source?.setData(EMPTY);
      publish({
        form: 'none', motion: 'none', hold: null, coverage: state.coverage, stale: true, features: 0, rebuildFailed,
        nodesInView: true
      });
      return;
    }
    const view = viewQuadOf(map);
    const coverage = viewCoverage(field, view);
    const canAnimate = ribbon !== null && !rebuildFailed;
    let form: FlowDrawnForm = 'none';
    let data: GeoJSON.FeatureCollection = EMPTY;
    let activeLoop: MotionLoop | null = null;
    let nodesInView = true;
    if (coverage === 'covered' || coverage === 'partial') {
      // Where could the lines move in this view at all (past-grid arrows and the phone rule aside)?
      const reach = planForm(field, view, { motionAllowed: canAnimate, playPressed: true, density: options.density ?? 'standard' });
      if (reach.form === 'moving') activeLoop = startLoop();
      else stopLoop();
      form = activeLoop && activeLoop.motion === 'moving' ? 'moving' : reach.form === 'arrows' ? 'arrows' : 'still';
      if (reach.densityFactor !== density) {
        density = reach.densityFactor;
        ribbon?.setDensity(density);
      }
      if (form === 'arrows') {
        // Past the grid an arrow sits only on a model node. When a node lies
        // inside the view, the nodes of the cells in view draw, up to one cell
        // beyond its edges, so an arrow straddling an edge still shows. When
        // none does, nothing is drawn (an arrow off screen helps no one, and
        // an arrow at the view centre would be a value at a point that is not
        // a model point, Q16), and the panel says so.
        nodesInView = nodeArrows(field, view).length > 0;
        if (nodesInView) data = buildStillForm(field, widenedQuad(field, view), 'arrows');
      } else if (form === 'still') data = buildStillForm(field, view, 'still', { densityFactor: reach.densityFactor });
    } else {
      stopLoop();
    }
    moving = form === 'moving';
    ribbon?.setRunning(moving);
    source?.setData(data);
    if (moving) map.triggerRepaint();
    publish({
      form,
      motion: activeLoop ? activeLoop.motion : 'none',
      hold: activeLoop ? activeLoop.hold : null,
      coverage,
      stale: false,
      features: data.features.length,
      rebuildFailed,
      nodesInView
    });
  }

  const scheduleRebuild = (): void => {
    if (halted) return;
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { rebuildTimer = null; update(); }, REBUILD_DEBOUNCE_MS);
  };
  const onRender = (): void => {
    renders++;
    options.onRender?.(renders, ribbon?.stats.steps ?? 0);
  };
  /**
   * MapLibre 6.6 drops its whole style on a lost context and, on restore,
   * sets the style back from its serialized form: the native still layers
   * come back, the custom ribbon layer does not ("cannot be restored after
   * WebGL context loss"). Once the restored style has loaded, the still
   * layers are made whole and the same ribbon (its CPU field and particles
   * intact) is added again, rebuilding its programs: nothing is read again.
   * If that rebuild throws, the still form stands alone.
   */
  const reattach = (): void => {
    if (halted) return;
    try {
      attachStill();
    } catch {
      // The restored style is not done loading; its 'style.load' calls this again.
      return;
    }
    if (ribbon && !rebuildFailed && !map.getLayer(FLOW_PATHS_ID) && !attachRibbon(ribbon)) failMoving();
    reassertThematicOrder(map);
    update();
  };
  const onRestored = (): void => {
    if (halted) return;
    map.off('style.load', reattach);
    map.once('style.load', reattach);
    reattach();
  };

  function halt(): void {
    if (halted) return;
    halted = true;
    moving = false;
    ribbon?.setRunning(false);
    stopLoop();
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    if (staleTimer !== null) clearTimeout(staleTimer);
    if (failureTimer !== null) clearTimeout(failureTimer);
    rebuildTimer = staleTimer = failureTimer = null;
    map.off('moveend', scheduleRebuild);
    map.off('resize', scheduleRebuild);
    map.off('render', onRender);
    map.off('webglcontextrestored', onRestored);
    map.off('style.load', reattach);
  }

  /**
   * Teardown: halt, remove the layers and the source, and let go of the
   * ribbon. While the ribbon is out of the style (a lost context, or before
   * the reattach) MapLibre never calls its onRemove, so it is detached by
   * hand and no canvas listener keeps the field alive (review lead 1).
   */
  function dispose(): void {
    halt();
    const inStyle = map.getLayer(FLOW_PATHS_ID) !== undefined;
    removeAll();
    if (ribbon && !inStyle) ribbon.detach(map);
    ribbon = null;
  }

  // A mount that throws part way takes back everything it added and rethrows,
  // so the panel's "did not load" leaves nothing on the map (review lead 5).
  try {
    attachStill();
    if (!attachRibbon(ribbon)) {
      ribbon = null;
      rebuildFailed = true;
    }
    reassertThematicOrder(map);
    map.on('moveend', scheduleRebuild);
    map.on('resize', scheduleRebuild);
    map.on('render', onRender);
    map.on('webglcontextrestored', onRestored);
    // The frame's 24-hour limit falls due on its own, without a pan.
    if (field.meta.staleAfter !== null) {
      const due = field.meta.staleAfter - now() + 1;
      if (due > 0 && due < 2 ** 31 - 1) staleTimer = setTimeout(update, due);
    }
    ready = true;
    update();
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    get state() { return state; },
    field,
    setInk(next: FlowInkName) {
      ink = next;
      ribbon?.setInk(next);
      for (const layer of stillLayers(next)) {
        if (!map.getLayer(layer.id) || layer.type !== 'line') continue;
        map.setPaintProperty(layer.id, 'line-color', layer.paint?.['line-color']);
      }
      if (moving) map.triggerRepaint();
    },
    halt,
    dispose
  };
}
