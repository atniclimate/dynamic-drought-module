import { LAYER_DEFS, getLayerDef } from '../config/layers';
import type { HazardClusterKey } from '../config/clusters';
import { URLS } from '../config/urls';
import type { PlaceCatalogEntry } from '../config/place-catalog';
import type { OceanKey } from '../config/oceans';
import type { LayerStatus } from '../types/layer';
import { fetchWithBudget } from '../util/fetch';
import { isChecked, checkedSnapshot, onCheckedChange } from '../ui/island/bridge';
import {
  requestLayerOff,
  requestLayerOnExact
} from '../ui/layer-toggle-command';
import {
  getHazardCluster,
  getOceanFraming,
  setHazardCluster
} from './cluster-store';
import { getMap } from './map-store';
import {
  clearEmphasis,
  emphasizePlace,
  emphasizePlaces,
  type EmphasisTarget
} from './place-emphasis';
import {
  clearStudioBoundary,
  showStudioBoundary,
  type StudioBoundaryGeometry
} from './studio-boundary';
import { registry } from './registry';
import type { TypedPlaceKind, TypedPlaceRef } from './typed-place';

/**
 * The map display captured when the Place studio opens. Statuses are evidence
 * about the captured display, not values to replay. Restoring the intent set
 * lets each layer derive its current honest status from its real activation.
 */
export interface DisplaySnapshot {
  readonly intentKeys: ReadonlySet<string>;
  readonly statuses: ReadonlyMap<string, LayerStatus>;
  readonly cluster: HazardClusterKey;
  readonly ocean: OceanKey | null;
}

const SET_ASIDE_ROLES = new Set(['surface', 'event']);
const REFERENCE_KEYS: Readonly<Record<TypedPlaceKind, readonly string[]>> = {
  tribe: ['aiannh', 'bia-reservations'],
  state: ['states'],
  ecoregion: ['ecoregions'],
  watershed: []
};
const EMPHASIS_TIMEOUT_MS = 8_000;

let activeSnapshot: DisplaySnapshot | null = null;
let activeKind: TypedPlaceKind = 'tribe';
let unsubscribeIntent: (() => void) | null = null;
let unsubscribeRegistry: (() => void) | null = null;
let enforceQueued = false;
let emphasisGeneration = 0;
let emphasisAbort: AbortController | null = null;
let currentPlace: TypedPlaceRef | null = null;
let currentEntry: PlaceCatalogEntry | null = null;
const featureIdCache = new Map<string, readonly EmphasisTarget[]>();
/**
 * Keys whose activation terminally FAILED while the studio's clean-display
 * enforcement wanted them (swarm finding R4 H3). Enforcement skips them:
 * the controller unchecks a failed layer, the uncheck fires the intent
 * listener, and blindly re-requesting would loop the failing fetch
 * forever. Cleared on studio entry and on every rail-type change (a new
 * rail selection is the deliberate retry).
 */
const failedKeys = new Set<string>();
/**
 * The ecoregion display level the studio overrode, remembered ONCE so the
 * restore path can put the user's level back (swarm finding R2 H3: a
 * Level IV selection must draw the Level IV layer or its emphasis lands
 * on a hidden source-layer).
 */
let ecoregionLevelBeforeStudio: 'ecoregions-l3' | 'ecoregions-l4' | null = null;

/** Capture the current checkbox intent and the registry's honest statuses. */
export function captureDisplaySnapshot(): DisplaySnapshot {
  const intentKeys = new Set<string>();
  for (const [key, checked] of checkedSnapshot()) {
    if (checked) intentKeys.add(key);
  }

  const statuses = new Map<string, LayerStatus>();
  for (const def of LAYER_DEFS) {
    const status = registry.getStatus(def.key);
    if (status) statuses.set(def.key, status);
  }

  return {
    intentKeys,
    statuses,
    cluster: getHazardCluster(),
    ocean: getOceanFraming()
  };
}

/**
 * Start the Place studio display once per mounted route. The bridge is already
 * seeded from URL intent before a direct studio URL mounts, even when the
 * corresponding layer activations are still waiting for the lazy catalog.
 */
export function beginPlaceStudioDisplay(kind: TypedPlaceKind): DisplaySnapshot {
  if (!activeSnapshot) {
    activeSnapshot = captureDisplaySnapshot();
    failedKeys.clear();
    unsubscribeIntent = onCheckedChange(() => queueCleanIntentEnforcement());
    unsubscribeRegistry = registry.on('change', () => reapplyEmphasisWhenReady());
  }
  activeKind = kind;
  enforceCleanIntent();
  return activeSnapshot;
}

/** Show the current rail type's reference boundaries over the clean display. */
export function setPlaceStudioDisplayKind(kind: TypedPlaceKind): void {
  if (!activeSnapshot) return;
  activeKind = kind;
  // A new rail selection is the deliberate retry for reference layers
  // that failed to activate (R4 H3).
  failedKeys.clear();
  if (kind !== 'watershed') setStudioWatershedBoundary(null);
  enforceCleanIntent();
}

/**
 * Show (or clear, with null) the selected watershed's fetched boundary on
 * the clean-selection display. Watersheds have no catalog reference layer;
 * this ephemeral surface (src/state/studio-boundary.ts) is their studio
 * boundary display and emphasis in one. Session-only: the restore path
 * clears it unconditionally, and nothing here touches URL or catalog
 * state. A call while the studio is not active is a no-op.
 */
export function setStudioWatershedBoundary(
  geometry: StudioBoundaryGeometry | null
): void {
  const map = getMap();
  if (!map) return;
  if (!activeSnapshot || geometry === null) {
    clearStudioBoundary(map);
    return;
  }
  showStudioBoundary(map, geometry);
}

/**
 * Apply the shipped feature-state emphasis to the durable studio selection.
 * Source identity resolution never writes the map directly. The final render
 * operation always passes through emphasizePlace.
 */
export function emphasizeTypedPlace(
  place: TypedPlaceRef | null,
  entry: PlaceCatalogEntry | null
): void {
  currentPlace = place;
  currentEntry = entry;
  applyCurrentEmphasis();
}

function applyCurrentEmphasis(): void {
  emphasisGeneration += 1;
  const generation = emphasisGeneration;
  emphasisAbort?.abort();
  emphasisAbort = null;

  const map = getMap();
  if (!map) return;
  clearEmphasis(map);
  const place = currentPlace;
  const entry = currentEntry;
  if (!activeSnapshot || !place || !entry || !entry.geometryAvailable) return;
  if (entry.kind !== place.kind || entry.id !== place.id) return;

  if (place.kind === 'ecoregion') {
    const sourceLayer = entry.detail === 'Level IV' ? 'ecoregions-l4' : 'ecoregions-l3';
    // Draw the level the selection belongs to, or the feature-state lands
    // on a hidden source-layer (R2 H3). The FIRST override remembers the
    // user's level; restore puts it back.
    void import('../layers/ecoregions')
      .then((m) => {
        if (generation !== emphasisGeneration || !activeSnapshot) return;
        const previous = m.setEcoregionDisplayLevel(map, sourceLayer);
        if (ecoregionLevelBeforeStudio === null && previous !== sourceLayer) {
          ecoregionLevelBeforeStudio = previous;
        }
        emphasizePlace(map, 'ecoregions', place.id, sourceLayer);
      })
      .catch(() => undefined);
    return;
  }
  if (place.kind === 'watershed') return;

  const abort = new AbortController();
  emphasisAbort = abort;
  void resolveEmphasisTargets(place, entry, abort.signal)
    .then((resolved) => {
      if (
        abort.signal.aborted ||
        generation !== emphasisGeneration ||
        !activeSnapshot ||
        resolved.length === 0
      ) {
        return;
      }
      emphasizePlaces(map, resolved);
    })
    .catch((err: unknown) => {
      if (!abort.signal.aborted) {
        console.warn('[display-snapshot] place emphasis lookup failed.', err);
      }
    });
}

/**
 * Restore the exact captured intent. Status values are deliberately not
 * replayed: deactivated layers activate again through the controller and
 * publish loading plus their truthful terminal status from current data.
 */
export function restoreDisplaySnapshot(): DisplaySnapshot | null {
  const snapshot = activeSnapshot;
  if (!snapshot) return null;

  activeSnapshot = null;
  unsubscribeIntent?.();
  unsubscribeIntent = null;
  unsubscribeRegistry?.();
  unsubscribeRegistry = null;
  emphasisGeneration += 1;
  emphasisAbort?.abort();
  emphasisAbort = null;
  currentPlace = null;
  currentEntry = null;
  failedKeys.clear();
  const map = getMap();
  if (map) {
    clearStudioBoundary(map);
    // Put the user's ecoregion detail level back if the studio moved it
    // for a selection (R2 H3).
    const priorLevel = ecoregionLevelBeforeStudio;
    if (priorLevel !== null) {
      void import('../layers/ecoregions')
        .then((m) => m.setEcoregionDisplayLevel(map, priorLevel))
        .catch(() => undefined);
    }
  }
  ecoregionLevelBeforeStudio = null;

  syncIntent(snapshot.intentKeys);
  setHazardCluster(snapshot.cluster, snapshot.ocean);
  return snapshot;
}

function cleanIntent(snapshot: DisplaySnapshot, kind: TypedPlaceKind): ReadonlySet<string> {
  const wanted = new Set<string>();
  for (const key of snapshot.intentKeys) {
    const def = getLayerDef(key);
    if (!def || SET_ASIDE_ROLES.has(def.role)) continue;
    wanted.add(key);
  }
  for (const key of REFERENCE_KEYS[kind]) wanted.add(key);
  return wanted;
}

function enforceCleanIntent(): void {
  if (!activeSnapshot) return;
  const wanted = new Set(cleanIntent(activeSnapshot, activeKind));
  // Failure ledger (R4 H3): a wanted key the controller unchecked with a
  // terminal error must not be blindly re-requested on every intent
  // change, or a persistently failing reference service loops fetches
  // and URL writes until the user leaves. It reads honestly unavailable
  // instead; a rail change or studio re-entry retries deliberately.
  for (const key of wanted) {
    if (!isChecked(key) && registry.getStatus(key) === 'error') {
      failedKeys.add(key);
    }
  }
  for (const key of failedKeys) wanted.delete(key);
  syncIntent(wanted);
}

/**
 * Boot activation begins after the route can mount. Reassert after the current
 * stack so a late applyLayerSet cannot resurrect a set-aside layer.
 */
function queueCleanIntentEnforcement(): void {
  if (!activeSnapshot || enforceQueued) return;
  enforceQueued = true;
  queueMicrotask(() => {
    enforceQueued = false;
    enforceCleanIntent();
  });
}

function syncIntent(wanted: ReadonlySet<string>): void {
  for (const def of LAYER_DEFS) {
    if (isChecked(def.key) && !wanted.has(def.key)) requestLayerOff(def.key);
  }
  for (const key of wanted) {
    // Exact, non-cascading activation (R4 H2): both the clean-display
    // enforcement and the restore name their layers explicitly, so the
    // user-toggle co-activation cascade must not widen the set (a
    // restored nifc-fires pulling hms-smoke back on that the snapshot
    // never contained).
    if (!isChecked(key)) requestLayerOnExact(key);
  }
}

function reapplyEmphasisWhenReady(): void {
  if (!activeSnapshot || !currentPlace || !currentEntry) return;
  const key = REFERENCE_KEYS[currentPlace.kind].at(-1);
  if (key && registry.getActiveKeys().has(key)) applyCurrentEmphasis();
}

/**
 * Resolve the full set of emphasis targets for a selection (swarm
 * findings R4 M5 and R2 H3): a Tribal Nation whose roster identity
 * matched SEVERAL land-area representations gets every representation's
 * every feature lit, never just the first alphabetical polygon presented
 * as the whole Nation.
 */
async function resolveEmphasisTargets(
  place: TypedPlaceRef,
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<readonly EmphasisTarget[]> {
  const cacheKey = `${place.kind}:${place.id}:${entry.representationIds.join('|')}`;
  const cached = featureIdCache.get(cacheKey);
  if (cached) return cached;

  if (place.kind === 'state') {
    const response = await fetchWithBudget(
      URLS.usStatesLocal,
      null,
      signal,
      EMPHASIS_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const collection = (await response.json()) as {
      readonly features?: readonly {
        readonly properties?: Readonly<Record<string, unknown>>;
      }[];
    };
    const index = (collection.features ?? []).findIndex(
      (feature) => feature.properties?.['STUSPS'] === place.id
    );
    if (index < 0) return [];
    const resolved: readonly EmphasisTarget[] = [{ source: 'us-states', id: index }];
    featureIdCache.set(cacheKey, resolved);
    return resolved;
  }

  if (place.kind === 'tribe') {
    const larNames = entry.representationIds.filter((name) => name !== '');
    if (larNames.length === 0) return [];
    const quoted = larNames
      .map((name) => `'${name.replace(/'/g, "''")}'`)
      .join(',');
    const params = new URLSearchParams({
      where: `LARNAME IN (${quoted})`,
      outFields: 'LARID',
      returnGeometry: 'false',
      f: 'json'
    });
    const response = await fetchWithBudget(
      `${URLS.biaLarFeatureServer}/query?${params.toString()}`,
      { cache: 'no-store' },
      signal,
      EMPHASIS_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const result = (await response.json()) as {
      readonly features?: readonly {
        readonly attributes?: Readonly<Record<string, unknown>>;
      }[];
    };
    const seen = new Set<string>();
    const targets: EmphasisTarget[] = [];
    for (const feature of result.features ?? []) {
      const id = feature.attributes?.['LARID'];
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const dedupeKey = String(id);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      targets.push({ source: 'bia-reservations', id });
    }
    if (targets.length === 0) return [];
    featureIdCache.set(cacheKey, targets);
    return targets;
  }

  return [];
}
