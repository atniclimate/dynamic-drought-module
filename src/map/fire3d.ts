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
 *
 * Meaning constraints carried through: perimeters remain mapped incident
 * representations draped over relief (render-to-texture), the reduced-motion
 * static #ff4c00 perimeter contract is untouched, and the camera treatment
 * claims nothing about fire behavior.
 */

import type maplibregl from 'maplibre-gl';

import type { HazardClusterKey } from '../config/clusters';
import {
  FIRE3D_CAMERA_TRANSITION_MS,
  FIRE3D_MIN_WIDTH_QUERY,
  FIRE3D_PITCH_DEGREES,
  FIRE3D_SKY_CLEAR_SPECIFICATION,
  FIRE3D_SKY_SPECIFICATION,
  FIRE3D_TERRAIN_EXAGGERATION
} from '../config/fire3d-presentation';
import { resolveHillshadeArchiveUrl } from '../layers/hillshade';
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

export interface Fire3DStatus {
  readonly state: 'inactive' | 'checking' | 'active' | 'unavailable';
  /** Honest user-facing reason; non-null only for 'unavailable'. */
  readonly reason: string | null;
  /** True while the volumetric smoke read is in place beside the terrain;
   * false while active with the flat veil only (partial degrade). */
  readonly smokeVolume: boolean;
}

export interface Fire3DGateInput {
  readonly preference: boolean;
  readonly desktopViewport: boolean;
  readonly committedCluster: HazardClusterKey | 'custom';
  readonly activeLayerKeys: ReadonlySet<string>;
  readonly currentlyActive: boolean;
}

/**
 * The full activation gate (pure, Node-testable). ENTRY requires the
 * committed cluster to BE 'wildfire'; once active, an honest demotion to
 * 'custom' (the user added a reference layer to the Fire view) keeps the
 * mode alive while a fire event layer remains in the active set, so one
 * extra layer never collapses the scene. Switching to another cluster,
 * removing every fire event layer, toggling the preference off, or a
 * narrow viewport always exits.
 */
export function shouldFire3DBeActive(input: Fire3DGateInput): boolean {
  if (!input.preference || !input.desktopViewport) return false;
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
  smokeVolume: false
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

function publishStatus(
  state: Fire3DStatus['state'],
  reason: string | null
): void {
  status = { state, reason, smokeVolume: state === 'active' && smokeVolumeOn };
  // Production-observable truth stamp (the dev-only __ddmMap handle is
  // dead-code-eliminated from dist/, so the verification suite reads mode
  // state from here; the stamp is written from what the map actually
  // holds, not from intent).
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.ddmFire3d = state;
    if (state === 'active') {
      root.dataset.ddmFire3dSmoke = smokeVolumeOn ? 'volume' : 'flat';
    } else {
      delete root.dataset.ddmFire3dSmoke;
    }
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
      currentlyActive: active || activation !== null
    });
    if (should) {
      if (!active && activation === null) {
        void activateScene(map);
      } else {
        reconcileSmokeVolume(map);
      }
    } else if (active || activation !== null) {
      setFire3DActive(map, false);
    }
  };

  onFire3DPreferenceChange(evaluate);
  onCommittedSnapshotChange(evaluate);
  registry.on('change', evaluate);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia(FIRE3D_MIN_WIDTH_QUERY).addEventListener('change', evaluate);
  }
  evaluate();
}
