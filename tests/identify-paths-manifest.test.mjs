import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The identify census (tests/identify-paths.spec.ts) checks only the builders
 * tests/identify-paths-manifest.ts lists. The six CPC outlook layers gained
 * their click targets in 4a25794 (src/layers/cpc-seasonal-outlook.ts
 * bindPopups) without a manifest line, so the census never stamped, clicked or
 * tier-checked them. This drives the REAL shipped modules' bindPopups with the
 * coordinator's registration recorded, writes each target as the coordinator
 * stamps it (`kind:layerId,layerId`), and asserts the manifest lists exactly
 * that stamp under the activating layer key. Red on 1589964: no manifest line.
 */

const STUBS = {
  '/map/interaction-coordinator': 'export function registerClickTarget(t) { (globalThis.__manifestTargets ??= []).push(t); }'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(STUBS).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

// The legend registry finds no legend panel here.
globalThis.document = { getElementById: () => null };

const { BUILDERS, eligibleBuilders } = await import('./identify-paths-manifest.ts');

const CPC_OUTLOOK_KEYS = ['cpc-seasonal-precip', 'cpc-seasonal-temp', 'cpc-610-precip', 'cpc-610-temp', 'cpc-814-precip', 'cpc-814-temp'];
const map = { on() {}, getCanvas: () => ({ style: {} }) };

test('each CPC outlook layer\'s registered click target is a browser-eligible manifest line under its own layer key', async () => {
  for (const key of CPC_OUTLOOK_KEYS) {
    globalThis.__manifestTargets = [];
    const module = await import(`../src/layers/${key}.ts`);
    module.bindPopups(map);
    const stamps = globalThis.__manifestTargets.map((t) => `${t.kind}:${t.layerIds.join(',')}`);
    assert.deepEqual(stamps, [`condition-surface:${key}-fill`], `${key} registers one condition-surface target`);
    const lines = eligibleBuilders().filter((b) => b.layerKey === key);
    assert.deepEqual(lines.map((b) => ({ id: b.id, path: b.path, targets: b.targets })), [{ id: key, path: 'coordinated', targets: stamps }], `${key}'s manifest line`);
  }
});

test('builder ids are unique and no stamp is listed twice', () => {
  const ids = BUILDERS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  const targets = BUILDERS.flatMap((b) => b.targets);
  assert.equal(new Set(targets).size, targets.length);
});
