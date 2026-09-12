/**
 * DDM-P1-T05 microtask 3: this file is SUPPOSED to fail typechecking.
 *
 * It exists to prove, on purpose and on every run, that a typo in one of
 * the four internal key tables (LAYER_KEYS / LayerKey, PRESET_KEYS /
 * PresetKey, and the LayerKey-typed cluster recipes) is a compiler error,
 * not a silent drift. It is excluded from `tsconfig.json`'s `include`
 * (that list names only `src/**` and `vite.config.ts`, never `tests/**`),
 * so `npm run typecheck` never sees it and stays clean. It is checked on
 * its own, under `tsconfig.key-typos.json`, by `npm run check:key-types`
 * (scripts/check-key-types.mjs), which asserts the OPPOSITE of a normal
 * check: it fails if this file compiles cleanly, because that would mean
 * a union widened back to `string` and stopped catching typos.
 *
 * Do not "fix" the four typos below. Each one is deliberate, named in a
 * comment on its own line, and its line number is pinned in the EXPECTED
 * table at the top of scripts/check-key-types.mjs; the fixture and that
 * table are edited together.
 */

import type { LayerDef } from '../../src/config/layers';
import type { ViewPreset } from '../../src/config/presets';
import type { HazardClusterDef } from '../../src/config/clusters';

// Case 1: a catalog key typo. LayerDef.key is typed from LAYER_KEYS
// (src/config/layers.ts LayerKey); 'hydrograpy' is not a member.
const catalogKeyTypo: LayerDef = {
  key: 'hydrograpy', // TYPO: should be 'hydrography'
  name: 'Hydrography (typo fixture, never rendered)',
  source: 'fixture',
  role: 'reference',
  defaultOn: false,
  load: async () => {
    throw new Error('fixture only, never invoked');
  }
};

// Case 2: a coactivation typo. LayerDef.coActivateWith is typed as
// `readonly LayerKey[]`; 'hms-smoke-typo' is not a member.
const coActivationTypo: LayerDef = {
  key: 'nifc-fires',
  name: 'Fire perimeters (typo fixture, never rendered)',
  source: 'fixture',
  role: 'event',
  defaultOn: false,
  coActivateWith: ['hms-smoke-typo'], // TYPO: should be 'hms-smoke'
  load: async () => {
    throw new Error('fixture only, never invoked');
  }
};

// Case 3: a preset typo. ViewPreset.key is typed from PRESET_KEYS
// (src/config/presets.ts PresetKey); 'hazard-fier' is not a member.
const presetKeyTypo: ViewPreset = {
  key: 'hazard-fier', // TYPO: should be 'hazard-fire'
  label: 'Fire (typo fixture, never rendered)',
  description: 'fixture',
  layers: ['nifc-fires']
};

// Case 4: a cluster recipe typo. HazardClusterDef.recipes values are
// typed as `readonly LayerKey[]`; 'nifc-fires-typo' is not a member.
const clusterRecipeTypo: HazardClusterDef = {
  title: 'Fixture (never rendered)',
  urlToken: 'fixture',
  description: 'fixture',
  recipes: {
    current: ['nifc-fires-typo'], // TYPO: should be 'nifc-fires'
    'weeks-ahead': [],
    'season-ahead': []
  }
};

// Referenced so `noUnusedLocals` cannot add a fifth, unrelated error that
// would confuse the four-typo line count above.
export const ALL_TYPOS = [catalogKeyTypo, coActivationTypo, presetKeyTypo, clusterRecipeTypo];
