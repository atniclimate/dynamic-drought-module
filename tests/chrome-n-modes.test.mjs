import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// src/config/chip-labels.ts imports `./clusters` extensionless; the same
// resolve hook tests/preset-pressed.test.mjs installs for presets.ts's
// `./clusters` import, so a plain `node --test` still needs no DOM stub.
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

/**
 * S30D D1 M10 (register owner-1h, found-016, found-018, found-019; task
 * DDM-P10-T11; design record interface-chrome-popups-text.md section 2.4,
 * 2.8; DR-113): the chip's label resolves for every HAZARD_CLUSTER_KEYS
 * entry, and its code carries no cluster literal.
 *
 * The label table (KEY_ELIGIBLE_LABELS) used to live as a private const
 * inside src/ui/map-key.ts, a module with many runtime imports (the
 * registry, config/palette, DOM globals) a plain `node --test` cannot load
 * without a resolve hook and a DOM stub. It now lives in
 * src/config/chip-labels.ts, which has one runtime import
 * (src/config/clusters.ts, itself import-free: its sole import is
 * `import type`, erased by Node 24's type stripping), so this file loads
 * both with no resolve hook, the same pattern
 * tests/map-chrome-contract.test.mjs and tests/preset-pressed.test.mjs
 * establish (checked below by import, not by re-deriving the mechanism).
 *
 * Predicted red on the pre-M10 tree: the module import of
 * src/config/chip-labels.ts fails (it does not exist), and the source
 * scan of src/ui/map-key.ts finds the family ternary at the old
 * `map-key.ts:1136` ("family === 'fire' ? 'FIRE' : family === 'heat' ?
 * 'HEAT RISK' : family === 'enso' ? 'ENSO' : ...").
 */

const ROOT = new URL('..', import.meta.url);

const { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS } = await import(
  new URL('src/config/clusters.ts', ROOT).href
);
const { KEY_ELIGIBLE_LABELS, chipFallbackLabel } = await import(
  new URL('src/config/chip-labels.ts', ROOT).href
);
const { chipStateForStatus, aggregateChipState, chipStateFromStatuses } = await import(
  new URL('src/config/chip-state.ts', ROOT).href
);

test('every HAZARD_CLUSTER_KEYS entry resolves a chip label (DR-113, N modes)', () => {
  assert.ok(HAZARD_CLUSTER_KEYS.length >= 4, 'the cluster set unexpectedly shrank');
  for (const mode of HAZARD_CLUSTER_KEYS) {
    const label = chipFallbackLabel(mode);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, `${mode} resolved an empty chip label`);
    // The fallback label is the committed mode's own button word
    // (D-0.7.0-042): the chip never has to invent one.
    assert.equal(label, HAZARD_CLUSTERS[mode].title);
  }
});

test('KEY_ELIGIBLE_LABELS names every value-carrying key with a non-empty word, and NWS alerts replaced Products', () => {
  assert.ok(Object.keys(KEY_ELIGIBLE_LABELS).length > 0);
  for (const [key, label] of Object.entries(KEY_ELIGIBLE_LABELS)) {
    assert.equal(typeof label, 'string', key);
    assert.ok(label.length > 0, `${key} resolved an empty label`);
  }
  assert.equal(
    KEY_ELIGIBLE_LABELS['nws-alerts'],
    'NWS alerts',
    "'Products' becomes 'NWS alerts' (D1.md M10 Notes, check:vocabulary)"
  );
});

test('map-key.ts carries no cluster literal in its chip label path (the retired family ternary)', async () => {
  const text = await readFile(new URL('src/ui/map-key.ts', ROOT), 'utf8');
  // The exact shape the old ternary took: three cluster-family literals
  // feeding a single element's visible text. Any one of these strings
  // appearing as a quoted literal assigned to the toggle is the regression
  // this microtask removes (D1.md M10 Notes: "the ternary at :1136 ...
  // go"); the label now comes from the shared KeySpec/chip-labels table.
  assert.doesNotMatch(
    text,
    /family\s*===\s*'fire'\s*\?\s*'FIRE'/,
    'the retired family ternary is back in map-key.ts'
  );
  assert.doesNotMatch(
    text,
    /textContent\s*=\s*family/,
    'a family-keyed textContent assignment (the retired chip-label ternary) is back'
  );
  // Products the literal string (not the shared table's 'nws-alerts' key)
  // should not remain as a chip fallback label.
  assert.doesNotMatch(
    text,
    /label:\s*'Products'/,
    "a hard-coded 'Products' fallback label is back (should read KEY_ELIGIBLE_LABELS['nws-alerts'])"
  );
  // The label table itself moved out; a second copy here would let the
  // runtime and the Node test drift.
  assert.doesNotMatch(
    text,
    /const\s+KEY_ELIGIBLE_LABELS/,
    'KEY_ELIGIBLE_LABELS is declared locally again instead of imported from src/config/chip-labels.ts'
  );
});

/**
 * Repair round on M10 (director's review): the chip's six-state glyph used
 * to be read back from a KeySpec's own rendered text (`chipStateFromSpec`,
 * a substring match on `ariaLabel`/`itemsHtml` in src/ui/map-key.ts), which
 * the hillshade "no data" coverage note or a partially-loading multi-layer
 * key (the fire key) could falsify. It now reads `registry.getStatus` for
 * the product key(s) the chosen KeySpec actually describes, through the
 * pure functions in src/config/chip-state.ts this file imports directly
 * (no resolve hook needed: its one import, `LayerStatus` from
 * src/types/layer.ts, is `import type`, erased by Node's type stripping).
 *
 * Predicted red on the pre-repair tree: the module import of
 * src/config/chip-state.ts fails (it does not exist), and the source scan
 * below finds `chipStateFromSpec` still live in src/ui/map-key.ts.
 */

test('chipStateForStatus maps every LayerStatus to its chip state', () => {
  assert.equal(chipStateForStatus('ready'), 'live');
  assert.equal(chipStateForStatus('degraded'), 'live-partial');
  assert.equal(chipStateForStatus('error'), 'unavailable');
  assert.equal(chipStateForStatus('no-data'), 'no-data');
  assert.equal(chipStateForStatus('zoom-in'), 'zoom-in');
  assert.equal(chipStateForStatus('loading'), 'loading');
  // An unset status (activated, no setStatus call yet) reads as 'loading',
  // never a silent 'live'.
  assert.equal(chipStateForStatus(undefined), 'loading');
});

test('aggregateChipState: all ready -> live', () => {
  assert.equal(aggregateChipState(['live', 'live']), 'live');
});

test('aggregateChipState: all loading -> loading', () => {
  assert.equal(aggregateChipState(['loading', 'loading']), 'loading');
});

test('aggregateChipState: all error -> unavailable', () => {
  assert.equal(aggregateChipState(['unavailable', 'unavailable']), 'unavailable');
});

test('aggregateChipState: ready plus loading -> live-partial (painted plus not-painted)', () => {
  assert.equal(aggregateChipState(['live', 'loading']), 'live-partial');
});

test('aggregateChipState: error plus no-data -> unavailable (most specific non-painted state)', () => {
  assert.equal(aggregateChipState(['unavailable', 'no-data']), 'unavailable');
});

test('aggregateChipState: empty list -> undefined (no product key backs the spec, no seventh state)', () => {
  assert.equal(aggregateChipState([]), undefined);
});

test('chipStateFromStatuses composes chipStateForStatus with aggregateChipState', () => {
  assert.equal(chipStateFromStatuses(['ready', 'loading']), 'live-partial');
  assert.equal(chipStateFromStatuses([]), undefined);
});

test('map-key.ts derives the chip glyph from registry.getStatus, not from KeySpec text (the retired substring matcher)', async () => {
  const text = await readFile(new URL('src/ui/map-key.ts', ROOT), 'utf8');
  assert.doesNotMatch(
    text,
    /function chipStateFromSpec/,
    'the retired text-substring chip-state matcher is back in map-key.ts'
  );
  assert.doesNotMatch(
    text,
    /text\.includes\('unavailable'\)/,
    "the retired chip-state substring check ('unavailable' in ariaLabel/itemsHtml) is back"
  );
  assert.match(
    text,
    /chipStateFromKeys/,
    'map-key.ts no longer derives the chip state from the registry-backed chipStateFromKeys helper'
  );
});
