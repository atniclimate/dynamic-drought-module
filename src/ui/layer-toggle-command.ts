/**
 * The shared UI-level layer toggle command (ADR 0002 condition 2,
 * D-0.7.0-008).
 *
 * One DOM-free door for every caller that is not the catalog checkbox
 * itself: the time bar's instrument switches (usdm's switchToOutlook,
 * drought's switchToObserved), the ENSO driver's "View the Pacific",
 * the sidebar's telemetry click-through, and the U1 conditions tiles.
 * It synchronizes the catalog checkbox intent (the island bridge)
 * BEFORE calling the layer controller, exactly as the island's own
 * change handler does, so the checkbox, the registry, the URL, and the
 * pills can never disagree; and because it never touches `document`, it
 * works in the window before the lazy island mounts (the spike's Codex
 * adversarial finding: a `querySelector` door silently no-ops there).
 *
 * The controller reference is bound once by `buildSidebar` at boot.
 * Callers before that bind (there are none; boot order is load-bearing)
 * degrade to recording intent in the bridge only.
 *
 * Kept free of preact and layer-module imports: this module is eager
 * (imported by the sidebar) and must stay entry-chunk light.
 */

import type { LayerController } from '../state/layer-controller';
import { registry } from '../state/registry';
import { isChecked, setChecked } from './island/bridge';

let controller: LayerController | null = null;

/** Bind the one controller instance. Called once from `buildSidebar`. */
export function bindLayerToggleController(c: LayerController): void {
  controller = c;
}

/** A layer reads "on" when its row is checked or it is registered active
 * (the checkbox leads the registry while an activation is in flight). */
function isOn(key: string): boolean {
  return isChecked(key) || registry.getActiveKeys().has(key);
}

/**
 * Turn a layer on if the recorded INTENT is not already on. Deliberately
 * intent-only (never `isOn`): a layer whose off-toggle is still draining
 * through the per-key op chain is registry-active with its checkbox
 * unchecked, and during that window a re-on request must proceed, not
 * silently no-op (found 2026-07-15, the Unit I session: a quick
 * outlook-to-Observed jump landed in usdm's teardown window and died;
 * the URL serializes intent, so nothing else re-triggered it). The
 * controller's serialized op chain and the modules' idempotent activate
 * contract make the re-entry safe. Surface exclusivity, the per-key op
 * chain, the intent guards, and the loading indicator all live in the
 * controller; this command only records the checkbox intent first, as
 * every existing activation path does.
 */
export function requestLayerOn(key: string): void {
  if (isChecked(key)) return;
  setChecked(key, true);
  void controller?.activate(key);
}

/** Turn a layer off if it is on, through the same serialized path. */
export function requestLayerOff(key: string): void {
  if (!isOn(key)) return;
  setChecked(key, false);
  controller?.deactivate(key);
}
