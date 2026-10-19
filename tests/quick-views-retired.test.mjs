import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Quick views chip row is retired (owner review, 2026-10-19): each mode
 * opens with its own layers, and the chips only added clutter. The phone
 * hazard rail stays. This file proves the row and its pressed rule are gone
 * from the preset table, the markup and the stylesheet, and that the preset
 * key authority now lists exactly the rail's keys.
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
const { PRESET_KEYS, MOBILE_HAZARD_PRESETS } = presets;

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('presets.ts exports no chip-row table or pressed rule', () => {
  assert.equal(presets.VIEW_PRESETS, undefined);
  assert.equal(presets.isPresetShowing, undefined);
});

test('PRESET_KEYS lists exactly the hazard rail keys, in rail order', () => {
  assert.deepEqual(
    [...PRESET_KEYS],
    MOBILE_HAZARD_PRESETS.map((preset) => preset.key)
  );
});

test('no rail preset declares a horizon', () => {
  for (const preset of MOBILE_HAZARD_PRESETS) {
    assert.equal(Object.hasOwn(preset, 'horizon'), false, preset.key);
  }
});

test('the markup and the stylesheet carry no Quick views row', () => {
  const html = read('../index.html');
  assert.doesNotMatch(html, /panel-quick-views|preset-chips/);
  const css = read('../src/styles/app.css');
  assert.doesNotMatch(css, /\.preset-chip|#panel-quick-views/);
});
