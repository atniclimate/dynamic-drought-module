import { test, expect } from '@playwright/test';

import { LAYER_KEYS, LAYER_DEFS, getLayerDef, resolveExclusiveSurface } from '../src/config/layers';
import { PRESET_KEYS, MOBILE_HAZARD_PRESETS, VIEW_PRESETS } from '../src/config/presets';
import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { parseUrlParams } from '../src/state/url';

/**
 * DDM-P1-T05: `LAYER_KEYS` in src/config/layers.ts is the one authority
 * `LayerDef.key` and `LayerDef.coActivateWith` are typed from, and
 * `PRESET_KEYS` in src/config/presets.ts is the same kind of authority for
 * preset keys. A union derived from a value list cannot prove, at compile
 * time, that the list still matches the table it describes: a stale or
 * missing entry in `LAYER_KEYS` or `PRESET_KEYS` would still typecheck as
 * long as it agrees with itself. These are the runtime half of that proof,
 * importing the real modules and checking each list against the tables it
 * is meant to authorize: layers, presets and cluster recipes alike.
 *
 * Browser-free (`verify:pure`, DR-052 b): no fixture, no boot helper, only
 * imports from src/ and assertions on returned values.
 */

test('LAYER_KEYS is frozen so a caller cannot mutate the authority at runtime', () => {
  expect(
    Object.isFrozen(LAYER_KEYS),
    'LAYER_KEYS must be frozen (Object.freeze) in src/config/layers.ts so the ' +
      'authority list cannot be mutated after module load'
  ).toBe(true);
});

test('LAYER_KEYS and LAYER_DEFS have the same length', () => {
  expect(
    LAYER_KEYS.length,
    `LAYER_KEYS has ${LAYER_KEYS.length} entries but LAYER_DEFS has ` +
      `${LAYER_DEFS.length}; add or remove an entry in LAYER_KEYS (src/config/layers.ts) ` +
      'so the two lists have the same length before checking their contents'
  ).toBe(LAYER_DEFS.length);
});

test('every LAYER_KEYS entry appears exactly once in LAYER_DEFS', () => {
  const defKeys = LAYER_DEFS.map((def) => def.key);
  for (const key of LAYER_KEYS) {
    const occurrences = defKeys.filter((defKey) => defKey === key).length;
    expect(
      occurrences,
      `LAYER_KEYS entry "${key}" appears ${occurrences} times in LAYER_DEFS ` +
        '(expected exactly 1); either LAYER_KEYS holds a stale key no longer ' +
        'in LAYER_DEFS, or LAYER_DEFS has a duplicate key, in src/config/layers.ts'
    ).toBe(1);
  }
});

test('every LAYER_DEFS entry key appears in LAYER_KEYS', () => {
  const authoritySet = new Set<string>(LAYER_KEYS);
  for (const def of LAYER_DEFS) {
    expect(
      authoritySet.has(def.key),
      `LAYER_DEFS key "${def.key}" is missing from LAYER_KEYS; add it to ` +
        'the LAYER_KEYS list in src/config/layers.ts so the authority stays ' +
        'in step with the catalog'
    ).toBe(true);
  }
});

test('every coActivateWith entry names a key that exists in LAYER_KEYS', () => {
  const authoritySet = new Set<string>(LAYER_KEYS);
  for (const def of LAYER_DEFS) {
    for (const partner of def.coActivateWith ?? []) {
      expect(
        authoritySet.has(partner),
        `layer "${def.key}" lists coActivateWith partner "${partner}", which ` +
          'is not in LAYER_KEYS; fix the typo in that layer\'s coActivateWith ' +
          'entry, or add the partner key to LAYER_KEYS, in src/config/layers.ts'
      ).toBe(true);
    }
  }
});

test('every preset layer key (MOBILE_HAZARD_PRESETS and VIEW_PRESETS) exists in LAYER_KEYS', () => {
  const authoritySet = new Set<string>(LAYER_KEYS);
  const allPresets = [...MOBILE_HAZARD_PRESETS, ...VIEW_PRESETS];
  for (const preset of allPresets) {
    for (const layerKey of preset.layers) {
      expect(
        authoritySet.has(layerKey),
        `preset "${preset.key}" lists layer "${layerKey}", which is not in ` +
          'LAYER_KEYS; fix the typo in that preset\'s layers entry, or add the ' +
          'key to LAYER_KEYS, in src/config/layers.ts'
      ).toBe(true);
    }
  }
});

test('every cluster recipe layer key (HAZARD_CLUSTERS) exists in LAYER_KEYS', () => {
  const authoritySet = new Set<string>(LAYER_KEYS);
  for (const [clusterKey, clusterDef] of Object.entries(HAZARD_CLUSTERS)) {
    for (const [horizon, layerKeys] of Object.entries(clusterDef.recipes)) {
      for (const layerKey of layerKeys) {
        expect(
          authoritySet.has(layerKey),
          `cluster "${clusterKey}" horizon "${horizon}" recipe lists layer ` +
            `"${layerKey}", which is not in LAYER_KEYS; fix the typo in that ` +
            'recipe entry, or add the key to LAYER_KEYS, in src/config/layers.ts'
        ).toBe(true);
      }
    }
  }
});

test('PRESET_KEYS has the same length as MOBILE_HAZARD_PRESETS plus VIEW_PRESETS', () => {
  const allPresets = [...MOBILE_HAZARD_PRESETS, ...VIEW_PRESETS];
  expect(
    PRESET_KEYS.length,
    `PRESET_KEYS has ${PRESET_KEYS.length} entries but MOBILE_HAZARD_PRESETS ` +
      `plus VIEW_PRESETS has ${allPresets.length}; add or remove an entry in ` +
      'PRESET_KEYS (src/config/presets.ts) so the two lists have the same ' +
      'length before checking their contents'
  ).toBe(allPresets.length);
});

test('PRESET_KEYS has no stale key (every PRESET_KEYS entry names a real preset)', () => {
  const allPresets = [...MOBILE_HAZARD_PRESETS, ...VIEW_PRESETS];
  const presetKeySet = new Set(allPresets.map((preset) => preset.key));
  for (const key of PRESET_KEYS) {
    expect(
      presetKeySet.has(key),
      `PRESET_KEYS entry "${key}" names no preset in MOBILE_HAZARD_PRESETS or ` +
        'VIEW_PRESETS; remove the stale entry from PRESET_KEYS in ' +
        'src/config/presets.ts'
    ).toBe(true);
  }
});

test('PRESET_KEYS has no missing key (every preset key is named in PRESET_KEYS)', () => {
  const authoritySet = new Set<string>(PRESET_KEYS);
  const allPresets = [...MOBILE_HAZARD_PRESETS, ...VIEW_PRESETS];
  for (const preset of allPresets) {
    expect(
      authoritySet.has(preset.key),
      `preset key "${preset.key}" (from MOBILE_HAZARD_PRESETS or VIEW_PRESETS) ` +
        'is missing from PRESET_KEYS; add it to PRESET_KEYS in ' +
        'src/config/presets.ts'
    ).toBe(true);
  }
});

/**
 * The other half of the DDM-P1-T05 acceptance sentence: "external URL
 * parsing still accepts and validates strings". `parseUrlParams` (unlike
 * the four internal tables above) reads `window.location.search`, so it
 * needs a minimal `window` stub to run in this browser-free lane; the
 * stub carries only `location.search`, restored after each case (the
 * wildfire-source-semantics.spec.ts pattern), so no other test's Node
 * environment is affected.
 *
 * Read at src/state/url.ts:267-345 and src/config/layers.ts:349-361
 * before trusting this comment: `parseUrlParams` does NOT filter unknown
 * `layers=` entries itself (its own doc comment at :255-258 says so: "Unknown
 * layer keys are passed through unfiltered: the calling code (the
 * LayerRegistry, on activation) is responsible for rejecting them"), and
 * `resolveExclusiveSurface` does not reject unknown keys either; it only
 * enforces the one-surface-at-a-time rule among keys that DO resolve to a
 * `role: 'surface'` definition. Neither function throws on an unrecognized
 * string. The cases below assert that observed behavior, not the
 * "dropped" wording a description of this boundary might use informally.
 */
function withUrlSearch<T>(search: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { search } }
  });
  try {
    return run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'window', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

test('parseUrlParams accepts a layers= value naming a real key', () => {
  const parsed = withUrlSearch('?layers=nadm-drought', () => parseUrlParams());
  expect([...parsed.layers]).toEqual(['nadm-drought']);
});

test('parseUrlParams does not throw on a layers= value naming no real key, and passes it through unvalidated', () => {
  const parsed = withUrlSearch('?layers=not-a-real-layer-key', () => parseUrlParams());
  // Not dropped at THIS boundary (that would require validating against
  // LAYER_KEYS here); passed through as an ordinary string for the layer
  // registry to reject on activation. getLayerDef, the runtime lookup
  // that DOES validate, confirms the string names nothing real.
  expect([...parsed.layers]).toEqual(['not-a-real-layer-key']);
  expect(getLayerDef('not-a-real-layer-key')).toBeNull();
});

test('parseUrlParams keeps a real key and an unrecognized key side by side from a mixed layers= value', () => {
  const parsed = withUrlSearch('?layers=nadm-drought,not-a-real-layer-key', () => parseUrlParams());
  expect([...parsed.layers].sort()).toEqual(['nadm-drought', 'not-a-real-layer-key'].sort());
});

test('resolveExclusiveSurface takes readonly string[], not LayerKey[]: an arbitrary runtime string passes through unchanged', () => {
  // A behavioral check, not a type check: the point is that this call
  // compiles and runs for a value that is not a member of LAYER_KEYS,
  // which a LayerKey-typed parameter could not accept.
  const arbitrary = 'a value no layer will ever be named, chosen at runtime';
  expect(resolveExclusiveSurface([arbitrary])).toEqual([arbitrary]);
});

test('resolveExclusiveSurface enforces one-surface-at-a-time among real keys while leaving an unrecognized key untouched', () => {
  // 'nadm-drought' and 'drought' both resolve to role: 'surface'
  // (src/config/layers.ts); the second is dropped. The unrecognized key
  // is neither a surface nor known at all, so it is neither deduplicated
  // nor rejected: it rides through exactly as parseUrlParams left it.
  const result = resolveExclusiveSurface(['nadm-drought', 'aiannh', 'drought', 'not-a-real-layer-key']);
  expect(result).toEqual(['nadm-drought', 'aiannh', 'not-a-real-layer-key']);
});

test('no preset key appears twice across MOBILE_HAZARD_PRESETS and VIEW_PRESETS combined', () => {
  const allPresets = [...MOBILE_HAZARD_PRESETS, ...VIEW_PRESETS];
  const seen = new Map<string, number>();
  for (const preset of allPresets) {
    const count = (seen.get(preset.key) ?? 0) + 1;
    seen.set(preset.key, count);
  }
  for (const [key, count] of seen) {
    expect(
      count,
      `preset key "${key}" appears ${count} times across MOBILE_HAZARD_PRESETS ` +
        'and VIEW_PRESETS combined (expected exactly 1); either rename one of ' +
        'the presets or, if the duplication is deliberate, this assertion ' +
        'needs revisiting'
    ).toBe(1);
  }
});
