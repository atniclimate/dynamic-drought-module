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
 *
 * Embed lines are COMPOSED from what actually activated, never static
 * claims: embeds hide the sidebar (control notes and legends), so the
 * orchestrator prints these one-line vintage-and-caveat statements with
 * the mode's own notes directly on the map surface, and a line may only
 * describe surfaces genuinely in the scene (a partial power activation
 * names only its live half).
 */

import type maplibregl from 'maplibre-gl';

import { activateFuelsDrape, deactivateFuelsDrape } from '../layers/fuels-3d';
import { getPowerContextState } from '../state/power-context';
import type { PowerContextState } from '../state/power-context';
import {
  activateStructures,
  deactivateStructures
} from '../layers/structures-3d';

/** Stable keys for the context layers, in activation order. */
export type Fire3DContextKey = 'fuels' | 'power' | 'structures';

/** What the orchestrator publishes: the active keys, and one embed
 * disclosure line per active key describing exactly what is rendered. */
export interface Fire3DContextActivation {
  readonly keys: readonly Fire3DContextKey[];
  readonly embedLines: readonly string[];
}

const FUELS_EMBED_LINE =
  'Fuel colors: LANDFIRE 2024 fuel model classes, a translucent static snapshot at reduced resolution.';

/** Exported for the disclosure cross-gate test beside the archive. */
export const STRUCTURES_EMBED_LINE =
  'Buildings: Overture footprints (ODbL), central Oregon pilot bake only, drawn from zoom 13; dimmer buildings draw at a disclosed placeholder height.';

/** Compose the power embed line from the surfaces actually in the scene. */
export function buildPowerEmbedLine(state: PowerContextState): string {
  const parts = [
    ...(state.linesOn
      ? ['HIFLD transmission lines (archived, last updated 2024-09-30)']
      : []),
    ...(state.plantsOn
      ? [`EIA power plants (reporting period ${state.periodLabel ?? 'unreported'})`]
      : [])
  ];
  return `Power: ${parts.join(' and ')}; not for siting or safety decisions.`;
}

const EMPTY_ACTIVATION: Fire3DContextActivation = {
  keys: [],
  embedLines: []
};

/**
 * Activate every context layer, tolerating individual failures. Returns
 * the keys that actually activated plus their truthful embed lines (the
 * orchestrator publishes both). The signal aborts in-flight probes and
 * fetches when the mode tears down mid-activation.
 */
export async function activateContextLayers(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<Fire3DContextActivation> {
  const keys: Fire3DContextKey[] = [];
  const embedLines: string[] = [];

  try {
    if (await activateFuelsDrape(map, signal)) {
      keys.push('fuels');
      embedLines.push(FUELS_EMBED_LINE);
    }
  } catch (err) {
    console.warn('[fire3d-context] the fuels drape failed to activate.', err);
  }

  // Power infrastructure is a CATALOG layer since 2026-08-19 (owner
  // direction): one toggle governs it in every view, including this one,
  // and it is off by default. This orchestrator therefore never activates
  // it. It only READS whether the layer is currently rendering, so the 3D
  // scene's embed disclosure keeps describing exactly what is on screen.
  const power = getPowerContextState();
  if (power !== null) {
    keys.push('power');
    embedLines.push(buildPowerEmbedLine(power));
  }

  try {
    if (await activateStructures(map, signal)) {
      keys.push('structures');
      embedLines.push(STRUCTURES_EMBED_LINE);
    }
  } catch (err) {
    console.warn('[fire3d-context] the structures context failed to activate.', err);
  }

  if (signal.aborted) {
    deactivateContextLayers(map);
    return EMPTY_ACTIVATION;
  }
  return { keys, embedLines };
}

/**
 * Remove every context layer this orchestrator owns. Power is deliberately
 * absent: it is a catalog layer with its own lifecycle, and tearing it down
 * when the 3D scene exits would silently turn off something the person
 * switched on.
 */
export function deactivateContextLayers(map: maplibregl.Map): void {
  deactivateFuelsDrape(map);
  deactivateStructures(map);
}
