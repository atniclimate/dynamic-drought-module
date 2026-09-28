import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * D1 M6 (2026-09-27; found-005, DDM-P10-T09): the quick-view pressed rule.
 *
 * A quick-view chip reads `aria-pressed="true"` exactly while the committed
 * display's intended layer keys EQUAL the preset's layers as a set AND,
 * when the preset declares a horizon, the committed horizon equals it
 * (`isPresetShowing` in src/config/presets.ts). The chip wiring in
 * src/ui/sidebar.ts only feeds it the committed shell snapshot; this file
 * proves the rule itself over every VIEW_PRESETS entry with synthetic
 * snapshots: the exact set, a superset, a subset, a reordered set, and
 * every horizon in TEMPORAL_HORIZON_KEYS against the declared one.
 *
 * Runs under plain `node --test` (Node 24 strips the types). presets.ts has
 * one runtime import (`./clusters`, extensionless), so the resolve hook from
 * tests/boot-idle-seam.test.mjs is the whole environment: no DOM stub.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const presets = await import('../src/config/presets.ts');
const { TEMPORAL_HORIZON_KEYS } = await import('../src/config/clusters.ts');
const { VIEW_PRESETS } = presets;

/** A key no preset names, for the superset case. */
const EXTRA_KEY = 'd1-m6-synthetic-extra-key';

function snapshot(keys, horizon) {
  return { intendedKeys: new Set(keys), horizon };
}

/** The horizons the rule must accept for a preset's exact set. */
function acceptedHorizons(preset) {
  return preset.horizon === undefined ? [...TEMPORAL_HORIZON_KEYS] : [preset.horizon];
}

test('the rule is exported as a function', () => {
  assert.equal(typeof presets.isPresetShowing, 'function');
});

test('the table has both kinds of quick view, so no case below is vacuous', () => {
  assert.ok(
    VIEW_PRESETS.some((preset) => preset.horizon !== undefined),
    'no VIEW_PRESETS entry declares a horizon'
  );
  assert.ok(
    VIEW_PRESETS.some((preset) => preset.horizon === undefined),
    'every VIEW_PRESETS entry declares a horizon'
  );
  for (const preset of VIEW_PRESETS) {
    if (preset.horizon === undefined) continue;
    assert.ok(
      TEMPORAL_HORIZON_KEYS.includes(preset.horizon),
      `${preset.key} declares "${preset.horizon}", not a TEMPORAL_HORIZON_KEYS member`
    );
  }
});

test('the exact set reads pressed at the declared horizon (any horizon when none is declared)', () => {
  for (const preset of VIEW_PRESETS) {
    for (const horizon of acceptedHorizons(preset)) {
      assert.equal(
        presets.isPresetShowing(preset, snapshot(preset.layers, horizon)),
        true,
        `${preset.key} at ${horizon}`
      );
    }
  }
});

test('the exact set in another order still reads pressed (a set, not a list)', () => {
  for (const preset of VIEW_PRESETS) {
    const reversed = [...preset.layers].reverse();
    for (const horizon of acceptedHorizons(preset)) {
      assert.equal(presets.isPresetShowing(preset, snapshot(reversed, horizon)), true, preset.key);
    }
  }
});

test('a superset of the preset does not read pressed', () => {
  for (const preset of VIEW_PRESETS) {
    for (const horizon of acceptedHorizons(preset)) {
      assert.equal(
        presets.isPresetShowing(preset, snapshot([...preset.layers, EXTRA_KEY], horizon)),
        false,
        `${preset.key} plus an extra key at ${horizon}`
      );
    }
  }
});

test('a subset of the preset does not read pressed', () => {
  for (const preset of VIEW_PRESETS) {
    for (let drop = 0; drop < preset.layers.length; drop += 1) {
      const subset = preset.layers.filter((_, index) => index !== drop);
      for (const horizon of acceptedHorizons(preset)) {
        assert.equal(
          presets.isPresetShowing(preset, snapshot(subset, horizon)),
          false,
          `${preset.key} without ${preset.layers[drop]} at ${horizon}`
        );
      }
    }
    assert.equal(
      presets.isPresetShowing(preset, snapshot([], acceptedHorizons(preset)[0])),
      false,
      `${preset.key} over an empty display`
    );
  }
});

test('a declared horizon must match: the exact set at any other horizon does not read pressed', () => {
  for (const preset of VIEW_PRESETS) {
    if (preset.horizon === undefined) continue;
    for (const horizon of TEMPORAL_HORIZON_KEYS) {
      assert.equal(
        presets.isPresetShowing(preset, snapshot(preset.layers, horizon)),
        horizon === preset.horizon,
        `${preset.key} (declares ${preset.horizon}) at ${horizon}`
      );
    }
  }
});
