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

/**
 * S30D D1 M11 (register owner-1h; task DDM-P10-T11; design record
 * interface-chrome-popups-text.md section 2.6, "Sections for N modes";
 * DR-113): every HAZARD_CLUSTER_KEYS entry resolves its detailSections,
 * an ARRAY (possibly empty) whose every key exists in DETAIL_SECTIONS.
 * The registry itself never names a hazard: each DetailSectionDef's own
 * shape (key, heading, nodeId, homeId, pointScoped) is checked, and
 * Heat's declared 'heatrisk-sequence' section is confirmed present (the
 * one section v1 declares).
 *
 * Predicted red on the pre-M11 tree: the module import of
 * src/config/detail-sections.ts fails (it does not exist), and
 * `HAZARD_CLUSTERS[mode].detailSections` is `undefined` for every mode
 * including 'heat' (the field does not exist on HazardClusterDef yet).
 */
const { DETAIL_SECTIONS } = await import(
  new URL('src/config/detail-sections.ts', ROOT).href
);

test('every HAZARD_CLUSTER_KEYS entry resolves its detailSections (DR-113)', () => {
  assert.ok(HAZARD_CLUSTER_KEYS.length >= 4, 'the cluster set unexpectedly shrank');
  let sawHeatSection = false;
  for (const mode of HAZARD_CLUSTER_KEYS) {
    const def = HAZARD_CLUSTERS[mode];
    const sections = def.detailSections ?? [];
    assert.ok(Array.isArray(sections), `${mode}.detailSections is not an array`);
    for (const key of sections) {
      const entry = DETAIL_SECTIONS[key];
      assert.ok(entry, `${mode} declares detail section '${key}', which DETAIL_SECTIONS does not carry`);
      assert.equal(entry.key, key);
      assert.equal(typeof entry.heading, 'string');
      assert.ok(entry.heading.length > 0, `${key}'s heading is empty`);
      assert.equal(typeof entry.nodeId, 'string');
      assert.ok(entry.nodeId.length > 0, `${key}'s nodeId is empty`);
      assert.equal(typeof entry.homeId, 'string');
      assert.ok(entry.homeId.length > 0, `${key}'s homeId is empty`);
      assert.equal(typeof entry.pointScoped, 'boolean');
      if (mode === 'heat' && key === 'heatrisk-sequence') sawHeatSection = true;
    }
  }
  assert.ok(sawHeatSection, "heat's HeatRisk sequence section (HeatRisk first) did not resolve");
});

test('map-key.ts carries no cluster literal in its section-visibility path (DR-113)', async () => {
  const text = await readFile(new URL('src/ui/map-key.ts', ROOT), 'utf8');
  // The drawer's per-cluster gating reads HAZARD_CLUSTERS[cluster] and
  // DETAIL_SECTIONS, not a hard-coded cluster name; this is the shape of
  // a regression that would hard-code 'heat' where the active cluster
  // belongs.
  assert.doesNotMatch(
    text,
    /activeSections\s*=\s*\[['"]heatrisk-sequence['"]\]/,
    'the drawer section list is hard-coded instead of read from HAZARD_CLUSTERS[activeCluster].detailSections'
  );
  assert.match(
    text,
    /HAZARD_CLUSTERS\[activeCluster\]\.detailSections/,
    'map-key.ts no longer reads detailSections from the active HAZARD_CLUSTERS entry'
  );
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

/**
 * S30D D1 M24 (register owner-1k; task DDM-P11-T04; D1.md:145, "The place
 * Conditions block reads a per-cluster `placeConditionRow` (DR-113)"; the
 * director's Tier 1 call 3, 2026-10-01): every HAZARD_CLUSTER_KEYS entry
 * DECLARES its placeConditionRow as an own property; a non-null value is a
 * row the table carries (with its layer keys); a null is deferred with a
 * recorded reason (ENSO's row moves to the ocean sprint, the owner's answer
 * of 2026-10-01); the block's row list is the table-ordered union of the
 * declared rows; and src/ui/popup-conditions.ts carries no literal row list
 * and no cluster-key literal (the block is mode-agnostic: a row is listed
 * whenever its layer is on).
 *
 * Predicted red on a94eee5: the module import of
 * src/config/place-condition-rows.ts fails (ERR_MODULE_NOT_FOUND).
 */
const { PLACE_CONDITION_ROWS, PLACE_CONDITION_ROW_KEYS, PLACE_CONDITION_ROW_DEFERRED, placeConditionRowKeys } =
  await import(new URL('src/config/place-condition-rows.ts', ROOT).href);

test('every HAZARD_CLUSTER_KEYS entry resolves a placeConditionRow (DR-113)', async () => {
  assert.ok(HAZARD_CLUSTER_KEYS.length >= 4, 'the cluster set unexpectedly shrank');
  assert.ok(PLACE_CONDITION_ROW_KEYS.length > 0, 'the place-condition row table is empty');
  const declared = [];
  for (const mode of HAZARD_CLUSTER_KEYS) {
    const def = HAZARD_CLUSTERS[mode];
    assert.ok(
      Object.prototype.hasOwnProperty.call(def, 'placeConditionRow'),
      `${mode} does not declare a placeConditionRow (a row key, or null with a deferral)`
    );
    const row = def.placeConditionRow;
    if (row === null) {
      const reason = Object.prototype.hasOwnProperty.call(PLACE_CONDITION_ROW_DEFERRED, mode)
        ? PLACE_CONDITION_ROW_DEFERRED[mode]
        : undefined;
      assert.equal(typeof reason, 'string', `${mode} has no placeConditionRow and no recorded deferral`);
      assert.ok(reason.trim().length > 0, `${mode}'s deferral reason is empty`);
      continue;
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(PLACE_CONDITION_ROWS, row),
      `${mode} names place-condition row '${row}', which PLACE_CONDITION_ROWS does not carry`
    );
    const entry = PLACE_CONDITION_ROWS[row];
    assert.equal(entry.key, row);
    assert.ok(Array.isArray(entry.layerKeys) && entry.layerKeys.length > 0, `${row} reads no layer`);
    for (const key of entry.layerKeys) assert.equal(typeof key, 'string');
    declared.push(row);
  }
  // A deferral is recorded only for a mode that really declares none.
  for (const mode of Object.keys(PLACE_CONDITION_ROW_DEFERRED)) {
    assert.ok(HAZARD_CLUSTER_KEYS.includes(mode), `a deferral names '${mode}', which is not a mode`);
    assert.equal(HAZARD_CLUSTERS[mode].placeConditionRow, null, `${mode} has a row and a deferral`);
  }
  // The block's rows: the union of the declared rows, in table order.
  const union = PLACE_CONDITION_ROW_KEYS.filter((key) => declared.includes(key));
  assert.deepEqual(placeConditionRowKeys(HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS), union);
  // Mode-agnostic and N-mode: a synthetic table of any size enumerates the same way.
  const synthetic = { a: { placeConditionRow: union[union.length - 1] }, b: { placeConditionRow: null }, c: { placeConditionRow: union[0] } };
  assert.deepEqual(placeConditionRowKeys(synthetic, ['a', 'b', 'c']), union.length > 1 ? [union[0], union[union.length - 1]] : [union[0]]);
  assert.deepEqual(placeConditionRowKeys(synthetic, ['b']), []);

  const text = await readFile(new URL('src/ui/popup-conditions.ts', ROOT), 'utf8');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(
    code,
    /\[\s*NADM_KEY\s*,\s*USDM_KEY\s*,\s*ALERTS_KEY\s*,\s*FIRES_KEY\s*\]/,
    'the literal condition-layer list is back in popup-conditions.ts (derive it from the declared rows)'
  );
  // The NIFC incident-type class 'wildfire' (src/config/wildfire-presentation.ts
  // classifyNifcIncidentType) shares a spelling with a cluster key and is not
  // one; its one comparison is set aside before the cluster-literal scan.
  const clusterScan = code.replace(/classifyNifcIncidentType\([^)]*\)\s*===\s*'wildfire'/g, '');
  for (const mode of HAZARD_CLUSTER_KEYS) {
    assert.doesNotMatch(
      clusterScan,
      new RegExp(`['"\`]${mode}['"\`]`),
      `popup-conditions.ts carries the cluster-key literal '${mode}' (DR-113: read the cluster table)`
    );
  }
  assert.match(code, /placeConditionRowKeys\(/, 'popup-conditions.ts does not assemble its rows from placeConditionRowKeys');
});
