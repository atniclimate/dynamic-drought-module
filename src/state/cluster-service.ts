/**
 * The atomic cluster service (S3; D-0.7.0-042/043/044/052/053/074; the
 * S3 handoff as amended by the conductor 2026-07-24; design record
 * docs/design/S4_MAINSCREEN_SHELL_DESIGN_2026-07-18.md section 3).
 *
 * S3 makes the committed hazard cluster actually resolve and apply its
 * horizon-aware recipe, and publishes ONE coherent committed shell
 * snapshot (with the honest prose display summary) that S4 renders.
 * It replaces the S2 interim mechanics that briefly lived in
 * src/state/cluster-store.ts (composeClusterBootLayers /
 * reconcileClusterWithLayerIntent); the semantics carried over.
 *
 * COMPOSITION DISCIPLINE (the amended fences):
 *
 *   - Layer activation goes through the sanctioned DOM-free door
 *     src/ui/layer-toggle-command.ts (requestLayerOnExact /
 *     requestLayerOff), exactly the display-snapshot idiom: checkbox
 *     intent is synchronized BEFORE the controller runs, so the bridge,
 *     the registry, the URL, and the pills can never disagree, and the
 *     door works before the lazy island mounts.
 *   - Activation is EXACT (no co-activation cascade): recipes list
 *     their pairs explicitly (both wildfire recipes name nifc-fires and
 *     hms-smoke); the composition below also expands `coActivateWith`
 *     defensively so the committed intent can never under-claim a pair.
 *   - The committed temporal horizon lives in the timeline store
 *     (timeline.horizon, added by S3) and persists across cluster
 *     flips: a switch compares the same time.
 *   - The frozen facades (layer-controller, registry, the config
 *     tables, the types) are composed, never modified.
 *
 * COHERENCE ("atomic" per the handoff's coherence note): a consumer
 * never observes a MIX of old and new recipe intent. `requestCluster`
 * computes the new intent, flips the layers, commits the store claim,
 * and publishes the snapshot within one synchronous JS turn, holding an
 * apply lock so the service's own subscriptions (and the sidebar's
 * reconcile listener) do not fire on the intermediate states. The prose
 * does not freeze: later status / timeline / framing changes publish
 * LATER revisions of the SAME committed recipe. Because the summary is
 * derived from registry status FILTERED to the committed intendedKeys,
 * a late status write for a dropped layer cannot corrupt it, and the
 * controller's per-key generation guard already drops superseded
 * per-key activations.
 *
 * TWO EDGES THE HANDOFF FORMULA LEFT OPEN (reconciled 2026-07-24;
 * surfaced to the conductor in the lane report):
 *
 *   - Reference extras: reference-role layers the user turned on are
 *     never deactivated by a cluster switch, so when any survive
 *     outside the composition, requestCluster commits DEMOTED
 *     ('custom', store absence, `layers=` truth) instead of the clean
 *     one-word claim; the URL never claims a cluster the display is
 *     not (D-0.7.0-044), and the share/reload round-trip keeps every
 *     displayed layer.
 *   - Horizon changes: the snapshot's horizon is the horizon its
 *     intent was RESOLVED at (frozen with the commitment), and a
 *     committed-horizon change re-runs the whole transaction at the
 *     new horizon, so no revision ever pairs a new-horizon claim with
 *     an old-horizon recipe.
 */

import { HAZARD_CLUSTERS } from '../config/clusters';
import type { HazardClusterKey, TemporalHorizonKey } from '../config/clusters';
import { DEFAULT_ON_KEYS, LAYER_DEFS, getLayerDef } from '../config/layers';
import type { FramingKey } from '../config/framings';
import type { OceanKey } from '../config/oceans';
import type { LayerStatus } from '../types/layer';
import type { DisplaySummary, TimelineSnapshot } from '../types/display-summary';
import { deriveDisplaySummary } from './display-summary';
import {
  getHazardCluster,
  getOceanFraming,
  onHazardClusterChange,
  setHazardCluster
} from './cluster-store';
import { getFraming, onFramingChange } from './framing-store';
import { registry } from './registry';
import { timeline } from './timeline';
import { checkedSnapshot } from '../ui/island/bridge';
import { requestLayerOff, requestLayerOnExact } from '../ui/layer-toggle-command';

/**
 * The committed shell state S4 renders. Named CommittedShellSnapshot
 * deliberately: the existing DisplaySnapshot of
 * src/state/display-snapshot.ts is the Place studio's capture-and-
 * restore record, a different concern; the two must not be confused.
 */
export interface CommittedShellSnapshot {
  /** Monotonic publish counter; a re-derivation bumps it. */
  readonly revision: number;
  /** The hazard view the user most recently chose. This remains stable when
   * a failed surface honestly demotes the exact displayed set to `custom`. */
  readonly selectedHazard: HazardClusterKey;
  /** The committed cluster, or 'custom' once the granular intent has
   * diverged from any cluster's composition (D-0.7.0-044). */
  readonly cluster: HazardClusterKey | 'custom';
  /** The committed temporal horizon (persists across cluster flips). */
  readonly horizon: TemporalHorizonKey;
  /** The active camera framing, or null for the ALL state. */
  readonly framing: FramingKey | null;
  /** The committed (requested) layer keys. */
  readonly intendedKeys: ReadonlySet<string>;
  /** Registry statuses, filtered to the intended keys, copied in the
   * publishing turn (a Map copy in one turn is coherent). */
  readonly statuses: ReadonlyMap<string, LayerStatus>;
  readonly timeline: TimelineSnapshot;
  readonly summary: DisplaySummary;
}

let revision = 0;
/** Explicitly committed cluster, or null to derive from the store. */
let committedCluster: HazardClusterKey | 'custom' | null = null;
/** Explicitly committed intent, or null to derive from the store. */
let committedIntent: ReadonlySet<string> | null = null;
/** The horizon the committed recipe was RESOLVED at; null when the
 * commitment is 'custom' (checkbox-derived, not recipe-bound) or
 * derived from the store. Keeping it beside the intent is what makes a
 * snapshot self-consistent: the horizon field and the intendedKeys it
 * pairs with always come from the same resolution. */
let committedHorizon: TemporalHorizonKey | null = null;
/** User-facing hazard intent, separate from exact-set cluster honesty. */
let selectedHazard: HazardClusterKey = getHazardCluster();
let current: CommittedShellSnapshot | null = null;
/** True while requestCluster (or a service-internal store write) is
 * mid-transaction; subscriptions stand down so no intermediate state is
 * ever observed or published. */
let applying = false;
let disposer: (() => void) | null = null;

const listeners = new Set<() => void>();

/**
 * The layer set a committed cluster resolves to at a horizon: the
 * persistent reference set (every default-on key that is not a
 * condition surface: sovereign geography, state hairlines, terrain
 * shading) which survives every cluster switch, plus the cluster's
 * hazard recipe for the horizon in activation order, with any
 * `coActivateWith` pair expanded defensively (recipes already list
 * their pairs explicitly; the controller cascade is never relied on
 * along this path). For 'drought' at 'current' this composes back to
 * exactly the default-on set, so the bare boot and the absent-cluster
 * boot are the same set by construction. An EMPTY recipe (Extreme Heat
 * at season-ahead) honestly yields the reference set alone.
 */
export function composeClusterIntent(
  cluster: HazardClusterKey,
  horizon: TemporalHorizonKey = timeline.horizon
): readonly string[] {
  const out: string[] = [];
  const push = (key: string): void => {
    if (!out.includes(key)) out.push(key);
  };
  for (const def of LAYER_DEFS) {
    if (DEFAULT_ON_KEYS.has(def.key) && def.role !== 'surface') push(def.key);
  }
  for (const key of HAZARD_CLUSTERS[cluster].recipes[horizon]) {
    push(key);
    for (const partner of getLayerDef(key)?.coActivateWith ?? []) push(partner);
  }
  return out;
}

/** The committed cluster, horizon, and intent, deriving from the store
 * when no explicit commitment has been made yet (the pre-S4 boot path).
 * The horizon returned is ALWAYS the one the intent was resolved at:
 * the frozen committedHorizon for a recipe commitment, the live
 * timeline register for the derived and 'custom' cases (where the
 * intent is composed live or checkbox-derived in the same turn), so a
 * snapshot can never pair one horizon's claim with another horizon's
 * recipe. */
function resolveCommitted(): {
  cluster: HazardClusterKey | 'custom';
  horizon: TemporalHorizonKey;
  intent: ReadonlySet<string>;
} {
  if (committedCluster !== null && committedIntent !== null) {
    return {
      cluster: committedCluster,
      horizon: committedHorizon ?? timeline.horizon,
      intent: committedIntent
    };
  }
  const cluster = getHazardCluster();
  const horizon = timeline.horizon;
  const composed: ReadonlySet<string> = new Set(composeClusterIntent(cluster, horizon));
  // Boot honesty guard: the sidebar seeds the bridge with EVERY known
  // key (true or false) from the parsed URL before the island can mount,
  // so a non-empty bridge is the boot's real checkbox intent. When that
  // intent disagrees with the store claim's composition (a `layers=`
  // deep link, including the explicit all-off `?layers=`), the derived
  // snapshot must describe the CHECKED display as 'custom', never the
  // store cluster's composition: otherwise the first paint claims layers
  // that were never requested (Drought pressed plus a perpetual
  // "Loading US Drought Monitor" caveat over an all-off boot). An
  // unseeded bridge (the pure-Node spec world) falls through to the
  // composed claim.
  if (checkedSnapshot().size > 0) {
    const on = onKeys();
    const agrees =
      on.size === composed.size && [...composed].every((key) => on.has(key));
    if (!agrees) {
      return { cluster: 'custom', horizon, intent: on };
    }
  }
  return { cluster, horizon, intent: composed };
}

/** Capture a coherent snapshot in the current synchronous turn. */
function capture(): CommittedShellSnapshot {
  const { cluster, horizon, intent } = resolveCommitted();
  const intendedKeys: ReadonlySet<string> = new Set(intent);
  const statuses = new Map<string, LayerStatus>();
  for (const key of intendedKeys) {
    const status = registry.getStatus(key);
    if (status !== undefined) statuses.set(key, status);
  }
  const timelineSnapshot: TimelineSnapshot = {
    usdmWeek: timeline.usdmWeek,
    usdmMode: timeline.usdmMode,
    sstDate: timeline.sstDate,
    outlookRange: timeline.outlookRange
  };
  const framingSelection = getFraming();
  const framing = framingSelection === 'all' ? null : framingSelection;
  const summary = deriveDisplaySummary({
    cluster,
    framing,
    intendedKeys,
    statuses,
    timeline: timelineSnapshot
  });
  revision += 1;
  return {
    revision,
    selectedHazard,
    cluster,
    horizon,
    framing,
    intendedKeys,
    statuses,
    timeline: timelineSnapshot,
    summary
  };
}

function publish(): void {
  current = capture();
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[cluster-service] listener threw:', err);
    }
  }
}

/** The latest committed shell snapshot (derived on first read). */
export function getCommittedSnapshot(): CommittedShellSnapshot {
  if (current === null) current = capture();
  return current;
}

/** Subscribe to snapshot publishes. Returns an unsubscribe function. */
export function onCommittedSnapshotChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Every key currently "on": checked intent union registered active
 * (the checkbox leads the registry while an activation is in flight). */
function onKeys(): Set<string> {
  const on = new Set<string>();
  for (const [key, checked] of checkedSnapshot()) {
    if (checked) on.add(key);
  }
  for (const key of registry.getActiveKeys()) on.add(key);
  return on;
}

/**
 * Resolve, apply, and commit a hazard cluster (the S3 transaction):
 *
 *   1. Read the committed horizon from the timeline (it persists across
 *      cluster flips; the switch compares the same time).
 *   2. Resolve the intent: the persistent reference set union the
 *      horizon recipe (pairs expanded). An empty recipe commits the
 *      reference set plus an honest summary caveat, never a silently
 *      substituted surface.
 *   3. Deactivate the old display's exclusive non-reference members
 *      (currently-on keys outside the new intent) through the toggle
 *      door. Reference-role keys are NEVER deactivated here.
 *   4. Activate the new recipe through requestLayerOnExact (intent
 *      first, no cascade; the controller's per-key generation guard
 *      absorbs rapid re-flips). The caller is not await-blocked; the
 *      snapshot's coherence comes from step 6, not from activation
 *      settling.
 *   5. Commit the claim to the store/URL. When the display after step 3
 *      IS exactly the composition, the claim is the clean cluster:
 *      setHazardCluster(key) (Drought serializes as absence per the
 *      store's contract). But reference-role extras the user turned on
 *      (City & Town Labels, Hydrography, Ecoregions, the deployer
 *      slots) are NEVER deactivated by step 3 and are NOT in the
 *      composition, so when any survive the switch the display is more
 *      than the cluster and the one-word `cluster=` claim would drop
 *      them from the share/reload round-trip. In that case the recipe
 *      still applies but the claim commits DEMOTED: the snapshot reads
 *      'custom', the committed intent folds the extras in, and the
 *      store stays at 'drought' (absence) so the URL keeps the granular
 *      `layers=` truth (D-0.7.0-044 exact-set semantics; CLAUDE.md
 *      section 6 invariant 2: the URL never claims a cluster the
 *      display is not). Either way, choosing a non-ENSO cluster clears
 *      the ocean framing (D-0.7.0-053 exclusivity); the SST display
 *      itself falls out of step 3.
 *   6. Publish a new CommittedShellSnapshot in this same JS turn.
 */
function applyCluster(
  key: HazardClusterKey,
  requestedOcean: OceanKey | null,
): void {
  selectedHazard = key;
  const horizon = timeline.horizon;
  const intent = composeClusterIntent(key, horizon);
  const intentSet: ReadonlySet<string> = new Set(intent);
  applying = true;
  try {
    // On-but-uncomposed keys that survive the switch: reference-role
    // layers are deliberately never deactivated (handoff step 3), and a
    // checked key with no definition (a stale deep link) is user-visible
    // intent nothing here may silently drop. Both make the display more
    // than the clean composition.
    const extras: string[] = [];
    for (const onKey of onKeys()) {
      if (intentSet.has(onKey)) continue;
      const def = getLayerDef(onKey);
      if (def === null || def.role === 'reference') {
        extras.push(onKey);
        continue;
      }
      requestLayerOff(onKey);
    }
    for (const wanted of intent) {
      requestLayerOnExact(wanted);
    }
    if (extras.length === 0) {
      committedCluster = key;
      committedIntent = intentSet;
      committedHorizon = horizon;
      setHazardCluster(key, key === 'enso' ? requestedOcean : null);
    } else {
      // The demoted commit: recipe applied, extras kept, claim honest.
      committedCluster = 'custom';
      committedIntent = new Set([...intent, ...extras]);
      committedHorizon = null;
      setHazardCluster('drought', null);
    }
  } finally {
    applying = false;
  }
  publish();
}

export function requestCluster(key: HazardClusterKey): void {
  applyCluster(key, key === 'enso' ? getOceanFraming() : null);
}

/**
 * Enter the ENSO display with one explicit schematic ocean camera claim.
 * This shares the exact cluster transaction above, so the layer recipe,
 * `cluster=enso&ocean=...` claim, and committed snapshot change together.
 * The caller owns the camera fit because this state service deliberately has
 * no MapLibre dependency.
 */
export function requestOcean(key: OceanKey): void {
  applyCluster('enso', key);
}

/**
 * Commit a temporal horizon through the service (the shell's horizon
 * chips). One transaction, never two: for an explicitly committed
 * cluster the timeline subscription below re-runs `requestCluster` at
 * the new horizon by itself, so this door only writes the register; for
 * the DERIVED (pre-commit boot) state there is no explicit commitment
 * for that subscription to re-run, so the register write is shielded and
 * the store cluster is committed here at the new horizon (one coherent
 * revision, no duplicate controller traffic); a 'custom' display keeps
 * its granular set (a horizon is a recipe question) and simply
 * republishes with the new register.
 */
export function requestHorizon(next: TemporalHorizonKey): void {
  if (timeline.horizon === next) return;
  if (committedCluster === null) {
    // Derived: when the boot honesty guard already reads the display as
    // 'custom' (a layers= deep link), the granular set keeps itself; the
    // register write republishes it at the new horizon.
    if (resolveCommitted().cluster === 'custom') {
      timeline.setHorizon(next);
      return;
    }
    // Otherwise shield the register write from the subscriptions, then
    // run the one transaction at the new horizon.
    const cluster = getHazardCluster();
    applying = true;
    try {
      timeline.setHorizon(next);
    } finally {
      applying = false;
    }
    requestCluster(cluster);
    return;
  }
  // Committed (a real cluster re-resolves via the timeline subscription;
  // 'custom' republishes there with its set unchanged).
  timeline.setHorizon(next);
}

/**
 * Drop the cluster claim when the granular layer intent no longer
 * matches the committed composition (D-0.7.0-044: the moment the user
 * customizes, `cluster=` comes off and `layers=` goes on; the URL never
 * claims a cluster the display is not). Called by the sidebar on every
 * checkbox-intent flip; a terminal activation failure that unchecks a
 * recipe member also lands here, which is deliberate honesty (a
 * wildfire display missing its perimeters is not the Wildfire cluster).
 * Stands down while the service itself is applying a cluster, so the
 * transaction's own intermediate flips can never demote the cluster it
 * is committing (the S2-mechanics defect this service retires).
 */
export function reconcileClusterWithLayerIntent(checked: ReadonlySet<string>): void {
  if (applying) return;
  // Compare against the CLAIMED composition, never the derived boot
  // guard's checked-derived intent (which by construction equals the
  // checked set and would make every customization look like agreement,
  // leaving a stale cluster= claim on the URL): the explicit committed
  // intent when one exists, otherwise the store claim's composition at
  // the committed horizon.
  const intent: ReadonlySet<string> =
    committedCluster !== null && committedIntent !== null
      ? committedIntent
      : new Set(composeClusterIntent(getHazardCluster(), timeline.horizon));
  const matches =
    checked.size === intent.size && [...intent].every((key) => checked.has(key));
  if (matches) return;
  committedCluster = 'custom';
  committedIntent = new Set(checked);
  committedHorizon = null;
  if (getHazardCluster() !== 'drought') {
    applying = true;
    try {
      setHazardCluster('drought', null);
    } finally {
      applying = false;
    }
  }
  if (disposer !== null) {
    publish();
  } else {
    // Not initialized: invalidate so the next read re-derives.
    current = null;
  }
}

/**
 * Subscribe the snapshot to its inputs so it RE-DERIVES (a new
 * revision) on registry, timeline, framing, and external cluster-store
 * changes. Idempotent; returns a disposer. Called by S4/boot later; in
 * this lane it is exercised by the specs. Every subscription stands
 * down while a transaction is applying (the final publish covers it).
 */
export function initClusterService(): () => void {
  if (disposer !== null) return disposer;
  // URL state is parsed after this module is evaluated. Seed the user-facing
  // hazard from the parsed store here so a direct cluster= deep link does not
  // inherit the module's earlier Drought default.
  selectedHazard = getHazardCluster();
  current = null;
  const unsubscribers = [
    registry.on('change', () => {
      if (!applying) publish();
    }),
    registry.on('status-change', (key) => {
      if (applying) return;
      // A status write for a NON-intended (dropped) layer cannot touch
      // the summary; only intended-layer status republishes.
      if (resolveCommitted().intent.has(key)) publish();
    }),
    timeline.onChange(() => {
      if (applying) return;
      // A committed-horizon change while a real cluster is committed is
      // a NEW resolution question, not a republish: the frozen
      // committedIntent belongs to the old horizon, so re-run the full
      // transaction at the new horizon. One coherent revision publishes
      // (from requestCluster, in this same turn); no snapshot ever
      // pairs the new horizon with the old horizon's recipe (the
      // handoff section 3 coherence note). Non-horizon register changes
      // (usdmWeek, sstDate, outlookRange alone) and the 'custom' /
      // derived cases republish as before.
      if (
        committedCluster !== null &&
        committedCluster !== 'custom' &&
        committedHorizon !== null &&
        timeline.horizon !== committedHorizon
      ) {
        requestCluster(committedCluster);
        return;
      }
      publish();
    }),
    onFramingChange(() => {
      if (!applying) publish();
    }),
    onHazardClusterChange(() => {
      if (applying) return;
      // An external store write (the boot seed, the Place studio
      // restore) is a new committed claim: re-derive from the store.
      selectedHazard = getHazardCluster();
      committedCluster = null;
      committedIntent = null;
      committedHorizon = null;
      publish();
    })
  ];
  disposer = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    disposer = null;
  };
  return disposer;
}
