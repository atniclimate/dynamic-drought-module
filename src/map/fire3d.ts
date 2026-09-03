/**
 * Desktop 3D Fire mode orchestrator (W3 terrain + camera + sky, W4 smoke).
 *
 * One combined mode: 3D terrain over the bundled Pacific Northwest DEM
 * archive, a pitched camera, a dark-palette sky, and (after terrain
 * succeeds) the lazily imported volumetric smoke presentation. The mode is
 * governed by the fire3d preference store (URL `fire3d=true`) and applies
 * only behind its full activation gate; see `shouldFire3DBeActive`.
 *
 * Terrain source discipline: this module owns its OWN raster-dem source
 * ('fire3d-terrain-dem') and never reuses the hillshade layer's source, so
 * toggling either feature cannot tear the other down. It DOES reuse the
 * hillshade module's archive resolution (URL preference plus the PMTiles
 * header probe), so both features agree on which archive is trustworthy.
 *
 * Failure ladder (invariant: never a silent style error):
 *   1. Probe failure before any map mutation: nothing to roll back;
 *      preference demoted, toast, status 'unavailable'.
 *   2. Setup failure after mutations began: transactional rollback (terrain,
 *      sky, source, camera), preference demoted, toast, status 'unavailable'.
 *   3. Post-probe tile failures (watchRasterTiles): same rollback ladder.
 *   4. Volumetric smoke failure: NON-fatal partial degrade; terrain stays,
 *      the flat smoke veil stays visible.
 *   5. Perimeter ribbon failure (DR-064): NON-fatal partial degrade; the
 *      flat perimeter stays exactly as the 2D map draws it.
 *   6. Context-layer failure (fire3d-context.ts, the issuer-published
 *      landscape context): NON-fatal per layer; each missing context layer
 *      degrades alone and the scene keeps everything else.
 *
 * Meaning constraints carried through: perimeters remain mapped incident
 * representations draped over relief (render-to-texture), the reduced-motion
 * static #ff4c00 perimeter contract is untouched, and the camera treatment
 * claims nothing about fire behavior. The DR-064 ribbon raises the same
 * published edge into the third dimension without moving it, without
 * fetching anything the flat layer does not, and without touching the
 * perimeter layer's status.
 */

import type * as maplibregl from 'maplibre-gl';

import type { HazardClusterKey } from '../config/clusters';
import {
  FIRE3D_CAMERA_TRANSITION_MS,
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_MIN_HEIGHT_PX,
  FIRE3D_MIN_HEIGHT_QUERY,
  FIRE3D_MIN_WIDTH_QUERY,
  FIRE3D_NON_PREDICTION_NOTE,
  FIRE3D_PITCH_DEGREES,
  FIRE3D_SKY_CLEAR_SPECIFICATION,
  FIRE3D_SKY_SPECIFICATION,
  FIRE3D_TERRAIN_EXAGGERATION
} from '../config/fire3d-presentation';
import { resolveHillshadeArchiveUrl } from '../layers/hillshade';
import { watchContextLoss, webGl2Capability } from './gl-capability';
import {
  getCommittedSnapshot,
  onCommittedSnapshotChange
} from '../state/cluster-service';
import {
  getFire3DPreference,
  onFire3DPreferenceChange,
  setFire3DPreference
} from '../state/fire3d-store';
import { registry } from '../state/registry';
import { showToast } from '../ui/overlay';
import { prefersReducedMotion } from '../util/motion';
import { watchRasterTiles } from '../util/raster-status';
import type { RasterTileWatch } from '../util/raster-status';

/** Own terrain source; never the hillshade layer's 'hillshade-dem'. */
const TERRAIN_SOURCE_ID = 'fire3d-terrain-dem';

/** The fire event layers whose presence keeps an ACTIVE mode alive across
 * an honest 'custom' demotion (the IC refinement to the entry gate). */
export const FIRE3D_EVENT_LAYER_KEYS: readonly string[] = [
  'nifc-fires',
  'hms-smoke'
];

/** The perimeter layer the DR-064 ribbon re-presents (mirrored literal). */
const PERIMETER_LAYER_KEY = 'nifc-fires';

export interface Fire3DStatus {
  readonly state: 'inactive' | 'checking' | 'active' | 'unavailable';
  /** Honest user-facing reason; non-null only for 'unavailable'. */
  readonly reason: string | null;
  /** True while the volumetric smoke read is in place beside the terrain;
   * false while active with the flat veil only (partial degrade). */
  readonly smokeVolume: boolean;
  /** True while the DR-064 perimeter ribbon stands in the scene; false when
   * the perimeter layer is off, still loading, or holds no wildfire-class
   * record, in which case the flat perimeter reads on its own. */
  readonly perimeterRibbon: boolean;
  /** The context layers actually in the scene (issuer-published landscape
   * context; empty while inactive or when every context layer degraded). */
  readonly contextLayers: readonly string[];
}

export interface Fire3DGateInput {
  readonly preference: boolean;
  readonly desktopViewport: boolean;
  readonly committedCluster: HazardClusterKey | 'custom';
  readonly activeLayerKeys: ReadonlySet<string>;
  readonly currentlyActive: boolean;
  /**
   * DR-025a: the renderer capability probe's answer
   * (`probeWebGl2().webgl2`). Optional, and treated as capable when absent,
   * so a caller that has not measured the device is not silently told the
   * device failed. The runtime controller always supplies it.
   */
  readonly webgl2?: boolean;
  /**
   * Viewport height in CSS pixels. Optional, and treated as unconstrained
   * when absent, for the same reason. The runtime controller supplies
   * `window.innerHeight`.
   */
  readonly viewportHeight?: number;
}

/**
 * The full activation gate (pure, Node-testable). ENTRY requires the
 * committed cluster to BE 'wildfire'; once active, an honest demotion to
 * 'custom' (the user added a reference layer to the Fire view) keeps the
 * mode alive while a fire event layer remains in the active set, so one
 * extra layer never collapses the scene. Switching to another cluster,
 * removing every fire event layer, toggling the preference off, a narrow
 * viewport, a short viewport, or a device without WebGL 2 always exits.
 *
 * DR-025a made the entry test capability plus geometry rather than width
 * alone: a tablet in the 721 to 1024 px band is welcome, a landscape phone
 * is not (see FIRE3D_MIN_HEIGHT_PX for why height is the separator), and a
 * device that cannot give MapLibre a WebGL 2 context never enters a scene
 * that would render as an inert frame.
 */
export function shouldFire3DBeActive(input: Fire3DGateInput): boolean {
  if (!input.preference || !input.desktopViewport) return false;
  if (input.webgl2 === false) return false;
  if (
    input.viewportHeight !== undefined &&
    input.viewportHeight < FIRE3D_MIN_HEIGHT_PX
  ) {
    return false;
  }
  if (input.committedCluster === 'wildfire') return true;
  if (!input.currentlyActive || input.committedCluster !== 'custom') {
    return false;
  }
  return FIRE3D_EVENT_LAYER_KEYS.some((key) =>
    input.activeLayerKeys.has(key)
  );
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let status: Fire3DStatus = {
  state: 'inactive',
  reason: null,
  smokeVolume: false,
  perimeterRibbon: false,
  contextLayers: []
};
const statusListeners = new Set<() => void>();

let controllerWired = false;
let active = false;
let activation: AbortController | null = null;
/** Bumped on every activation start and every teardown so an awaited step
 * (the smoke-volume dynamic import) can detect it was superseded. */
let generation = 0;
let savedCamera: { readonly pitch: number; readonly bearing: number } | null =
  null;
let tileWatch: RasterTileWatch | null = null;
let smokeVolumeOn = false;
let smokeModule: typeof import('../layers/hms-smoke-volume') | null = null;
let ribbonOn = false;
let ribbonModule: typeof import('../layers/nifc-perimeter-ribbon') | null =
  null;
let contextModule: typeof import('./fire3d-context') | null = null;
let contextKeys: readonly string[] = [];
/** Truthful per-layer embed disclosure lines, composed at activation from
 * what actually rendered (never static claims). */
let contextEmbedLines: readonly string[] = [];
let contextAbort: AbortController | null = null;

/** The latest mode status. */
export function getFire3DStatus(): Fire3DStatus {
  return status;
}

/** Subscribe to status publishes. Returns an unsubscribe function. */
export function onFire3DStatusChange(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

/** The embed disclosure chip's element id (also asserted by tests). */
const EMBED_NOTE_ID = 'fire3d-embed-note';

/**
 * Embeds hide the sidebar chrome that carries the coverage note, the
 * non-prediction disclosure, and the context legends, while a URL-named
 * fire3d=true still drives the scene. The honesty surfaces therefore
 * travel with the map itself there: a persistent, non-interactive note
 * rendered while the mode is active (Edgeley et al. 2024: the disclosure
 * may never be documentation-only). No-op outside embed mode and in
 * non-DOM test environments.
 */
function syncEmbedNote(active: boolean): void {
  if (
    typeof document === 'undefined' ||
    typeof document.querySelector !== 'function'
  ) {
    return;
  }
  const shell = document.querySelector('.app-shell.embed');
  const existing = document.getElementById(EMBED_NOTE_ID);
  if (!active || !shell) {
    existing?.remove();
    return;
  }
  const lines = [
    FIRE3D_NON_PREDICTION_NOTE,
    FIRE3D_COVERAGE_NOTE,
    ...contextEmbedLines
  ].filter((line) => line.length > 0);
  const note = existing ?? document.createElement('p');
  note.id = EMBED_NOTE_ID;
  note.className = 'fire3d-embed-note';
  note.setAttribute('role', 'note');
  note.textContent = lines.join(' ');
  if (!existing) shell.appendChild(note);
}

function publishStatus(
  state: Fire3DStatus['state'],
  reason: string | null
): void {
  status = {
    state,
    reason,
    smokeVolume: state === 'active' && smokeVolumeOn,
    perimeterRibbon: state === 'active' && ribbonOn,
    contextLayers: state === 'active' ? contextKeys : []
  };
  // Production-observable truth stamp (the dev-only __ddmMap handle is
  // dead-code-eliminated from dist/, so the verification suite reads mode
  // state from here; the stamp is written from what the map actually
  // holds, not from intent).
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.ddmFire3d = state;
    if (state === 'active') {
      root.dataset.ddmFire3dSmoke = smokeVolumeOn ? 'volume' : 'flat';
      root.dataset.ddmFire3dRibbon = ribbonOn ? 'on' : 'off';
    } else {
      delete root.dataset.ddmFire3dSmoke;
      delete root.dataset.ddmFire3dRibbon;
    }
    if (state === 'active' && contextKeys.length > 0) {
      root.dataset.ddmFire3dContext = contextKeys.join(' ');
    } else {
      delete root.dataset.ddmFire3dContext;
    }
    syncEmbedNote(state === 'active');
  }
  statusListeners.forEach((fn) => {
    fn();
  });
}

function desktopViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(FIRE3D_MIN_WIDTH_QUERY).matches
  );
}

/**
 * The device's WebGL 2 answer (DR-025a), read from the one shared
 * measurement in `gl-capability.ts` that the boot path and the 3D control
 * also read, so the three can never disagree and no second GL context is
 * allocated for the question. The gate is re-evaluated on every preference,
 * cluster, registry, and viewport change; the answer cannot change for a
 * page. Actual context LOSS is a separate, watched event; it is not a
 * change to this capability.
 *
 * The same probe is the foundation for map-wide 3D terrain across all four
 * hazard views (the owner's DR-025 expansion). Nothing here builds that; it
 * is noted so the next reader adds the tier beside this, not a second probe.
 */
function hasWebGl2(): boolean {
  return webGl2Capability().webgl2;
}

/** The gate's viewport-height input, omitted where there is no window. */
function viewportHeightInput(): { readonly viewportHeight?: number } {
  if (typeof window !== 'undefined' && typeof window.innerHeight === 'number') {
    return { viewportHeight: window.innerHeight };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Scene transitions
// ---------------------------------------------------------------------------

function applyCamera(
  map: maplibregl.Map,
  target: { readonly pitch: number; readonly bearing?: number }
): void {
  if (prefersReducedMotion()) {
    map.jumpTo(target);
  } else {
    map.easeTo({ ...target, duration: FIRE3D_CAMERA_TRANSITION_MS });
  }
}

/** Remove everything the activation added, in reverse, then restore the
 * captured camera. Safe against partial setups (defensive guards). */
function rollbackScene(map: maplibregl.Map): void {
  generation += 1;
  active = false;
  if (tileWatch) {
    tileWatch.detach();
    tileWatch = null;
  }
  if (contextAbort) {
    contextAbort.abort();
    contextAbort = null;
  }
  if (contextModule) contextModule.deactivateContextLayers(map);
  contextKeys = [];
  contextEmbedLines = [];
  // The ribbon owns its own derived source, so its teardown cannot strand
  // the flat perimeter layer's; the guard is defensive only.
  if (ribbonModule) ribbonModule.deactivatePerimeterRibbon(map);
  ribbonOn = false;
  if (smokeVolumeOn && smokeModule) {
    smokeModule.deactivateSmokeVolume(map);
    if (!registry.getActiveKeys().has('hms-smoke')) {
      smokeModule.cleanupOrphanedSmokeSource(map);
    }
  }
  smokeVolumeOn = false;
  map.setTerrain(null);
  map.setSky(FIRE3D_SKY_CLEAR_SPECIFICATION);
  if (map.getSource(TERRAIN_SOURCE_ID)) map.removeSource(TERRAIN_SOURCE_ID);
  if (savedCamera) {
    applyCamera(map, savedCamera);
    savedCamera = null;
  }
}

/** The shared failure ladder: rollback, honest preference demotion (which
 * also drops `fire3d` from the URL), a toast, and an 'unavailable' emit. */
function failScene(map: maplibregl.Map, reason: string, err?: unknown): void {
  console.warn(`[fire3d] ${reason}`, err);
  rollbackScene(map);
  publishStatus('unavailable', reason);
  setFire3DPreference(false);
  showToast('3D Fire view unavailable; the flat map remains accurate.');
}

async function activateScene(map: maplibregl.Map): Promise<void> {
  if (active || activation !== null) return;
  const myController = new AbortController();
  activation = myController;
  const signal = myController.signal;
  const myGeneration = ++generation;
  publishStatus('checking', null);
  savedCamera = { pitch: map.getPitch(), bearing: map.getBearing() };

  let archiveUrl: string;
  try {
    archiveUrl = await resolveHillshadeArchiveUrl(signal);
  } catch (err) {
    if (activation === myController) activation = null;
    if (signal.aborted || myGeneration !== generation) {
      // Superseded or withdrawn: a newer activation (or the withdrawal
      // itself) owns the published status now.
      if (myGeneration === generation) {
        savedCamera = null;
        publishStatus('inactive', null);
      }
      return;
    }
    savedCamera = null;
    publishStatus(
      'unavailable',
      'The terrain archive is unreachable or invalid.'
    );
    setFire3DPreference(false);
    showToast('3D Fire view unavailable; the flat map remains accurate.');
    console.warn('[fire3d] terrain archive probe failed.', err);
    return;
  }
  if (activation === myController) activation = null;
  if (signal.aborted || myGeneration !== generation) {
    if (myGeneration === generation) {
      savedCamera = null;
      publishStatus('inactive', null);
    }
    return;
  }

  try {
    if (!map.getSource(TERRAIN_SOURCE_ID)) {
      map.addSource(TERRAIN_SOURCE_ID, {
        type: 'raster-dem',
        url: 'pmtiles://' + archiveUrl,
        encoding: 'terrarium',
        tileSize: 512
      });
    }
    map.setTerrain({
      source: TERRAIN_SOURCE_ID,
      exaggeration: FIRE3D_TERRAIN_EXAGGERATION
    });
    map.setSky(FIRE3D_SKY_SPECIFICATION);
    applyCamera(map, { pitch: FIRE3D_PITCH_DEGREES });
  } catch (err) {
    failScene(map, 'Terrain setup failed.', err);
    return;
  }

  active = true;
  // Post-probe honesty: a truncated archive or ranged-read failure surfaces
  // as tile errors after a clean header probe; degrade transactionally
  // instead of leaving a silently flat or torn scene.
  tileWatch = watchRasterTiles(map, TERRAIN_SOURCE_ID, (state) => {
    if (state !== 'error') return;
    failScene(map, 'Terrain tiles failed to load.');
  });

  // W4: the volumetric smoke rides its own lazy chunk and is non-fatal by
  // contract; terrain stays and the flat veil stays visible on any failure.
  try {
    smokeModule = smokeModule ?? (await import('../layers/hms-smoke-volume'));
  } catch (err) {
    smokeModule = null;
    console.warn(
      '[fire3d] the smoke volume chunk failed to load; flat smoke stays.',
      err
    );
  }
  if (myGeneration !== generation || !active) return;
  if (smokeModule) {
    try {
      smokeVolumeOn = smokeModule.activateSmokeVolume(map);
    } catch (err) {
      smokeVolumeOn = false;
      console.warn(
        '[fire3d] the smoke volume failed to activate; flat smoke stays.',
        err
      );
    }
  }

  // DR-064: the perimeter ribbon rides its own lazy chunk beside the smoke
  // volume and is non-fatal by contract. It re-presents geometry the flat
  // layer already holds, so a scene without it is the scene as it was.
  try {
    ribbonModule =
      ribbonModule ?? (await import('../layers/nifc-perimeter-ribbon'));
  } catch (err) {
    ribbonModule = null;
    console.warn(
      '[fire3d] the perimeter ribbon chunk failed to load; the flat perimeter stays.',
      err
    );
  }
  if (myGeneration !== generation || !active) return;
  if (ribbonModule) {
    try {
      ribbonOn = await ribbonModule.activatePerimeterRibbon(map, signal);
    } catch (err) {
      ribbonOn = false;
      console.warn(
        '[fire3d] the perimeter ribbon failed to activate; the flat perimeter stays.',
        err
      );
    }
  }
  if (myGeneration !== generation || !active) return;

  // W-CTX: the issuer-published context layers ride their own lazy chunk
  // and are non-fatal by contract; each missing layer degrades alone.
  try {
    contextModule = contextModule ?? (await import('./fire3d-context'));
  } catch (err) {
    contextModule = null;
    console.warn(
      '[fire3d] the context chunk failed to load; the scene keeps terrain and smoke.',
      err
    );
  }
  if (myGeneration !== generation || !active) return;
  if (contextModule) {
    contextAbort = new AbortController();
    let activation: import('./fire3d-context').Fire3DContextActivation = {
      keys: [],
      embedLines: []
    };
    try {
      activation = await contextModule.activateContextLayers(
        map,
        contextAbort.signal
      );
    } catch (err) {
      console.warn('[fire3d] context layers failed to activate.', err);
    }
    if (myGeneration !== generation || !active) return;
    contextKeys = activation.keys;
    contextEmbedLines = activation.embedLines;
  }
  publishStatus('active', null);
}

function deactivateScene(map: maplibregl.Map): void {
  rollbackScene(map);
  publishStatus('inactive', null);
}

/**
 * Imperative mode seam: turn the 3D scene on or off. The controller drives
 * this from the gate; it is exported for direct orchestration and tests.
 * Turning on while an activation is in flight is a no-op; turning off
 * aborts any in-flight activation first.
 */
export function setFire3DActive(map: maplibregl.Map, next: boolean): void {
  if (next) {
    void activateScene(map);
    return;
  }
  if (activation) {
    activation.abort();
    activation = null;
  }
  if (active) {
    deactivateScene(map);
  } else if (status.state === 'checking') {
    savedCamera = null;
    publishStatus('inactive', null);
  }
}

/**
 * Keep the smoke volume consistent with the hms-smoke layer's own
 * lifecycle while the mode is active: the volume follows the flat layer's
 * registry membership (off when the user removes the smoke layer, back on
 * after a re-activation), and an interrupted owner teardown is completed
 * once nothing references the source.
 */
function reconcileSmokeVolume(map: maplibregl.Map): void {
  if (!active || !smokeModule) return;
  const smokeLayerOn = registry.getActiveKeys().has('hms-smoke');
  if (smokeVolumeOn && !smokeLayerOn) {
    smokeModule.deactivateSmokeVolume(map);
    smokeModule.cleanupOrphanedSmokeSource(map);
    smokeVolumeOn = false;
    publishStatus('active', null);
  } else if (!smokeVolumeOn && smokeLayerOn) {
    try {
      smokeVolumeOn = smokeModule.activateSmokeVolume(map);
    } catch (err) {
      smokeVolumeOn = false;
      console.warn(
        '[fire3d] the smoke volume failed to re-activate; flat smoke stays.',
        err
      );
    }
    publishStatus('active', null);
  }
}

/**
 * Keep the DR-064 ribbon consistent with the perimeter layer's own
 * lifecycle while the mode is active.
 *
 * Two seams drive this, because the layer's presence and its DATA arrive at
 * different moments: the registry's `change` event (the person turned the
 * perimeter layer on or off) and its `status-change` event (the WFIGS
 * response landed, so the source the ribbon derives from finally exists).
 * A scene entered before the perimeters resolve therefore gains its ribbon
 * when they do, instead of staying flat until the next toggle.
 *
 * Nothing here writes a layer status or a preference: the ribbon follows
 * the perimeter layer and never the other way round.
 */
function reconcilePerimeterRibbon(map: maplibregl.Map): void {
  if (!active || !ribbonModule) return;
  const ribbon = ribbonModule;
  const perimetersOn = registry.getActiveKeys().has(PERIMETER_LAYER_KEY);
  if (ribbonOn && !perimetersOn) {
    ribbon.deactivatePerimeterRibbon(map);
    ribbonOn = false;
    publishStatus('active', null);
    return;
  }
  if (ribbonOn || !perimetersOn) return;
  const myGeneration = generation;
  void ribbon
    .activatePerimeterRibbon(map)
    .then((on) => {
      // A teardown or a newer activation while the read was in flight owns
      // the scene now; leave its state alone.
      if (myGeneration !== generation || !active || !on) return;
      ribbonOn = true;
      publishStatus('active', null);
    })
    .catch((err: unknown) => {
      console.warn(
        '[fire3d] the perimeter ribbon failed to re-activate; the flat perimeter stays.',
        err
      );
    });
}

/**
 * Wire the mode to its governing stores and evaluate once (the boot seed
 * path: a `fire3d=true` deep link is already seeded by the sidebar before
 * this lazy chunk loads). Idempotent.
 */
export function initFire3DController(map: maplibregl.Map): void {
  if (controllerWired) return;
  controllerWired = true;

  const evaluate = (): void => {
    const should = shouldFire3DBeActive({
      preference: getFire3DPreference(),
      desktopViewport: desktopViewport(),
      committedCluster: getCommittedSnapshot().cluster,
      activeLayerKeys: registry.getActiveKeys(),
      currentlyActive: active || activation !== null,
      webgl2: hasWebGl2(),
      ...viewportHeightInput()
    });
    if (should) {
      if (!active && activation === null) {
        void activateScene(map);
      } else {
        reconcileSmokeVolume(map);
        reconcilePerimeterRibbon(map);
      }
    } else if (active || activation !== null) {
      setFire3DActive(map, false);
    }
  };

  // DR-025a: a lost GPU context freezes the tilted scene at whatever the
  // last frame was, which is the one outcome this mode must never leave a
  // user in. Exit down the existing failure ladder (rollback, preference
  // demotion, toast, status 'unavailable') so the map falls back to the flat
  // 2D view honestly rather than to a frozen viewport. No re-entry on
  // restoration: the preference is demoted and the user re-enters
  // deliberately, which is also what keeps a flapping context from cycling
  // the camera.
  watchContextLoss(map, () => {
    if (!active && activation === null) return;
    failScene(map, 'The graphics context was lost.');
  });

  onFire3DPreferenceChange(evaluate);
  onCommittedSnapshotChange(evaluate);
  registry.on('change', evaluate);
  // The perimeter layer's DATA lands after its registry membership does, so
  // the ribbon needs the status seam as well as the change seam (DR-064).
  registry.on('status-change', (key) => {
    if (key === PERIMETER_LAYER_KEY) reconcilePerimeterRibbon(map);
  });
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia(FIRE3D_MIN_WIDTH_QUERY).addEventListener('change', evaluate);
    // The height floor is watched beside the width query so a rotation into
    // landscape on a phone exits the scene, and a rotation back re-evaluates.
    window
      .matchMedia(FIRE3D_MIN_HEIGHT_QUERY)
      .addEventListener('change', evaluate);
  }
  evaluate();
}
