import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
        typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  }
});
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS } =
  await import('../src/config/clusters.ts');
const palette = await import('../src/config/palette.ts');
const wildfire = await import('../src/config/wildfire-presentation.ts');

// D3 palette-tokens section 9 T1 F/G vocabulary. "issuer" identifies a
// source-table role, not a scientific receipt or verification of its colors.
// These are current recipe-member classifications; adding a mode does not
// assign it a color. Source value pins remain in palette-contract.test.mjs.
const ENTRIES = {
  NADM_CATEGORIES: { module: palette, classification: 'issuer' },
  DROUGHT_COLORS: { module: palette, classification: 'issuer' },
  NIFC_INCIDENT_PRESENTATION: { module: wildfire, classification: 'derived-mark' },
  HMS_DENSITY_PRESENTATION: { module: wildfire, classification: 'transform' },
  SPC_FIREWX_CATEGORIES: { module: palette, classification: 'issuer' },
  USFS_WHP_PRESENTATION: { module: wildfire, classification: 'issuer' },
  HEATRISK_CATEGORIES: { module: palette, classification: 'issuer' },
  NWS_ALERT_COLORS: { module: palette, classification: 'issuer' },
  SST_ANOMALY_SCALE: { module: palette, classification: 'issuer' }
};
const MEMBERS = {
  'nadm-drought': { entry: 'NADM_CATEGORIES', classification: 'issuer' },
  drought: { entry: 'DROUGHT_COLORS', classification: 'issuer' },
  'nifc-fires': { entry: 'NIFC_INCIDENT_PRESENTATION', classification: 'derived-mark' },
  'hms-smoke': { entry: 'HMS_DENSITY_PRESENTATION', classification: 'transform' },
  'spc-fire-weather': { entry: 'SPC_FIREWX_CATEGORIES', classification: 'issuer' },
  'usfs-whp': { entry: 'USFS_WHP_PRESENTATION', classification: 'issuer' },
  heatrisk: { entry: 'HEATRISK_CATEGORIES', classification: 'issuer' },
  'nws-alerts': { entry: 'NWS_ALERT_COLORS', classification: 'issuer' },
  'sst-anomaly': { entry: 'SST_ANOMALY_SCALE', classification: 'issuer' }
};

function classifyRecipes(clusters, keys, horizons, members = MEMBERS) {
  assert.deepEqual([...keys].sort(), Object.keys(clusters).sort(), 'enumerated modes cover the actual table');
  const visited = [];
  for (const key of keys) {
    const cluster = clusters[key];
    assert.ok(cluster, 'missing mode ' + key);
    assert.deepEqual(Object.keys(cluster.recipes).sort(), [...horizons].sort(), key + ': all horizons');
    for (const horizon of horizons) {
      const recipe = cluster.recipes[horizon];
      assert.ok(Array.isArray(recipe), key + '/' + horizon + ': recipe');
      const entries = recipe.map(layer => {
        const member = members[layer];
        assert.ok(member, key + '/' + horizon + ': unclassified layer ' + layer);
        const entry = ENTRIES[member.entry];
        assert.ok(entry, layer + ': unknown classification entry ' + member.entry);
        assert.ok(Object.hasOwn(entry.module, member.entry), layer + ': missing actual source export');
        assert.equal(member.classification, entry.classification,
          layer + ': classification does not match ' + member.entry);
        return { layer, entry: member.entry, classification: member.classification };
      });
      visited.push({ key, horizon, entries });
    }
  }
  return visited;
}

test('G: every configured mode and horizon maps its actual recipe members to classified entries', () => {
  const visited = classifyRecipes(HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS);
  assert.equal(visited.length, HAZARD_CLUSTER_KEYS.length * TEMPORAL_HORIZON_KEYS.length);
  const actualMembers = [...new Set(visited.flatMap(row => row.entries.map(entry => entry.layer)))].sort();
  assert.deepEqual(actualMembers, Object.keys(MEMBERS).sort(), 'no stale or silently absent member classifications');
});

function extraMode(layer, horizon) {
  const key = '__synthetic_next_mode';
  assert.ok(!Object.hasOwn(HAZARD_CLUSTERS, key));
  return {
    key,
    keys: [...HAZARD_CLUSTER_KEYS, key],
    clusters: {
      ...HAZARD_CLUSTERS,
      [key]: { recipes: Object.fromEntries(TEMPORAL_HORIZON_KEYS.map(h => [h, h === horizon ? [layer] : []])) }
    }
  };
}
test('G: an additional mode is traversed without any fixed mode count', () => {
  const fixture = extraMode('nadm-drought', TEMPORAL_HORIZON_KEYS.at(-1));
  const visited = classifyRecipes(fixture.clusters, fixture.keys, TEMPORAL_HORIZON_KEYS);
  assert.deepEqual(visited.filter(row => row.key === fixture.key).map(row => row.horizon), [...TEMPORAL_HORIZON_KEYS]);
  assert.deepEqual(visited.at(-1).entries, [
    { layer: 'nadm-drought', entry: 'NADM_CATEGORIES', classification: 'issuer' }
  ]);
});
test('G negative control: an unclassified additional-mode member is rejected in every horizon', () => {
  for (const horizon of TEMPORAL_HORIZON_KEYS) {
    const fixture = extraMode('__unclassified_fixture_layer', horizon);
    assert.throws(() => classifyRecipes(fixture.clusters, fixture.keys, TEMPORAL_HORIZON_KEYS),
      { message: fixture.key + '/' + horizon + ': unclassified layer __unclassified_fixture_layer' });
  }
});
test('G negative control: a current member misclassified as issuer is rejected', () => {
  // HMS density opacity is a DDM transform, not an issuer-defined color table.
  // Exercise the identical validator against an actual configured recipe.
  const changed = { ...MEMBERS, 'hms-smoke': { ...MEMBERS['hms-smoke'], classification: 'issuer' } };
  assert.throws(() => classifyRecipes(HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS, changed),
    { message: /^hms-smoke: classification does not match HMS_DENSITY_PRESENTATION\n/ });
});
