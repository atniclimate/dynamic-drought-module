/**
 * The app's defaults, read from `src/config` instead of copied (the 2026-11-22
 * default-coupling audit). Which layers a bare boot shows, which surface a mode
 * draws, and which layers a phone rail button applies are the product's tables;
 * a spec asks this module and follows them. A spec that means one specific
 * layer boots with `?layers=<key>` and types the key instead.
 *
 * Each default is still pinned once, in plain literals, where the owner's
 * ruling is written down: the stand-in exchange and the bare boot in
 * `tests/cluster-service.spec.ts`, the `defaultOn` rows in
 * `tests/e1-calm-logic.spec.ts`. A change of default is then a product edit
 * plus those pins; every other spec follows.
 *
 * This is a separate module so `tests/helpers.ts` keeps importing nothing from
 * `src` (`tests/helper-waits.test.mjs` reads it as text). The guard
 * `tests/default-coupling.test.mjs` keeps specs from copying these again.
 */

import {
  HAZARD_CLUSTERS,
  HAZARD_CLUSTER_KEYS,
  TEMPORAL_HORIZON_KEYS,
  type HazardClusterKey,
  type TemporalHorizonKey
} from '../src/config/clusters';
import { getLayerDef, layerAllowedInMode, LAYER_DEFS, type LayerKey } from '../src/config/layers';
import { MOBILE_HAZARD_PRESETS, type PresetKey } from '../src/config/presets';
import { keyForGeography } from '../src/state/cluster-service';

/**
 * A key as `mode` draws it for the geography. The stand-in table maps layer
 * keys to layer keys (`HazardClusterDef.unitedStatesStandIns`), so the result
 * is a layer key; `keyForGeography` itself is typed over strings.
 */
function drawn(mode: HazardClusterKey, key: LayerKey, us: boolean): LayerKey {
  return keyForGeography(mode, key, us) as LayerKey;
}

/** The mode a layer-less address opens: the table's own entry with no URL token. */
export const DEFAULT_MODE: HazardClusterKey =
  HAZARD_CLUSTER_KEYS.find((key) => HAZARD_CLUSTERS[key].urlToken === null) ?? HAZARD_CLUSTER_KEYS[0]!;

/**
 * The layers `mode` draws at `horizon`, in recipe order, each key as the
 * geography draws it (`us`: the United States, where a recipe surface's
 * stand-in draws; DR-270). The default geography is the United States.
 */
export function modeLayers(
  mode: HazardClusterKey = DEFAULT_MODE,
  horizon: TemporalHorizonKey = 'current',
  us = true
): LayerKey[] {
  return HAZARD_CLUSTERS[mode].recipes[horizon].map((key) => drawn(mode, key, us));
}

/** The one surface-role layer `mode` draws there, or undefined (Extreme Heat at Long Range draws none). */
export function modeSurface(
  mode: HazardClusterKey = DEFAULT_MODE,
  horizon: TemporalHorizonKey = 'current',
  us = true
): LayerKey | undefined {
  return modeLayers(mode, horizon, us).find((key) => getLayerDef(key)?.role === 'surface');
}

/** `modeSurface`, for a spec that needs one: throws when the mode draws no surface there. */
export function requiredSurface(
  mode: HazardClusterKey = DEFAULT_MODE,
  horizon: TemporalHorizonKey = 'current',
  us = true
): LayerKey {
  const surface = modeSurface(mode, horizon, us);
  if (surface === undefined) {
    throw new Error(`${mode} draws no surface at ${horizon} ${us ? 'in' : 'outside'} the United States`);
  }
  return surface;
}

/** Whether `mode` shows `layer` at any horizon, each recipe key taken as the geography draws it. */
export function modeShowsLayer(mode: HazardClusterKey, layer: string, us = true): boolean {
  return TEMPORAL_HORIZON_KEYS.some((horizon) => (modeLayers(mode, horizon, us) as readonly string[]).includes(layer));
}

/** The layers a layer-less Drought boot shows: every `defaultOn` row, the surface as the geography draws it. */
export function defaultLayers(us = true): readonly LayerKey[] {
  return LAYER_DEFS.filter((def) => def.defaultOn).map((def) => drawn(DEFAULT_MODE, def.key, us));
}

/** A phone rail preset's layers as the geography draws them (src/ui/sidebar.ts `applyViewPreset`). */
export function presetLayers(key: PresetKey, us = true): LayerKey[] {
  const preset = MOBILE_HAZARD_PRESETS.find((candidate) => candidate.key === key);
  if (!preset) throw new Error(`no phone rail preset ${key}`);
  return preset.layers.map((layer) => drawn(preset.mode, layer, us));
}

/** The layers a bare boot shows in the default United States geography. */
export const DEFAULT_ON: readonly LayerKey[] = defaultLayers(true);

/** The surface a bare boot draws there ('usdm' since DR-270). Throws at import if the default mode loses its surface. */
export const DEFAULT_SURFACE: LayerKey = requiredSurface();

/**
 * Every surface-role layer the default mode offers a row for (mutually
 * exclusive). A layer kept to another mode (`onlyInMode`, live fuel moisture
 * in Wildfire) has no row under Drought, so it is not listed.
 */
export const SURFACE_KEYS: readonly LayerKey[] = LAYER_DEFS.filter(
  (def) => def.role === 'surface' && layerAllowedInMode(def.key, DEFAULT_MODE)
).map((def) => def.key);
