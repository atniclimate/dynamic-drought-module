import { test, expect } from '@playwright/test';

import {
  composeClusterIntent,
  getCommittedSnapshot,
  initClusterService,
  onCommittedSnapshotChange,
  reconcileClusterWithLayerIntent,
  requestCluster,
  requestOcean
} from '../src/state/cluster-service';
import { LAYER_DEFS, getLayerDef } from '../src/config/layers';
import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { registry } from '../src/state/registry';
import { timeline } from '../src/state/timeline';
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
  },
  ensureActive(): void {
    throw new Error('ensureActive is not part of the S3 path');
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
        for (const key of HAZARD_CLUSTERS[cluster].recipes[horizon]) {
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
    expect(composeClusterIntent('wildfire')).not.toContain('nifc-fires');
    timeline.reset();
  });
});

test.describe('S3 requestCluster (the transaction)', () => {
  test('drought to wildfire: references stay, the old surface deactivates, the pair activates, one coherent snapshot', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      expect(registry.getActiveKeys().has('nadm-drought')).toBe(true);

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
      expect(registry.getActiveKeys().has('nadm-drought')).toBe(false);
      expect(checkedKeys().has('nadm-drought')).toBe(false);
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
      expect(snapshot.statuses.has('nadm-drought')).toBe(false);
      expect(snapshot.summary.primary).toContain(
        'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
      );
    } finally {
      dispose();
    }
  });

  test('temporal persistence: the committed horizon survives cluster flips and re-resolves each recipe', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      timeline.setHorizon('season-ahead');
      requestCluster('wildfire');
      expect(getCommittedSnapshot().horizon).toBe('season-ahead');
      expect(getCommittedSnapshot().intendedKeys.has('usfs-whp')).toBe(true);
      expect(getCommittedSnapshot().intendedKeys.has('nifc-fires')).toBe(false);

      // Flip clusters: the register persists; the flip re-resolves at
      // the same horizon.
      requestCluster('drought');
      expect(timeline.horizon).toBe('season-ahead');
      expect(getCommittedSnapshot().horizon).toBe('season-ahead');
      expect(getCommittedSnapshot().intendedKeys.has('drought')).toBe(true);
      expect(getCommittedSnapshot().intendedKeys.has('usdm')).toBe(false);
      // The timeline owns the horizon-to-register mapping.
      expect(timeline.outlookRange).toBe('seasonal');
      timeline.setHorizon('weeks-ahead');
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

  test('the empty recipe: heat at season-ahead commits references only plus the honest caveat, no faked surface', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      timeline.setHorizon('season-ahead');
      // The horizon change itself re-resolves the committed drought
      // cluster at season-ahead (its own transaction, covered by the
      // horizon-coherence spec below); this test asserts only what the
      // HEAT transaction activates.
      activationLog.length = 0;
      requestCluster('heat');

      const snapshot = getCommittedSnapshot();
      expect([...snapshot.intendedKeys].sort()).toEqual([...REFERENCE_KEYS].sort());
      expect(snapshot.summary.primary).toContain('No verified Extreme Heat surface');
      // NOTHING with a surface or event role was activated.
      for (const entry of activationLog) {
        if (entry.op !== 'activate') continue;
        expect(getLayerDef(entry.key)?.role).toBe('reference');
      }
      expect(registry.getActiveKeys().has('heatrisk')).toBe(false);
      expect(registry.getActiveKeys().has('usdm')).toBe(false);
      expect(getHazardCluster()).toBe('heat');
    } finally {
      dispose();
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
      expect(registry.getActiveKeys().has('usdm')).toBe(false);
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
          expect(rev.hasNifc).toBe(false);
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
      expect(snapshot.intendedKeys.has('nifc-fires')).toBe(false);
      expect(getHazardCluster()).toBe('wildfire');
      expect(registry.getActiveKeys().has('usfs-whp')).toBe(true);
      expect(registry.getActiveKeys().has('nifc-fires')).toBe(false);
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
        'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC) is live with partial coverage'
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
      // generation resolving after the switch).
      registry.setStatus('usdm', 'error');
      const after = getCommittedSnapshot();
      expect(after.revision).toBe(before.revision);
      expect(after.summary.caveat ?? '').not.toContain('US Drought Monitor');
      expect(after.statuses.has('usdm')).toBe(false);
      // Clean up the stray status.
      registry.deactivate('usdm');
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

  test('deferred activations: rapid cluster switching drops stale generations and every snapshot stays coherent (DG-080 finding 5)', () => {
    // The named async-race pressure point: a DEFERRED controller whose
    // per-key activations settle out of order, mirroring the real
    // controller's observable behavior (loading at request; active +
    // terminal status only when the op settles; a settle superseded by
    // a newer per-key request or deactivate is DROPPED, the real
    // per-key generation guard). The synchronous harness above cannot
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
      },
      ensureActive(): void {
        throw new Error('ensureActive is not part of the S3 path');
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
      expect(registry.getActiveKeys().has('usdm')).toBe(false);
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
      expect(registry.getActiveKeys().has('usdm')).toBe(false);

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

  test('a terminal activation failure that unchecks a recipe member also drops the claim (deliberate honesty)', () => {
    resetWorld();
    const dispose = initClusterService();
    try {
      requestCluster('wildfire');
      expect(getHazardCluster()).toBe('wildfire');

      // The controller's failure path: terminal error, checkbox off.
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
