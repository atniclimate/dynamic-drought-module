/**
 * Layer add/remove fade transitions.
 *
 * MapLibre animates paint properties when a `*-transition` is set on them,
 * but adding or removing a layer is instant, and the layer modules remove
 * their layers on deactivate. The sidebar's serialized per-key activation
 * path is therefore the seam: it calls `fadeInLayers` after a module's
 * `activate` resolves and awaits `fadeOutLayers` before calling
 * `deactivate`, so toggles ease instead of popping while the per-key op
 * chain keeps the fade race-free (a queued re-activation waits for the
 * fade plus removal to finish).
 *
 * Modules declare which map layers they render through the optional
 * `fadeLayerIds` export on the LayerModule contract (src/config/layers.ts).
 * Ids absent from the map are skipped, so a stale id costs nothing; the
 * telemetry module renders DOM markers instead of style layers and owns its
 * own presentation (a CSS insert animation in app.css).
 *
 * Honesty and accessibility: the fade is presentation only; it never
 * invents a state, and it delays the registry/pill off-transition by at
 * most the fade duration. Users with `prefers-reduced-motion: reduce` get
 * the previous instant behavior.
 */

import type maplibregl from 'maplibre-gl';

import { prefersReducedMotion } from './motion';

import { sleepUnlessAborted } from './fetch';

/** Fade duration; matches the 0.12s-0.25s transition range in app.css. */
export const LAYER_FADE_MS = 200;

/**
 * The opacity paint property per layer type. Only types the module suite
 * actually renders (fill, line, raster) plus the two likely next arrivals
 * (circle, symbol) are listed; an unlisted type simply does not fade.
 */
const OPACITY_PROPS: Readonly<Record<string, readonly string[]>> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  raster: ['raster-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  symbol: ['icon-opacity', 'text-opacity']
};

/** The opacity props for a layer id, or an empty list if it is absent. */
function opacityProps(map: maplibregl.Map, id: string): readonly string[] {
  const layer = map.getLayer(id);
  if (!layer) return [];
  return OPACITY_PROPS[layer.type] ?? [];
}

/**
 * Ease a just-activated module's layers from transparent to their spec
 * opacity. Runs synchronously (the animation is MapLibre's); call it right
 * after `activate` resolves, before the next frame renders.
 *
 * Only plain-number opacity values are faded: a data-driven opacity
 * expression cannot be dipped to zero and restored without a per-feature
 * jump, so expression-valued props keep today's instant appearance.
 */
export function fadeInLayers(
  map: maplibregl.Map,
  ids: readonly string[] | undefined
): void {
  if (!ids || prefersReducedMotion()) return;
  for (const id of ids) {
    for (const prop of opacityProps(map, id)) {
      const target: unknown = map.getPaintProperty(id, prop) ?? 1;
      if (typeof target !== 'number' || target <= 0) continue;
      map.setPaintProperty(id, `${prop}-transition`, { duration: 0, delay: 0 });
      map.setPaintProperty(id, prop, 0);
      map.setPaintProperty(id, `${prop}-transition`, {
        duration: LAYER_FADE_MS,
        delay: 0
      });
      map.setPaintProperty(id, prop, target);
    }
  }
}

/**
 * Ease a module's layers to transparent and resolve once the fade has
 * played, so the caller can then remove the layers without a visible pop.
 * Resolves immediately when there is nothing to fade or the user prefers
 * reduced motion. The zeroed opacities are not restored; the modules
 * re-add their layers with spec paint values on the next activation.
 */
export async function fadeOutLayers(
  map: maplibregl.Map,
  ids: readonly string[] | undefined
): Promise<void> {
  if (!ids || prefersReducedMotion()) return;
  let faded = false;
  for (const id of ids) {
    for (const prop of opacityProps(map, id)) {
      const current: unknown = map.getPaintProperty(id, prop) ?? 1;
      if (typeof current !== 'number' || current <= 0) continue;
      map.setPaintProperty(id, `${prop}-transition`, {
        duration: LAYER_FADE_MS,
        delay: 0
      });
      map.setPaintProperty(id, prop, 0);
      faded = true;
    }
  }
  if (!faded) return;
  // Small buffer past the nominal duration so the last frame lands before
  // the caller removes the layers.
  await sleepUnlessAborted(LAYER_FADE_MS + 50, null);
}
