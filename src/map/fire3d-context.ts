/**
 * Context layers for the desktop 3D Fire mode: issuer-published landscape
 * context draped into the terrain scene while the mode is active.
 *
 * This module is the single lazy chunk the fire3d orchestrator imports
 * after terrain succeeds; each context layer inside it is a presentation
 * companion (the hms-smoke-volume pattern), never a LAYER_DEFS entry, and
 * every one of them is NON-fatal by contract: a missing archive or failed
 * fetch degrades that one layer and nothing else. Layers ride the one
 * fire3d activation rather than their own toggles (the honest-and-less-
 * chrome fork of the W-CTX run; the losing argument, independent per-layer
 * toggles, is recorded in the pull request).
 *
 * The honesty boundary for everything in this chunk: show each issuer's
 * published context exactly as published, one issuer, one legend per
 * layer; compute nothing across layers. The always-visible non-prediction
 * disclosure in the 3D Fire control (FIRE3D_NON_PREDICTION_NOTE) is the
 * user-facing statement of that boundary.
 */

import type maplibregl from 'maplibre-gl';

import { activateFuelsDrape, deactivateFuelsDrape } from '../layers/fuels-3d';

/** Stable keys for the context layers, in activation order. */
export type Fire3DContextKey = 'fuels';

/**
 * Activate every context layer, tolerating individual failures. Returns
 * the keys that actually activated (the orchestrator publishes them as
 * production-observable truth). The signal aborts in-flight probes and
 * fetches when the mode tears down mid-activation.
 */
export async function activateContextLayers(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<readonly Fire3DContextKey[]> {
  const active: Fire3DContextKey[] = [];

  try {
    if (await activateFuelsDrape(map, signal)) active.push('fuels');
  } catch (err) {
    console.warn('[fire3d-context] the fuels drape failed to activate.', err);
  }

  if (signal.aborted) {
    deactivateContextLayers(map);
    return [];
  }
  return active;
}

/** Remove every context layer. Defensive; safe when never activated. */
export function deactivateContextLayers(map: maplibregl.Map): void {
  deactivateFuelsDrape(map);
}
