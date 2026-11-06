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
  } finally {
    stopService();
    stopReconcile();
  }
});
