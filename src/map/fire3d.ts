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
 * toggling either feature cannot tear the other down. Since DR-079 it also
 * resolves its own archive, deepest first (`resolveFire3DTerrainUrl`): this
 * scene is the one place the DEPTH is the point, because it exists to answer
 * whether a fire sits at the foot of a mountain. It still falls back to the
 * hillshade module's resolution, so when the deep archive is unreachable both
 * features agree on which archive is trustworthy, exactly as before.
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
  FIRE3D_OUT_OF_COVERAGE_STATUS,
  FIRE3D_PARTIAL_COVERAGE_STATUS,
  FIRE3D_PITCH_DEGREES,
  FIRE3D_SKY_CLEAR_SPECIFICATION,
  FIRE3D_SKY_SPECIFICATION,
  FIRE3D_TERRAIN_EXAGGERATION,
  classifyTerrainCoverage,
  fire3dCoverageNote,
  isWithinTerrainCoverage
} from '../config/fire3d-presentation';
import type { TerrainCoverageReading } from '../config/fire3d-presentation';
import { URLS } from '../config/urls';
import { resolveHillshadeArchive } from '../layers/hillshade';
import { probeArchiveHeader } from '../util/pmtiles-probe';
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
  /**
   * The deepest zoom the RESOLVED terrain archive declares in its own
   * header, while the scene is active; null otherwise. DR-083 step 1
   * (2026-09-10): the scene probes the deep archive first and falls back
   * to the bundled one, and the two differ only in depth (10 against 8),
   * so the coverage sentence's zoom figure is formatted from this value
   * rather than from the bundled constant, which would be false on the
   * first frame after the deep archive resolves. It is disclosure only:
   * the number is never written back into the source as a declared zoom,
   * because a declared option overrides the archive header permanently.
   */
  readonly terrainMaxZoom: number | null;
  /**
   * How much of the CURRENT VIEW's ground FIRE3D_TERRAIN_COVERAGE holds,
   * while the scene is active: `full`, `partial`, or `none`. Uncovered
   * ground is genuinely flat (MapLibre's terrain sampler has no data to
   * return), not broken; this is what lets the status line say so instead
   * of leaving the two readings indistinguishable. `full` while inactive,
   * checking, or unavailable, so it never competes with those states' own
   * sentences.
   *
   * Three values, not a boolean, since 2026-09-10: this was
   * `outOfTerrainCoverage`, computed from the view's CENTER, which made a
   * categorical claim about a footprint from a single point and was wrong
   * in both directions at the extent's edge (Codex adversarial review
   * finding 8).
   */
  readonly terrainCoverage: TerrainCoverageReading;
  /**
   * Whether the scene's OWN sources (the terrain DEM and any drape/
   * structures sources this activation added) are still streaming tiles, or
   * have all reported loaded. 'streaming' from the moment the scene first
   * publishes 'active' until every scene source reports loaded via
   * `map.isSourceLoaded`, then 'settled'; back to 'streaming' if a source
   * starts loading again (for example a re-fetch after a pan). `null` while
   * inactive, checking, or unavailable, so it never claims a transport
   * reading for a scene that is not there.
   *
   * Exists because the scene publishes 'active' as soon as its context
   * layers activate (`publishStatus('active', null)` at the end of
   * `activateScene`, below), while the terrain DEM, the hazard drape, and
   * the structures archive can still be streaming tiles under it on the
   * software renderer; a caller that treats 'active' alone as "the scene is
   * ready" can starve a layer it activates in the same breath. Recorded
   * 2026-09-10/11: the RAWS station marker case in tests/fire3d-mode.spec.ts
   * checked the telemetry layer immediately after 'active' and starved
   * telemetry's own first activation against the still-arriving terrain
   * traffic; that case now waits on this field instead of on 'active' alone.
   */
  readonly transport: SceneTransportReading | null;
}

/** `Fire3DStatus.transport`'s own two live values (the field is otherwise
 * `null`). Named separately so the derivation below can be imported and
 * exercised without a `Fire3DStatus`. */
export type SceneTransportReading = 'streaming' | 'settled';

/**
 * Derive the scene transport reading from the scene's own source ids and a
 * loaded predicate. Pure, so the state machine behind `Fire3DStatus.transport`
 * is node-testable without a MapLibre map at all (see the node cases beside
 * `parseFire3dParam` near the top of tests/fire3d-mode.spec.ts, and the
 * derivation's own cases beside this function's export).
 *
 * 'streaming' whenever the scene has not yet added every source it owns (an
 * activation still building its context layers) or when any added source is
 * still loading; 'settled' only once every known scene source reports
 * loaded. An empty source list reads as 'streaming': the scene always adds
 * at least its own terrain source while active, so an empty list here means
 * the caller asked before that happened, not that there is nothing left to
 * wait for.
 */
export function deriveSceneTransport(
  sourceIds: readonly string[],
  isLoaded: (id: string) => boolean
): SceneTransportReading {
  if (sourceIds.length === 0) return 'streaming';
  return sourceIds.every((id) => isLoaded(id)) ? 'settled' : 'streaming';
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
  contextLayers: [],
  terrainMaxZoom: null,
  terrainCoverage: 'full',
  transport: null
};
const statusListeners = new Set<() => void>();

let controllerWired = false;
let active = false;
let activation: AbortController | null = null;
/** Mirrors Fire3DStatus.terrainCoverage; read by publishStatus and by
 * syncEmbedNote, kept current by coverageMoveListener while active. `full`
 * while inactive, so neither coverage sentence renders outside the scene. */
let terrainCoverage: TerrainCoverageReading = 'full';
/** Mirrors Fire3DStatus.terrainMaxZoom: the resolved archive's header
 * depth from activation to rollback, null in between. */
let resolvedTerrainMaxZoom: number | null = null;
/** The 'moveend' listener that keeps terrainCoverage current across a
 * pan while the scene stays active; detached in rollbackScene. */
let coverageMoveListener: (() => void) | null = null;
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
/** Mirrors Fire3DStatus.transport; null while inactive, set from the first
 * 'active' publish and cleared by detachTransportWatch in rollbackScene. */
let sceneTransport: SceneTransportReading | null = null;
let transportSourceDataListener: (() => void) | null = null;
let transportIdleListener: (() => void) | null = null;
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
 * The coverage sentence a reading earns, as a zero-or-one-element list so
 * both call sites can spread it. `full` earns nothing: a view entirely
 * within the archive has no gap to disclose, and a standing sentence that
 * said so anyway would dilute the two that matter. Shared by the embed note
 * and the sidebar status line (`outOfCoverageLine` in fire3d-control.tsx
 * selects the same way) so the two surfaces can never disagree about which
 * sentence a view has earned.
 */
function terrainCoverageLines(reading: TerrainCoverageReading): string[] {
  if (reading === 'none') return [FIRE3D_OUT_OF_COVERAGE_STATUS];
  if (reading === 'partial') return [FIRE3D_PARTIAL_COVERAGE_STATUS];
  return [];
}

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
    resolvedTerrainMaxZoom === null
      ? FIRE3D_COVERAGE_NOTE
      : fire3dCoverageNote(resolvedTerrainMaxZoom),
    ...terrainCoverageLines(terrainCoverage),
    ...contextEmbedLines
  ].filter((line) => line.length > 0);
  const note = existing ?? document.createElement('p');
  note.id = EMBED_NOTE_ID;
  note.className = 'fire3d-embed-note';
  note.setAttribute('role', 'note');
  note.textContent = lines.join(' ');
  if (!existing) shell.appendChild(note);
}

/**
 * How much of the CURRENT VIEW the bundled archive covers.
 *
 * Reads `map.getBounds()`, not `map.getCenter()` (Codex adversarial review
 * 2026-09-10, finding 8): a centre is a point, and a point cannot answer a
 * question about a footprint. The old centre test both overstated (a view
 * two thousandths of a degree past the eastern edge announced that the whole
 * view had no archived elevation, while most of its ground did) and
 * understated (a view straddling that edge from the inside said nothing at
 * all, while half its ground rendered flat).
 *
 * A map that cannot report bounds falls back to the centre point, which is
 * the reading this replaced: strictly no worse than the old behaviour, and it
 * keeps a harness or a partially-built map from throwing inside a `moveend`
 * listener. `isWithinTerrainCoverage` is still the point predicate, so both
 * paths compare against the archive's own numbers and neither hand-types a
 * second box.
 */
function readTerrainCoverage(map: maplibregl.Map): TerrainCoverageReading {
  const bounds = typeof map.getBounds === 'function' ? map.getBounds() : null;
  if (bounds) {
    const west = bounds.getWest();
    const south = bounds.getSouth();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    if ([west, south, east, north].every(Number.isFinite)) {
      return classifyTerrainCoverage({ west, south, east, north });
    }
  }
  const center = map.getCenter();
  return isWithinTerrainCoverage(center.lng, center.lat) ? 'full' : 'none';
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
    contextLayers: state === 'active' ? contextKeys : [],
    terrainMaxZoom: state === 'active' ? resolvedTerrainMaxZoom : null,
    terrainCoverage: state === 'active' ? terrainCoverage : 'full',
    transport: state === 'active' ? sceneTransport : null
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
    if (state === 'active' && sceneTransport !== null) {
      root.dataset.ddmFire3dTransport = sceneTransport;
    } else {
      delete root.dataset.ddmFire3dTransport;
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

/** whp-3d.ts's own private SOURCE_ID, mirrored here rather than imported:
 * the module is one of the lazy context chunks (fire3d-context.ts), and a
 * static import into this file would pull it into fire3d's own bundle
 * instead (the same reasoning TERRAIN_SOURCE_ID's neighbourhood documents
 * for the deep-archive resolver, and the mobile test above asserts the
 * chunk boundary this would otherwise break). */
const WHP_DRAPE_SOURCE_ID = 'whp-2023';
/** structures-3d.ts's own private SOURCE_ID, mirrored for the same reason. */
const STRUCTURES_SOURCE_ID = 'structures-3d';

/** The scene's own source ids that are ACTUALLY on the map right now: the
 * terrain DEM always, plus whichever context sources this activation added
 * (read from `contextKeys`, which the context module already reports
 * truthfully per layer). Filtered by `map.getSource` so a layer that never
 * activated (a corrupt archive, a chunk load failure) is never asked to be
 * "loaded". */
function currentSceneSourceIds(map: maplibregl.Map): string[] {
  const ids = [TERRAIN_SOURCE_ID];
  if (contextKeys.includes('whp')) ids.push(WHP_DRAPE_SOURCE_ID);
  if (contextKeys.includes('structures')) ids.push(STRUCTURES_SOURCE_ID);
  return ids.filter((id) => Boolean(map.getSource(id)));
}

/** `map.isSourceLoaded` under a defensive guard: a Node-level test's fake
 * map (tests/map-harness.ts) declares no such method, and an unproven
 * source reads as still streaming rather than as settled, matching this
 * module's usual honesty bias (see readTerrainCoverage's own fallback). */
function isSceneSourceLoaded(map: maplibregl.Map, id: string): boolean {
  if (typeof map.isSourceLoaded !== 'function') return false;
  try {
    return map.isSourceLoaded(id);
  } catch {
    return false;
  }
}

/** Recompute `sceneTransport` from the map's current source-load state and
 * republish only on an actual change (mirrors reconcileSmokeVolume /
 * reconcilePerimeterRibbon's own re-publish-on-change shape). */
function recomputeSceneTransport(map: maplibregl.Map): void {
  if (!active) return;
  const next = deriveSceneTransport(currentSceneSourceIds(map), (id) =>
    isSceneSourceLoaded(map, id)
  );
  if (next === sceneTransport) return;
  sceneTransport = next;
  publishStatus('active', null);
}

/** Start watching the scene's own sources for load progress. Idempotent;
 * detachTransportWatch is its only counterpart. */
function attachTransportWatch(map: maplibregl.Map): void {
  if (transportSourceDataListener) return;
  transportSourceDataListener = () => recomputeSceneTransport(map);
  transportIdleListener = () => recomputeSceneTransport(map);
  map.on('sourcedata', transportSourceDataListener);
  map.on('idle', transportIdleListener);
}

function detachTransportWatch(map: maplibregl.Map): void {
  if (transportSourceDataListener) {
    map.off('sourcedata', transportSourceDataListener);
  }
  if (transportIdleListener) map.off('idle', transportIdleListener);
  transportSourceDataListener = null;
  transportIdleListener = null;
  sceneTransport = null;
}

/** Remove everything the activation added, in reverse, then restore the
 * captured camera. Safe against partial setups (defensive guards). */
function rollbackScene(map: maplibregl.Map): void {
  generation += 1;
  active = false;
  detachTransportWatch(map);
  if (coverageMoveListener) {
    map.off('moveend', coverageMoveListener);
    coverageMoveListener = null;
  }
  terrainCoverage = 'full';
  resolvedTerrainMaxZoom = null;
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

/**
 * The terrain archive this scene should use, deepest first (DR-079).
 *
 * The 2D hillshade underlay is a SUBTLE texture and the bundled zoom 8
 * archive is the honest trade for it, so `resolveHillshadeArchiveUrl` is left
 * exactly as it was. This scene is the one place the depth is the whole
 * point: it exists to answer whether a fire sits at the foot of a mountain,
 * and at about 212 m per pixel there is no foot. Measured in this scene
 * through `queryTerrainElevation` on 2026-09-10, the bundled archive reads
 * the Mount Jefferson summit 931 m low while reading the Bend valley floor
 * within 19 m; the deep archive reads that summit 50 m low.
 *
 * The deep archive is a bounded probe away, never a dependency: a failure
 * here is not a scene failure, it is a fall back to the bundled copy that
 * every deployer already ships, and the scene then behaves exactly as it did
 * before this function existed. So a deployer who cannot reach the Worker, or
 * an installation that has not published one, loses resolution and nothing
 * else. Only a failure of BOTH reaches the caller's `failScene` ladder.
 */
interface ResolvedTerrainArchive {
  readonly url: string;
  /** The depth the archive's own header declares (byte 101), for disclosure. */
  readonly maxZoom: number;
}

async function resolveFire3DTerrainUrl(
  signal: AbortSignal
): Promise<ResolvedTerrainArchive> {
  try {
    const header = await probeArchiveHeader(URLS.terrainPmtilesDeep, signal);
    return { url: URLS.terrainPmtilesDeep, maxZoom: header.maxZoom };
  } catch (err) {
    // An aborted probe is a withdrawn activation, not a missing archive: let
    // the caller's own abort handling see it rather than spending a second
    // probe on a scene nobody is waiting for.
    if (signal.aborted) throw err;
    console.info(
      '[fire3d] the deep terrain archive is unreachable; falling back to the bundled archive.',
      err
    );
    const bundled = await resolveHillshadeArchive(signal);
    return { url: bundled.url, maxZoom: bundled.header.maxZoom };
  }
}

async function activateScene(map: maplibregl.Map): Promise<void> {
  if (active || activation !== null) return;
  const myController = new AbortController();
  activation = myController;
  const signal = myController.signal;
  const myGeneration = ++generation;
  publishStatus('checking', null);
  savedCamera = { pitch: map.getPitch(), bearing: map.getBearing() };

  let resolved: ResolvedTerrainArchive;
  try {
    resolved = await resolveFire3DTerrainUrl(signal);
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

  // Recorded before the source exists so the first 'active' publish and the
  // embed note already name the archive that answered.
  resolvedTerrainMaxZoom = resolved.maxZoom;
  try {
    if (!map.getSource(TERRAIN_SOURCE_ID)) {
      map.addSource(TERRAIN_SOURCE_ID, {
        type: 'raster-dem',
        url: 'pmtiles://' + resolved.url,
        encoding: 'terrarium',
        tileSize: 512
        // NO maxzoom (and no minzoom) here, deliberately: the archive that
        // resolved above decides its own depth, and it is not always the
        // bundled one.
        //
        // An earlier comment here had the mechanism backwards. It claimed
        // the protocol overwrites a declared zoom once the header round trip
        // resolves. The opposite is true: MapLibre merges the two with
        // `extend(tileJSON, options)` (load_tilejson.ts), so a declared
        // option WINS over the archive header, permanently. With
        // `maxzoom: 8` declared, a zoom 0-10 archive was read zoom 0-8 only,
        // because covering_tiles.ts takes `nominalZ = Math.min(desiredZ,
        // maxZoom)`; the deeper tiles were never requested at all.
        //
        // Omit the KEY, never set it to `undefined`. `extend` is a `for...in`
        // over own enumerable keys, so an explicit `undefined` still
        // enumerates and still stomps the header, while an absent key leaves
        // the header's own zooms standing. src/layers/hillshade.ts:113-118
        // has always had this shape; this call is now the same.
      });
    }
    map.setTerrain({
      source: TERRAIN_SOURCE_ID,
      exaggeration: FIRE3D_TERRAIN_EXAGGERATION
    });
    map.setSky(FIRE3D_SKY_SPECIFICATION);
    applyCamera(map, { pitch: FIRE3D_PITCH_DEGREES });
    // Terrain relief fix lane, 2026-09-10: a fire outside the Pacific
    // Northwest bake enters this scene exactly as fully as one inside it
    // (the gate in shouldFire3DBeActive asks nothing about location), so
    // the camera and context still have value there; only the ground is
    // flat. Read once at entry and kept current across a pan by
    // coverageMoveListener, never gating activation itself.
    terrainCoverage = readTerrainCoverage(map);
    coverageMoveListener = () => {
      const next = readTerrainCoverage(map);
      if (next === terrainCoverage) return;
      terrainCoverage = next;
      if (active) publishStatus('active', null);
    };
    map.on('moveend', coverageMoveListener);
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
  // Every scene source this activation is ever going to add is now known
  // (contextKeys is final): start watching them, and read the first
  // transport reading before the FIRST 'active' publish names it, so a
  // caller polling the stamp never sees 'active' with no transport value.
  attachTransportWatch(map);
  sceneTransport = deriveSceneTransport(currentSceneSourceIds(map), (id) =>
    isSceneSourceLoaded(map, id)
  );
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
