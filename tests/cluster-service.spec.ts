import { test, expect } from './offline-test';

import {
  composeClusterIntent,
  followGeography,
  followPlace,
  getCommittedSnapshot,
  initClusterService,
  isModeDisplay,
  isUnitedStatesGeography,
  keyForGeography,
  onCommittedSnapshotChange,
  reconcileClusterWithLayerIntent,
  requestCluster,
  requestHorizon,
  requestOcean,
  resolveHorizonForCluster
} from '../src/state/cluster-service';
import { LAYER_DEFS, getLayerDef } from '../src/config/layers';
import { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS, TEMPORAL_HORIZON_KEYS } from '../src/config/clusters';
import { registry } from '../src/state/registry';
import { timeline } from '../src/state/timeline';
import { parseUrlParams } from '../src/state/url';
import {
  getHazardCluster,
  getOceanFraming,
  setHazardCluster
} from '../src/state/cluster-store';
import { setFraming } from '../src/state/framing-store';
import {
  checkedSnapshot,
  onCheckedChange,
  setChecked
} from '../src/ui/island/bridge';
import {
  bindLayerToggleController,
  requestLayerOff,
  requestLayerOn
} from '../src/ui/layer-toggle-command';
import type { LayerController } from '../src/state/layer-controller';

/**
 * S3: the atomic cluster service (the S3 handoff section 5, amended
 * 2026-07-24). Pure Node assertions in the established s1/s2 pattern
 * (the repository's one runner is Playwright; new dependencies are
 * fenced out, so no Vitest).
 *
 * The service is driven through its REAL collaborators: the real
 * registry, timeline, cluster-store, framing-store, and island bridge
 * singletons, plus the real layer-toggle-command door bound to a thin
 * synchronous controller harness that mirrors the observable registry
 * effects of the real controller (loading then terminal status, active
 * set membership). The contract under validation (intent-first flips
 * through the sanctioned door; status truth in the registry) is not
 * mocked away.
 */

const activationLog: Array<{ op: 'activate' | 'deactivate'; key: string }> = [];

const harnessController: LayerController = {
  activate(key: string): Promise<void> {
    activationLog.push({ op: 'activate', key });
    registry.setStatus(key, 'loading');
    registry.activate(key);
    registry.setStatus(key, 'ready');
    return Promise.resolve();
  },
  deactivate(key: string): void {
    activationLog.push({ op: 'deactivate', key });
    registry.deactivate(key);
  },
  applyPreset(): void {
    throw new Error('applyPreset is not part of the S3 path');
  },
  applyLayerSet(): Promise<void> {
    throw new Error('applyLayerSet is not part of the S3 path');
  }
};

bindLayerToggleController(harnessController);

// The sidebar's real wiring, replicated: every checkbox-intent flip
// reconciles the cluster claim (src/ui/sidebar.ts, buildSidebar). This
// is the exact subscription that used to clear a cluster mid-commit
// under the retired S2 mechanics; the specs below prove it no longer
// can.
onCheckedChange(() => {
  const checked = new Set<string>();
  for (const [key, on] of checkedSnapshot()) {
    if (on) checked.add(key);
  }
  reconcileClusterWithLayerIntent(checked);
});

/**
 * Drought's current surface in this spec's world: no framing and no region is
 * the default United States geography, where "now" draws the weekly U.S.
 * Drought Monitor in place of the recipe's North American map (DR-270).
 */
const DROUGHT_NOW = 'usdm';

const REFERENCE_KEYS = LAYER_DEFS.filter(
  (def) => def.defaultOn && def.role !== 'surface'
).map((def) => def.key);

function checkedKeys(): Set<string> {
  const out = new Set<string>();
  for (const [key, on] of checkedSnapshot()) {
    if (on) out.add(key);
  }
  return out;
}

/** Reset the shared singletons to the default-display baseline. */
function resetWorld(): void {
  activationLog.length = 0;
  for (const def of LAYER_DEFS) {
    if (checkedKeys().has(def.key)) setChecked(def.key, false);
  }
  for (const key of registry.getActiveKeys()) registry.deactivate(key);
  timeline.reset();
  setFraming(null);
  setHazardCluster('drought', null);
  requestCluster('drought');
  activationLog.length = 0;
}

test.describe('S3 composeClusterIntent (the composition the URL boot shares)', () => {
  test('every horizon: the reference set survives, the recipe applies, pairs are explicit', () => {
    for (const cluster of Object.keys(HAZARD_CLUSTERS) as Array<
      keyof typeof HAZARD_CLUSTERS
    >) {
      for (const horizon of ['current', 'weeks-ahead', 'season-ahead'] as const) {
        const composed = composeClusterIntent(cluster, horizon);
        for (const key of REFERENCE_KEYS) {
          expect(composed, `${cluster}/${horizon} keeps ${key}`).toContain(key);
        }
        for (const recipeKey of HAZARD_CLUSTERS[cluster].recipes[horizon]) {
          // The recipe's surface, or its stand-in in the United States (DR-270).
          const key = keyForGeography(cluster, recipeKey);
          expect(composed, `${cluster}/${horizon} applies ${key}`).toContain(key);
          // Amendment rule 4: never rely on the controller cascade; a
          // recipe member's co-activation partner is in the intent.
          for (const partner of getLayerDef(key)?.coActivateWith ?? []) {
            expect(composed, `${cluster}/${horizon} pairs ${partner}`).toContain(partner);
          }
        }
        const surfaces = composed.filter((key) => getLayerDef(key)?.role === 'surface');
        expect(surfaces.length, `${cluster}/${horizon} one surface max`).toBeLessThanOrEqual(1);
        expect(new Set(composed).size).toBe(composed.length);
      }
    }
  });

  test('the default horizon is the committed timeline horizon', () => {
    resetWorld();
    expect(composeClusterIntent('wildfire')).toContain('nifc-fires');
    timeline.setHorizon('season-ahead');
    expect(composeClusterIntent('wildfire')).toContain('usfs-whp');
    // DR-022: the live perimeters stay in every horizon.
    expect(composeClusterIntent('wildfire')).toContain('nifc-fires');
    timeline.reset();
  });
});

test.describe('S3 requestCluster (the transaction)', () => {
  test('drought to wildfire: references stay, the old surface deactivates, the pair activates, one coherent snapshot', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      expect(registry.getActiveKeys().has(DROUGHT_NOW)).toBe(true);

      let notified = 0;
      const off = onCommittedSnapshotChange(() => {
        notified += 1;
      });
      requestCluster('wildfire');
      off();

      // The reference set survives the switch, on and checked.
      for (const key of REFERENCE_KEYS) {
        expect(registry.getActiveKeys().has(key), `${key} stays active`).toBe(true);
        expect(checkedKeys().has(key), `${key} stays checked`).toBe(true);
      }
      // The old cluster's exclusive surface is gone.
      expect(registry.getActiveKeys().has(DROUGHT_NOW)).toBe(false);
      expect(checkedKeys().has(DROUGHT_NOW)).toBe(false);
      // The new recipe (the explicit co-pair) is on.
      expect(registry.getActiveKeys().has('nifc-fires')).toBe(true);
      expect(registry.getActiveKeys().has('hms-smoke')).toBe(true);

      // The claim committed and SURVIVED the checkbox-syncing flips
      // (the retired S2 reconciler used to clear it right here).
      expect(getHazardCluster()).toBe('wildfire');

      // One coherent committed snapshot.
      expect(notified).toBeGreaterThanOrEqual(1);
      const snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('wildfire');
      expect(snapshot.horizon).toBe('current');
      expect([...snapshot.intendedKeys].sort()).toEqual(
        [...composeClusterIntent('wildfire', 'current')].sort()
      );
      // No stale non-intended status leaks into the snapshot.
      expect(snapshot.statuses.has(DROUGHT_NOW)).toBe(false);
      expect(snapshot.summary.primary).toContain(
        'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
      );
    } finally {
      dispose();
    }
  });

  test('temporal persistence: a horizon picked inside a mode re-resolves its recipe, and a move into another mode opens on Current', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      // DR-190 as amended 2026-11-13: a move into Wildfire opens on Current Conditions.
      requestCluster('wildfire');
      expect(getCommittedSnapshot().horizon).toBe('current');
      requestHorizon('season-ahead');
      expect(getCommittedSnapshot().horizon).toBe('season-ahead');
      expect(getCommittedSnapshot().intendedKeys.has('usfs-whp')).toBe(true);
      // DR-022: live perimeters in every horizon, Long Range included.
      expect(getCommittedSnapshot().intendedKeys.has('nifc-fires')).toBe(true);

      // Flip clusters: Drought opens on Current Conditions too. A Long Range
      // carried in had drawn the CPC outlook instead of the current drought map
      // (the owner's report of 2026-11-13).
      requestCluster('drought');
      expect(timeline.horizon).toBe('current');
      expect(getCommittedSnapshot().horizon).toBe('current');
      expect(getCommittedSnapshot().intendedKeys.has(DROUGHT_NOW)).toBe(true);
      expect(getCommittedSnapshot().intendedKeys.has('drought')).toBe(false);

      // A horizon picked inside Drought re-resolves its recipe at that horizon.
      requestHorizon('season-ahead');
      expect(getCommittedSnapshot().horizon).toBe('season-ahead');
      expect(getCommittedSnapshot().intendedKeys.has('drought')).toBe(true);
      expect(getCommittedSnapshot().intendedKeys.has(DROUGHT_NOW)).toBe(false);
      // The timeline owns the horizon-to-register mapping.
      expect(timeline.outlookRange).toBe('seasonal');
      requestHorizon('weeks-ahead');
      expect(timeline.outlookRange).toBe('monthly');
    } finally {
      dispose();
      timeline.reset();
    }
  });

  test('ENSO exclusivity: choosing a hazard after ENSO clears the ocean and the SST display', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('enso');
      setHazardCluster('enso', 'pacific');
      expect(getOceanFraming()).toBe('pacific');
      expect(registry.getActiveKeys().has('sst-anomaly')).toBe(true);

      requestCluster('wildfire');
      expect(getOceanFraming()).toBeNull();
      expect(registry.getActiveKeys().has('sst-anomaly')).toBe(false);
      expect(checkedKeys().has('sst-anomaly')).toBe(false);
      expect(getHazardCluster()).toBe('wildfire');
    } finally {
      dispose();
    }
  });

  test('an ocean request commits the ENSO recipe and ocean claim in one revision', () => {
    resetWorld();
    const dispose = initClusterService();
    let publishes = 0;
    const unsubscribe = onCommittedSnapshotChange(() => publishes++);
    try {
      const before = getCommittedSnapshot().revision;
      requestOcean('atlantic');

      const snapshot = getCommittedSnapshot();
      expect(snapshot.revision).toBe(before + 1);
      expect(publishes).toBe(1);
      expect(snapshot.cluster).toBe('enso');
      expect(snapshot.intendedKeys.has('sst-anomaly')).toBe(true);
      expect(registry.getActiveKeys().has('sst-anomaly')).toBe(true);
      expect(getHazardCluster()).toBe('enso');
      expect(getOceanFraming()).toBe('atlantic');
    } finally {
      unsubscribe();
      dispose();
    }
  });

  test('an ocean request preserves a reference extra and demotes the clean ENSO claim', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestLayerOn('hydrography');
      requestOcean('arctic');

      const snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('custom');
      expect(snapshot.intendedKeys.has('sst-anomaly')).toBe(true);
      expect(snapshot.intendedKeys.has('hydrography')).toBe(true);
      expect(registry.getActiveKeys().has('sst-anomaly')).toBe(true);
      expect(registry.getActiveKeys().has('hydrography')).toBe(true);
      expect(getHazardCluster()).toBe('drought');
      expect(getOceanFraming()).toBeNull();
    } finally {
      dispose();
    }
  });

  test('DR-190: an unsupported mode switch commits Current and its recipe in one revision', () => {
    resetWorld();
    const dispose = initClusterService();
    let unsubscribe = () => {};
    try {
      // Wildfire opens on Current; the person then picks Long Range inside it.
      requestCluster('wildfire');
      requestHorizon('season-ahead');
      expect(getCommittedSnapshot().horizon).toBe('season-ahead');
      const revisions: ReturnType<typeof getCommittedSnapshot>[] = [];
      unsubscribe = onCommittedSnapshotChange(() => revisions.push(getCommittedSnapshot()));
      activationLog.length = 0;
      requestCluster('heat');

      const snapshot = getCommittedSnapshot();
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toBe(snapshot);
      expect(snapshot.horizon).toBe('current');
      expect(timeline.horizon).toBe('current');
      expect([...snapshot.intendedKeys].sort()).toEqual(
        [...composeClusterIntent('heat', 'current')].sort()
      );
      expect(snapshot.summary.primary).toContain('HeatRisk');
      expect(registry.getActiveKeys().has('heatrisk')).toBe(true);
      expect(registry.getActiveKeys().has('usfs-whp')).toBe(false);
      expect(registry.getActiveKeys().has('drought')).toBe(false);
      expect(getHazardCluster()).toBe('heat');
    } finally {
      unsubscribe();
      dispose();
      timeline.reset();
    }
  });

  test('DR-190 (amended 2026-11-13): an entry into a mode that opens on Current lands on its current map, not the horizon carried in', () => {
    // The owner's report: Wildfire's Near Term or Long Range carried into
    // Drought showed the CPC outlook instead of the current drought map.
    const opensOnCurrent = HAZARD_CLUSTER_KEYS.filter((key) => HAZARD_CLUSTERS[key].entryHorizon === 'current');
    expect(opensOnCurrent).toContain('drought');
    for (const carried of ['weeks-ahead', 'season-ahead'] as const) {
      for (const destination of opensOnCurrent) {
        // Leave from a mode that can show the carried horizon, so it is really held.
        const source = HAZARD_CLUSTER_KEYS.find(
          (key) => key !== destination && resolveHorizonForCluster(key, carried) === carried
        );
        expect(source, `a mode that shows ${carried}`).toBeDefined();
        if (source === undefined) continue;
        resetWorld();
        const dispose = initClusterService();
        try {
          requestCluster(source);
          requestHorizon(carried);
          expect(timeline.horizon, `${source} holds ${carried}`).toBe(carried);
          requestCluster(destination);
          const snapshot = getCommittedSnapshot();
          const moment = `${source} at ${carried} to ${destination}`;
          expect(snapshot.cluster, moment).toBe(destination);
          expect(snapshot.horizon, moment).toBe('current');
          expect(timeline.horizon, moment).toBe('current');
          expect([...snapshot.intendedKeys].sort(), moment).toEqual(
            [...composeClusterIntent(destination, 'current')].sort()
          );
        } finally {
          dispose();
        }
      }
    }
    // The named case: Wildfire at Long Range or Near Term, then Drought, draws the current drought map.
    for (const carried of ['weeks-ahead', 'season-ahead'] as const) {
      resetWorld();
      const dispose = initClusterService();
      try {
        requestCluster('wildfire');
        requestHorizon(carried);
        requestCluster('drought');
        const snapshot = getCommittedSnapshot();
        expect(snapshot.horizon, carried).toBe('current');
        expect(snapshot.intendedKeys.has(DROUGHT_NOW), carried).toBe(true);
        expect(snapshot.intendedKeys.has('drought'), carried).toBe(false);
        expect(registry.getActiveKeys().has(DROUGHT_NOW), carried).toBe(true);
      } finally {
        dispose();
      }
    }
    // Current holds for a custom set too: Places on does not let Long Range carry in.
    resetWorld();
    const dispose = initClusterService();
    try {
      requestLayerOn('places');
      requestCluster('wildfire');
      requestHorizon('season-ahead');
      expect(timeline.horizon).toBe('season-ahead');
      requestCluster('drought');
      const snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('custom');
      expect(timeline.horizon).toBe('current');
      expect(snapshot.intendedKeys.has(DROUGHT_NOW)).toBe(true);
      expect(snapshot.intendedKeys.has('places')).toBe(true);
      expect(snapshot.intendedKeys.has('drought')).toBe(false);
    } finally {
      dispose();
      requestLayerOff('places');
      timeline.reset();
    }
  });

  test('DR-190: every mode switch resolves the same horizon and recipe as its shared link', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      for (const cluster of HAZARD_CLUSTER_KEYS) {
        for (const horizon of TEMPORAL_HORIZON_KEYS) {
          resetWorld();
          // Set the held horizon before subscribing: this case isolates the
          // destination transaction from the preceding mode's capability.
          timeline.setHorizon(horizon);
          // A press of another mode than the reset one is an entry: its entry
          // horizon replaces the held one (ENSO opens on Season ahead), and
          // the link that press writes says so.
          const entered =
            cluster === getHazardCluster() ? horizon : (HAZARD_CLUSTERS[cluster].entryHorizon ?? horizon);
          Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { location: { search: `?cluster=${cluster}&horizon=${entered}` } }
          });
          const boot = parseUrlParams();
          const dispose = initClusterService();
          try {
            requestCluster(cluster);
            const snapshot = getCommittedSnapshot();
            const moment = `${cluster} from ${horizon}`;
            expect(snapshot.horizon, moment).toBe(boot.horizon);
            expect(timeline.horizon, moment).toBe(boot.horizon);
            expect([...snapshot.intendedKeys].sort(), moment).toEqual([...boot.layers].sort());
            expect([...checkedKeys()].sort(), moment).toEqual([...boot.layers].sort());
          } finally {
            dispose();
          }
        }
      }
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      timeline.reset();
    }
  });

  test('reference extras demote the commit: the URL never claims a cluster the display is not', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      // The user turns a non-default reference layer on (the sidebar
      // path: intent first, then the controller).
      requestLayerOn('hydrography');
      expect(getCommittedSnapshot().cluster).toBe('custom');

      // The cluster press still applies the wildfire recipe...
      requestCluster('wildfire');
      expect(registry.getActiveKeys().has('nifc-fires')).toBe(true);
      expect(registry.getActiveKeys().has('hms-smoke')).toBe(true);
      expect(registry.getActiveKeys().has(DROUGHT_NOW)).toBe(false);
      // ...and the reference extra survives (never deactivated)...
      expect(registry.getActiveKeys().has('hydrography')).toBe(true);
      expect(checkedKeys().has('hydrography')).toBe(true);
      // ...so the claim commits DEMOTED: store absence (layers= truth),
      // snapshot 'custom', the extra folded into the committed intent.
      // A clean 'wildfire' claim here would drop hydrography from the
      // share/reload round-trip (D-0.7.0-044; URL-as-state invariant).
      expect(getHazardCluster()).toBe('drought');
      const snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('custom');
      expect(snapshot.intendedKeys.has('hydrography')).toBe(true);
      expect(snapshot.intendedKeys.has('nifc-fires')).toBe(true);
      expect(snapshot.intendedKeys.has('hms-smoke')).toBe(true);

      // No flap: the checked set equals the committed intent, so the
      // next reconcile pass finds agreement and changes nothing.
      const revisionBefore = getCommittedSnapshot().revision;
      reconcileClusterWithLayerIntent(checkedKeys());
      expect(getCommittedSnapshot().revision).toBe(revisionBefore);
      expect(getCommittedSnapshot().cluster).toBe('custom');

      // Without the extra, the same press commits the clean claim.
      requestLayerOff('hydrography');
      requestCluster('wildfire');
      expect(getHazardCluster()).toBe('wildfire');
      expect(getCommittedSnapshot().cluster).toBe('wildfire');
    } finally {
      dispose();
    }
  });

  test('a committed-horizon change re-resolves in ONE transaction: no revision pairs the new horizon with the old recipe', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      expect(getCommittedSnapshot().horizon).toBe('current');
      expect(getCommittedSnapshot().intendedKeys.has('nifc-fires')).toBe(true);

      // Observe EVERY published revision across the horizon change.
      const observed: Array<{
        horizon: string;
        hasNifc: boolean;
        hasWhp: boolean;
      }> = [];
      const off = onCommittedSnapshotChange(() => {
        const s = getCommittedSnapshot();
        observed.push({
          horizon: s.horizon,
          hasNifc: s.intendedKeys.has('nifc-fires'),
          hasWhp: s.intendedKeys.has('usfs-whp')
        });
      });
      timeline.setHorizon('season-ahead');
      off();

      // Every revision is internally coherent: a season-ahead claim
      // always carries the season-ahead recipe, never the current one.
      expect(observed.length).toBeGreaterThanOrEqual(1);
      for (const rev of observed) {
        if (rev.horizon === 'season-ahead') {
          expect(rev.hasNifc).toBe(true);
          expect(rev.hasWhp).toBe(true);
        } else {
          expect(rev.hasWhp).toBe(false);
        }
      }

      // The final state: same cluster, new horizon, new recipe, and the
      // display flipped with the intent.
      const snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('wildfire');
      expect(snapshot.horizon).toBe('season-ahead');
      expect(snapshot.intendedKeys.has('usfs-whp')).toBe(true);
      expect(snapshot.intendedKeys.has('nifc-fires')).toBe(true);
      expect(getHazardCluster()).toBe('wildfire');
      expect(registry.getActiveKeys().has('usfs-whp')).toBe(true);
      expect(registry.getActiveKeys().has('nifc-fires')).toBe(true);
    } finally {
      dispose();
      timeline.reset();
    }
  });
});

test.describe('S3 snapshot revisions and honesty under later changes', () => {
  test('an intended-layer status change republishes a higher revision with the updated caveat', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      const before = getCommittedSnapshot();

      registry.setStatus('nifc-fires', 'degraded');
      const after = getCommittedSnapshot();
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.summary.caveat).toContain(
        'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC) are live with partial coverage'
      );
    } finally {
      dispose();
    }
  });

  test('a NON-intended status change cannot corrupt the summary (the late-write guard)', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      const before = getCommittedSnapshot();

      // A late status write for the dropped drought surface (the old
      // generation resolving after the switch): at the current horizon the
      // Drought surface here is the weekly U.S. map.
      registry.setStatus(DROUGHT_NOW, 'error');
      const after = getCommittedSnapshot();
      expect(after.revision).toBe(before.revision);
      expect(after.summary.caveat ?? '').not.toContain('Drought Monitor');
      expect(after.statuses.has(DROUGHT_NOW)).toBe(false);
      // Clean up the stray status.
      registry.deactivate(DROUGHT_NOW);
    } finally {
      dispose();
    }
  });

  test('customizing demotes the claim honestly: cluster= comes off, the snapshot reads custom', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      expect(getHazardCluster()).toBe('wildfire');

      // The user checks a layer outside the composition (the sidebar's
      // reconcile subscription is wired above, as in production).
      setChecked('places', true);
      expect(getHazardCluster()).toBe('drought');
      const snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('custom');
      expect(snapshot.intendedKeys.has('places')).toBe(true);
    } finally {
      dispose();
    }
  });

  test('an optional layer keeps the mode: Wildfire plus Fuel risk stays Wildfire at every horizon', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      requestLayerOn('usfs-whp');
      expect(getHazardCluster()).toBe('wildfire');
      expect(getCommittedSnapshot().cluster).toBe('wildfire');
      expect(getCommittedSnapshot().intendedKeys.has('usfs-whp')).toBe(true);

      // Off again from the catalog: back to the composition, still Wildfire.
      requestLayerOff('usfs-whp');
      expect(getCommittedSnapshot().cluster).toBe('wildfire');
      expect([...getCommittedSnapshot().intendedKeys].sort()).toEqual(
        [...composeClusterIntent('wildfire', 'current')].sort()
      );

      // A horizon change re-applies the recipe, so the optional layer follows it.
      requestLayerOn('usfs-whp');
      timeline.setHorizon('weeks-ahead');
      let snapshot = getCommittedSnapshot();
      expect(snapshot.cluster).toBe('wildfire');
      expect(snapshot.horizon).toBe('weeks-ahead');
      expect(checkedKeys().has('usfs-whp')).toBe(false);
      expect(checkedKeys().has('spc-fire-weather')).toBe(true);

      // Near Term: the optional surface stands in for the recipe's surface (the
      // harness controller has no one-surface rule, so the case does its swap).
      requestLayerOn('usfs-whp');
      requestLayerOff('spc-fire-weather');
      snapshot = getCommittedSnapshot();
      expect(getHazardCluster()).toBe('wildfire');
      expect(snapshot.cluster).toBe('wildfire');
      expect(snapshot.horizon).toBe('weeks-ahead');

      // The switch's off press re-applies the recipe: the outlook returns.
      requestCluster('wildfire');
      expect(checkedKeys().has('spc-fire-weather')).toBe(true);
      expect(checkedKeys().has('usfs-whp')).toBe(false);
      expect(getCommittedSnapshot().cluster).toBe('wildfire');
    } finally {
      dispose();
    }
  });

  test('deferred activations: the service stays coherent under a controller that drops stale settles, A -> B -> A (DG-080 finding 5; the real controller drop is proved in tests/stale-generation.test.mjs)', () => {
    // WHAT THIS PROVES: the cluster SERVICE (intent, claim, snapshot
    // revisions) stays coherent when the controller below it settles
    // activations out of order. The controller here is a test-local fake
    // whose `settle` carries the stale drop itself (a settle superseded by
    // a newer per-key request or deactivate is dropped), so this case
    // cannot fail when the production drop breaks; it is not the proof of
    // that drop. The proof of the real controller's drop (the abort at off
    // intent, the per-key operation chain, the intent generation) is
    // tests/stale-generation.test.mjs, which runs the production
    // `createLayerController` under these same service transactions, and the
    // browser case in tests/cluster-controller-integration.spec.ts.
    //
    // The pressure point: a DEFERRED controller whose per-key activations
    // settle out of order (loading at request; active + terminal status
    // only when the op settles). The synchronous harness above cannot
    // exercise this; here the old generation writes late, including for
    // a key that has become intended AGAIN under a newer generation.
    resetWorld();
    const generations = new Map<string, number>();
    interface PendingOp {
      readonly key: string;
      readonly gen: number;
    }
    const pending: PendingOp[] = [];
    const deferredController: LayerController = {
      activate(key: string): Promise<void> {
        const gen = (generations.get(key) ?? 0) + 1;
        generations.set(key, gen);
        registry.setStatus(key, 'loading');
        pending.push({ key, gen });
        return Promise.resolve();
      },
      deactivate(key: string): void {
        // A deactivate supersedes any in-flight activation of the key.
        generations.set(key, (generations.get(key) ?? 0) + 1);
        registry.deactivate(key);
      },
      applyPreset(): void {
        throw new Error('applyPreset is not part of the S3 path');
      },
      applyLayerSet(): Promise<void> {
        throw new Error('applyLayerSet is not part of the S3 path');
      }
    };
    const settle = (op: PendingOp): void => {
      if (generations.get(op.key) !== op.gen) return; // superseded: dropped
      registry.activate(op.key);
      registry.setStatus(op.key, 'ready');
    };

    bindLayerToggleController(deferredController);
    const dispose = initClusterService();
    try {
      const published: Array<{
        cluster: string;
        intended: ReadonlySet<string>;
        statuses: ReadonlyMap<string, string>;
      }> = [];
      const off = onCommittedSnapshotChange(() => {
        const s = getCommittedSnapshot();
        published.push({
          cluster: s.cluster,
          intended: new Set(s.intendedKeys),
          statuses: new Map(s.statuses)
        });
      });

      // Rapid A -> B -> A: wildfire, drought, wildfire, with NOTHING
      // settling in between.
      requestCluster('wildfire');
      const staleFire = pending.splice(0, pending.length);
      requestCluster('drought');
      const staleDrought = pending.splice(0, pending.length);
      requestCluster('wildfire');
      const freshFire = pending.splice(0, pending.length);

      // The OLD generations resolve late, after the same keys became
      // intended again under newer generations: every one is dropped.
      for (const op of [...staleFire, ...staleDrought]) settle(op);
      // The surface the Drought press switched to at the current horizon
      // is the weekly U.S. map here (DROUGHT_NOW).
      expect(registry.getActiveKeys().has(DROUGHT_NOW)).toBe(false);
      expect(registry.getActiveKeys().has('nifc-fires')).toBe(false);
      expect(getCommittedSnapshot().statuses.get('nifc-fires')).toBe('loading');
      // No published snapshot has EVER claimed the pair displayed.
      for (const rev of published) {
        expect(rev.statuses.get('nifc-fires')).not.toBe('ready');
        expect(rev.statuses.get('hms-smoke')).not.toBe('ready');
      }

      // The fresh generation settles: display, intent, claim converge.
      for (const op of freshFire) settle(op);
      expect(registry.getActiveKeys().has('nifc-fires')).toBe(true);
      expect(registry.getActiveKeys().has('hms-smoke')).toBe(true);
      expect(registry.getActiveKeys().has(DROUGHT_NOW)).toBe(false);

      // Final checked intent is exactly the wildfire composition.
      expect([...checkedKeys()].sort()).toEqual(
        [...composeClusterIntent('wildfire', 'current')].sort()
      );
      // Final URL claim: the store still says wildfire (never demoted by
      // the transaction's own flips or the stale settles).
      expect(getHazardCluster()).toBe('wildfire');

      // Every published snapshot was internally coherent: statuses only
      // for intended keys, and a wildfire claim always paired with the
      // wildfire composition.
      const wildfireIntent = new Set(composeClusterIntent('wildfire', 'current'));
      const droughtIntent = new Set(composeClusterIntent('drought', 'current'));
      for (const rev of published) {
        for (const key of rev.statuses.keys()) {
          expect(rev.intended.has(key)).toBe(true);
        }
        if (rev.cluster === 'wildfire') {
          expect([...rev.intended].sort()).toEqual([...wildfireIntent].sort());
        } else if (rev.cluster === 'drought') {
          expect([...rev.intended].sort()).toEqual([...droughtIntent].sort());
        }
      }
      const final = getCommittedSnapshot();
      expect(final.cluster).toBe('wildfire');
      expect(final.statuses.get('nifc-fires')).toBe('ready');
      expect(final.summary.primary).toContain(
        'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
      );
      off();
    } finally {
      dispose();
      bindLayerToggleController(harnessController);
      // Re-settle the world synchronously for any later spec.
      resetWorld();
    }
  });

  test('an explicit uncheck after a terminal activation error also drops the claim (deliberate honesty)', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      expect(getHazardCluster()).toBe('wildfire');

      // A terminal error, then an explicit uncheck: layer-controller.ts's
      // failActivation (near :221-238) keeps a committed-composition
      // member's checkbox and on-intent on failure, so this simulates the
      // user unchecking it themselves, not the controller's own failure
      // path unchecking it.
      registry.setStatus('nifc-fires', 'error');
      registry.deactivate('nifc-fires');
      setChecked('nifc-fires', false);

      // A wildfire display missing its perimeters is not the Wildfire
      // cluster.
      expect(getHazardCluster()).toBe('drought');
      expect(getCommittedSnapshot().cluster).toBe('custom');
    } finally {
      dispose();
    }
  });
});
test.describe('DR-270: Drought "now" follows the committed geography', () => {
  test('what is of the United States: a selected place, else the framing, else the region', () => {
    // No region yet is the default region, the contiguous United States.
    expect(isUnitedStatesGeography(null, null, false)).toBe(true);
    expect(isUnitedStatesGeography(null, 'washington_state', false)).toBe(true);
    expect(isUnitedStatesGeography(null, 'alaska', false)).toBe(true);
    expect(isUnitedStatesGeography(null, 'british_columbia', false)).toBe(false);
    // A framing outranks the region under it; the ALL camera is the continent.
    expect(isUnitedStatesGeography('all', 'national', false)).toBe(false);
    expect(isUnitedStatesGeography('arid-west', 'british_columbia', false)).toBe(true);
    expect(isUnitedStatesGeography('southeast-gulf', 'national', false)).toBe(true);
    expect(isUnitedStatesGeography('hawaii', 'national', false)).toBe(true);
    // A framing that reaches into Canada or Mexico keeps the continental product.
    for (const framing of ['alaska-northwest', 'boreal-arctic', 'pacific-coast', 'plains-prairies', 'eastern-forests', 'mexico'] as const) {
      expect(isUnitedStatesGeography(framing, 'national', false), framing).toBe(false);
    }
    // A selected place outranks both.
    expect(isUnitedStatesGeography('all', 'british_columbia', true)).toBe(true);
  });

  test('the composition draws the stand-in in the United States, and either surface of a pair is the mode', () => {
    expect(composeClusterIntent('drought', 'current', true)).toContain('usdm');
    expect(composeClusterIntent('drought', 'current', true)).not.toContain('nadm-drought');
    expect(composeClusterIntent('drought', 'current', false)).toContain('nadm-drought');
    expect(composeClusterIntent('drought', 'current', false)).not.toContain('usdm');
    // The outlook horizons name no stand-in: the same set either way.
    for (const horizon of ['weeks-ahead', 'season-ahead'] as const) {
      expect(composeClusterIntent('drought', horizon, true)).toEqual(composeClusterIntent('drought', horizon, false));
    }
    expect(keyForGeography('drought', 'nadm-drought', true)).toBe('usdm');
    expect(keyForGeography('drought', 'usdm', false)).toBe('nadm-drought');
    expect(keyForGeography('drought', 'aiannh', true)).toBe('aiannh');
    expect(keyForGeography('wildfire', 'nadm-drought', true)).toBe('nadm-drought');
    for (const us of [true, false]) {
      const shown = new Set(composeClusterIntent('drought', 'current', us));
      expect(isModeDisplay('drought', 'current', shown), `us ${us}`).toBe(true);
      // Neither current surface is the mode's display at an outlook horizon.
      expect(isModeDisplay('drought', 'weeks-ahead', shown), `us ${us}`).toBe(false);
    }
    // The exchange relies on the one-surface rule: every pair is two surfaces.
    for (const mode of HAZARD_CLUSTER_KEYS) {
      for (const [recipeKey, standIn] of Object.entries(HAZARD_CLUSTERS[mode].unitedStatesStandIns ?? {})) {
        expect(getLayerDef(recipeKey)?.role, `${mode} ${recipeKey}`).toBe('surface');
        expect(getLayerDef(standIn)?.role, `${mode} ${standIn}`).toBe('surface');
        expect(
          Object.values(HAZARD_CLUSTERS[mode].recipes).some((recipe) => recipe.some((key) => key === recipeKey)),
          `${mode} names ${recipeKey} in a recipe`
        ).toBe(true);
      }
    }
  });

  test('a link that lists no layers follows its own view; a listed set is shown as written', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const parse = (search: string): Set<string> => {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search } } });
      return parseUrlParams().layers;
    };
    try {
      // The bare boot and a United States region: the weekly U.S. map.
      for (const search of ['', '?region=national', '?region=washington_state', '?framing=arid-west']) {
        expect(parse(search).has('usdm'), search).toBe(true);
        expect(parse(search).has('nadm-drought'), search).toBe(false);
      }
      // A view of Canada, Mexico or the continent: the North American map.
      for (const search of ['?region=british_columbia', '?framing=all', '?framing=mexico', '?framing=pacific-coast']) {
        expect(parse(search).has('nadm-drought'), search).toBe(true);
        expect(parse(search).has('usdm'), search).toBe(false);
      }
      // The bare boot keeps the default set's members and order, the surface exchanged in place.
      expect([...parse('')]).toEqual(
        LAYER_DEFS.filter((def) => def.defaultOn).map((def) => (def.key === 'nadm-drought' ? 'usdm' : def.key))
      );
      // A link that opens a place's briefing draws the product that briefing quotes.
      expect(parse('?framing=mexico&select=state:WA').has('usdm')).toBe(true);
      // A listed set is the person's: shown as written in either geography.
      expect(parse('?region=national&layers=nadm-drought,aiannh').has('nadm-drought')).toBe(true);
      expect(parse('?region=british_columbia&layers=usdm,aiannh').has('usdm')).toBe(true);
      // An outlook horizon and another mode are unchanged by the geography.
      expect([...parse('?horizon=season-ahead')].sort()).toEqual([...parse('?framing=all&horizon=season-ahead')].sort());
      expect([...parse('?cluster=wildfire')].sort()).toEqual([...parse('?cluster=wildfire&framing=all')].sort());
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('a mode press and a horizon change resolve the surface for the geography', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      expect(checkedKeys().has('usdm')).toBe(true);
      // The continental camera, then a re-entry into Drought: the North American map.
      setFraming('all');
      requestCluster('wildfire');
      requestCluster('drought');
      expect(checkedKeys().has('nadm-drought')).toBe(true);
      expect(checkedKeys().has('usdm')).toBe(false);
      expect(getCommittedSnapshot().cluster).toBe('drought');
      // Back from an outlook horizon to Current under a United States framing: the weekly map.
      requestHorizon('season-ahead');
      setFraming('arid-west');
      requestHorizon('current');
      expect(checkedKeys().has('usdm')).toBe(true);
      expect(checkedKeys().has('nadm-drought')).toBe(false);
      expect(getCommittedSnapshot().cluster).toBe('drought');
    } finally {
      dispose();
      setFraming(null);
      timeline.reset();
    }
  });

  test('a committed geography asks for the other surface of the pair that is on, and the mode holds', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      // Nothing to exchange while the geography is unchanged.
      activationLog.length = 0;
      followGeography();
      expect(activationLog).toEqual([]);
      // The continental camera asks for the North American map. This harness
      // controller has no one-surface rule (tests/stale-generation.test.mjs
      // proves the exchange through the real one), so the weekly map is taken
      // off here as the controller would.
      setFraming('all');
      followGeography();
      expect(activationLog).toEqual([{ op: 'activate', key: 'nadm-drought' }]);
      expect(getCommittedSnapshot().cluster, 'both of the pair on, mid-exchange').toBe('drought');
      requestLayerOff('usdm');
      expect(getCommittedSnapshot().cluster).toBe('drought');
      expect(getHazardCluster()).toBe('drought');
      // A display with neither surface on is left alone.
      requestLayerOff('nadm-drought');
      activationLog.length = 0;
      setFraming(null);
      followGeography();
      expect(activationLog).toEqual([]);
      // Another mode's display is not Drought's to exchange.
      requestCluster('wildfire');
      activationLog.length = 0;
      setFraming('all');
      followGeography();
      expect(activationLog).toEqual([]);
    } finally {
      dispose();
      setFraming(null);
      resetWorld();
    }
  });

  test('the newest commitment wins: an opened place outranks the framing under it, and a framing chosen after it outranks the place', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      // Under the continental camera Drought draws the North American map.
      setFraming('all');
      requestCluster('wildfire');
      requestCluster('drought');
      expect(checkedKeys().has('nadm-drought')).toBe(true);
      // A place's briefing opens: the weekly map, the product the briefing quotes, is asked for.
      activationLog.length = 0;
      followPlace();
      expect(activationLog).toEqual([{ op: 'activate', key: 'usdm' }]);
      // (This harness controller has no one-surface rule; the real one takes the other off.)
      requestLayerOff('nadm-drought');
      expect(isUnitedStatesGeography()).toBe(true);
      // Closing the briefing commits nothing: a mode re-entry keeps the place's product.
      requestCluster('wildfire');
      requestCluster('drought');
      expect(checkedKeys().has('usdm')).toBe(true);
      expect(checkedKeys().has('nadm-drought')).toBe(false);
      // A framing chosen after it outranks the place.
      setFraming('mexico');
      activationLog.length = 0;
      followGeography();
      expect(activationLog).toEqual([{ op: 'activate', key: 'nadm-drought' }]);
      expect(isUnitedStatesGeography()).toBe(false);
    } finally {
      dispose();
      setFraming(null);
      resetWorld();
    }
  });
});
