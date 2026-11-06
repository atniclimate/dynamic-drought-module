import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The look at 035eed5, R2-4: a Place studio round trip reset a custom set's
 * hazard to Drought. The studio captured the store's cluster, which reads
 * Drought for every custom set, and the restore wrote it over the person's
 * hazard, so Wildfire plus Hydrography came back as Drought and the sidebar's
 * listener (sidebar.ts, `selectedHazard !== 'wildfire'`) dropped the 3D view.
 *
 * Drives the REAL display-snapshot capture and restore over the REAL cluster
 * service, island bridge and toggle door, with no controller bound (the door
 * records checkbox intent only) and the sidebar's reconcile wiring mirrored.
 * Red on 035eed5: a publish during the restore reads Drought.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const service = await import('../src/state/cluster-service.ts');
const bridge = await import('../src/ui/island/bridge.ts');
const { getHazardCluster } = await import('../src/state/cluster-store.ts');
const { beginPlaceStudioDisplay, restoreDisplaySnapshot } = await import('../src/state/display-snapshot.ts');
const timelineModule = await import('../src/state/timeline.ts');
const { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');

const checkedKeys = () => new Set([...bridge.checkedSnapshot()].filter(([, on]) => on).map(([key]) => key));

test('a Place studio round trip keeps a custom set\'s hazard: Wildfire plus Hydrography comes back Wildfire', () => {
  const stopReconcile = bridge.onCheckedChange(() => service.reconcileClusterWithLayerIntent(checkedKeys()));
  const stopService = service.initClusterService();
  try {
    service.requestCluster('wildfire');
    bridge.setChecked('hydrography', true);
    assert.equal(service.getCommittedSnapshot().cluster, 'custom', 'setup: a custom set inside Wildfire');
    assert.equal(getHazardCluster(), 'drought', 'setup: its store claim reads Drought');
    assert.equal(service.getSelectedHazard(), 'wildfire');
    const before = checkedKeys();

    const published = [];
    const stopRecord = service.onCommittedSnapshotChange(() => published.push(service.getCommittedSnapshot().selectedHazard));
    try {
      beginPlaceStudioDisplay('tribe');
      restoreDisplaySnapshot();
    } finally {
      stopRecord();
    }
    assert.ok(published.length > 0, 'setup: the round trip published');
    assert.deepEqual([...new Set(published)], ['wildfire'], 'no publish on the way reads another hazard');
    assert.equal(service.getSelectedHazard(), 'wildfire');
    assert.equal(service.getCommittedSnapshot().cluster, 'custom', 'the set is still honestly custom');
    assert.deepEqual(checkedKeys(), before, 'the display came back whole');

    // R6-6 on the restored (derived) custom set: Hydrography off again is Wildfire again.
    bridge.setChecked('hydrography', false);
    assert.equal(service.getCommittedSnapshot().cluster, 'wildfire', 'a restored custom set returns to its mode');
    assert.equal(getHazardCluster(), 'wildfire');
  } finally {
    stopService();
    stopReconcile();
  }
});

/**
 * Audit round 6, R6-6: a layer turned on and off again left a custom set whose
 * layers were exactly the person's mode, so the mode stayed unpressed, the
 * other horizons stayed locked and the link kept `layers=`. Red on f27a23c:
 * the set stays custom and the store reads Drought.
 */
test('a layer turned on and off again returns the display to the person\'s mode, in every mode but ENSO', () => {
  const stopReconcile = bridge.onCheckedChange(() => service.reconcileClusterWithLayerIntent(checkedKeys()));
  const stopService = service.initClusterService();
  const { timeline } = timelineModule;
  try {
    for (const mode of HAZARD_CLUSTER_KEYS) {
      timeline.reset();
      service.requestCluster('drought');
      service.requestCluster(mode);
      const horizon = timeline.horizon;
      bridge.setChecked('places', true);
      assert.equal(service.getCommittedSnapshot().cluster, 'custom', `${mode}: setup, a custom set`);
      bridge.setChecked('places', false);
      // shortcut pinned: ENSO's store write would refit the Pacific and drop its ocean (cluster-service.ts).
      const back = mode === 'enso' ? 'custom' : mode;
      assert.equal(service.getCommittedSnapshot().cluster, back, `${mode}: off again`);
      assert.equal(getHazardCluster(), mode === 'enso' ? 'drought' : mode, `${mode}: the store claim`);
      assert.equal(service.getSelectedHazard(), mode);
      assert.equal(service.getCommittedSnapshot().horizon, horizon, `${mode}: the horizon holds`);
    }

    // A demoted entry: City labels on, then the press, then City labels off.
    timeline.reset();
    service.requestCluster('drought');
    bridge.setChecked('places', true);
    service.requestCluster('wildfire');
    assert.equal(service.getCommittedSnapshot().cluster, 'custom', 'setup: the press commits demoted');
    bridge.setChecked('places', false);
    assert.equal(service.getCommittedSnapshot().cluster, 'wildfire');
    assert.equal(getHazardCluster(), 'wildfire');

    // A horizon the mode cannot show keeps the set custom: Extreme Heat has no Season ahead map.
    timeline.reset();
    service.requestCluster('drought');
    service.requestCluster('heat');
    bridge.setChecked('places', true);
    service.requestHorizon('season-ahead');
    for (const key of HAZARD_CLUSTERS.heat.recipes.current) bridge.setChecked(key, false);
    bridge.setChecked('places', false);
    assert.deepEqual([...checkedKeys()].sort(), [...service.composeClusterIntent('heat', 'season-ahead')].sort());
    assert.equal(service.getCommittedSnapshot().cluster, 'custom', 'Season ahead is not a horizon Extreme Heat resolves to');
  } finally {
    stopService();
    stopReconcile();
    timelineModule.timeline.reset();
    service.requestCluster('drought');
  }
});
