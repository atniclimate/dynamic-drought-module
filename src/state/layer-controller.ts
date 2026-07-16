/**
 * Layer-activation state machine for the Dynamic Drought Module (DDM).
 *
 * Extracted from `src/ui/sidebar.ts` in phase 0.6.0 (the spine extraction,
 * decision D-ARCH-004; docs/ARCH_UX_PATHWAY_1.0.md appendix A). The sidebar
 * kept the activation logic since the vanilla port; this module now owns it
 * so the view layer (vanilla today, a possible Preact island in 0.7.0) can be
 * reshaped without touching the activation contract, and so the domain no
 * longer reaches into a 1,200-line UI god module for it.
 *
 * This is a PURE REFACTOR: the logic, guards, ordering, and comments carry
 * over from the sidebar verbatim in intent. The one change is that the DOM
 * couplings (reading and writing layer checkboxes, clearing a status pill,
 * announcing to the live region) are inverted through the `LayerControllerView`
 * adapter the sidebar supplies, instead of being done inline with
 * `document.querySelector`. No behavior change; the existing Playwright specs
 * prove it (docs/ARCH_UX_PATHWAY_1.0.md appendix A test strategy).
 *
 * What stays in the sidebar: DOM construction (region buttons, toggle rows,
 * preset chips, telemetry list), the status-pill and live-region DOM, region
 * selection, URL sync, and telemetry value hydration. The controller emits
 * registry changes only; the sidebar's registry subscriptions drive the URL,
 * the active-count pill, the per-layer pills, and the telemetry-value
 * lifecycle exactly as before.
 *
 * The controller imports `showLoading` / `hideLoading` from `../ui/overlay`;
 * that is a frozen UI-service facade (D-ARCH-004, appendix B), the same
 * inverted seam the ADR documents, kept stable rather than eliminated in 0.6.0.
 *
 * Stewardship: no Tribal, Treaty, or sovereign-jurisdiction data is surfaced
 * here. Layer identity and ordering come from the config tables in
 * `src/config/`.
 */

import maplibregl from 'maplibre-gl';

import {
  LAYER_DEFS,
  getLayerDef,
  loadLayerModule,
  getLoadedLayerModule
} from '../config/layers';
import type { LayerDef, LayerModule } from '../config/layers';
import type { ViewPreset } from '../config/presets';
import { registry } from './registry';
import { reassertLabelOrder } from '../map/layer-order';
import { fadeInLayers, fadeOutLayers } from '../util/layer-fade';
import { showLoading, hideLoading } from '../ui/overlay';

/**
 * The DOM operations the activation machine needs, supplied by the sidebar so
 * the controller stays free of `document`. Each method is a thin adapter over
 * the sidebar's existing DOM helpers:
 *
 *   - `setCheckbox` / `isCheckboxChecked` read and write a layer row's
 *     checkbox by its `data-layer-key`; a missing checkbox is a no-op read
 *     (false) or write, which preserves the old `if (cb)` guards and the
 *     detached-checkbox fallback the URL-boot path used.
 *   - `clearLayerStatus` resets a row's status pill to its empty
 *     pre-activation state.
 *   - `announce` writes a sentence to the polite live region.
 */
export interface LayerControllerView {
  setCheckbox(key: string, checked: boolean): void;
  isCheckboxChecked(key: string): boolean;
  clearLayerStatus(key: string): void;
  announce(message: string): void;
}

/**
 * The activation contract the sidebar (and any future view layer) drives:
 *
 *   - `activate` turns a layer on, enforcing the one-surface-at-a-time rule
 *     for surface-role layers.
 *   - `deactivate` turns a layer off.
 *   - `applyPreset` makes the active set equal a preset's layer list.
 *   - `applyLayerSet` activates a set of keys (the URL/default boot path).
 *   - `ensureActive` is fire-and-forget activation (void, not awaited).
 */
export interface LayerController {
  activate(key: string): Promise<void>;
  deactivate(key: string): void;
  applyPreset(preset: ViewPreset): void;
  applyLayerSet(keys: Iterable<string>): Promise<void>;
  ensureActive(key: string): void;
}

/**
 * Build the layer controller for a map, driving DOM through `view`. One
 * controller instance per app; its intent map, per-key operation chains, and
 * popup-bound set are private to the closure (they were module-level globals
 * in the sidebar; scoping them here changes nothing behaviorally, there being
 * exactly one controller).
 */
export function createLayerController(
  map: maplibregl.Map,
  view: LayerControllerView
): LayerController {
  /**
   * The latest per-layer user intent (on or off), recorded synchronously the
   * moment a toggle, preset, or deep-link path asks for a change. The queued
   * operations below consult it at every await boundary, so an operation the
   * user has since reversed (toggled off while the chunk import or the
   * activation fetch was in flight) becomes a no-op instead of resurrecting a
   * turned-off layer into the registry and the URL.
   */
  const desiredOn = new Map<string, boolean>();

  /**
   * Monotonic intent generation per key, bumped on EVERY intent flip (on or
   * off). A queued activation captures the generation it was born under and
   * stands down after any await if a newer flip occurred, even when the
   * boolean intent has aliased back to true (a rapid off/on while the
   * original activation fetch was being cancelled). Without this, the
   * cancelled original could pass the boolean check, register a layer whose
   * fetch never completed (no source on the map), and starve the queued real
   * reactivation (Codex Unit B re-verify finding 1, 2026-07-15,
   * C:\dev\_reviews\ddm\2026-07-15_unit-B-codex-reverify.md).
   */
  const intentGen = new Map<string, number>();

  /** Record an intent flip: bump the key's generation, set the boolean. */
  function bumpIntent(key: string, on: boolean): number {
    const gen = (intentGen.get(key) ?? 0) + 1;
    intentGen.set(key, gen);
    desiredOn.set(key, on);
    return gen;
  }

  /**
   * Per-layer operation chain: activations and deactivations for one key run
   * strictly in sequence. Without this, a rapid off/on could overlap a
   * module's `activate()` with itself (tribal and treaty throw on a duplicate
   * source id) or with its own `deactivate()`. Chains are per key, so distinct
   * layers still activate in parallel.
   */
  const layerOpChain = new Map<string, Promise<void>>();

  /** Layers whose bindPopups has already run (once, on first activation). */
  const popupsBound = new Set<string>();

  function enqueueLayerOp(key: string, op: () => Promise<void> | void): Promise<void> {
    const prev = layerOpChain.get(key) ?? Promise.resolve();
    // Run after the prior op regardless of how it settled; each op carries its
    // own error handling, so the chain itself never sticks in a rejected state.
    const next = prev.then(op, op);
    layerOpChain.set(key, next);
    return next;
  }

  /**
   * Bind a layer's popup click handlers on its first activation. Popups are no
   * longer bound at boot (that would pull every layer module into the initial
   * bundle); binding once here, guarded, matches the old survive-toggle-cycles
   * behavior, and MapLibre tolerates a handler bound before its layer exists.
   */
  function ensurePopupsBound(key: string, mod: LayerModule): void {
    if (popupsBound.has(key)) return;
    if (mod.bindPopups) mod.bindPopups(map);
    popupsBound.add(key);
  }

  /**
   * Activate a layer with a loading-indicator token around the call. Updates
   * the registry on success; unchecks the checkbox on failure.
   *
   * The registry is set to `loading` before the activation so the status pill
   * updates immediately; the layer module is responsible for setting its own
   * `ready`, `error`, `no-data`, or `zoom-in` once it finishes.
   *
   * Intent checks: the queued operation re-reads `desiredOn` after each await.
   * A layer toggled off mid-import stops before activating; a layer toggled off
   * mid-activation is deactivated before it can register. The matching queued
   * deactivation (there is always one; only `deactivate` flips the intent off)
   * then clears the pill and announces the off state.
   */
  function activateWithIndicator(def: LayerDef): Promise<void> {
    const gen = bumpIntent(def.key, true);
    // This activation owns the outcome only while BOTH hold: the latest
    // intent is on AND no newer flip has occurred since this op was born.
    // The generation guard catches the boolean aliasing a rapid off/on
    // produces (see intentGen above).
    const ownsIntent = (): boolean =>
      desiredOn.get(def.key) === true && intentGen.get(def.key) === gen;
    return enqueueLayerOp(def.key, async () => {
      // The user reversed or superseded this toggle while it waited in the
      // queue, or the layer is already fully active (an off/on flip whose
      // off was skipped as stale); either way there is nothing to do.
      if (!ownsIntent()) return;
      if (registry.getActiveKeys().has(def.key)) return;

      const token = showLoading(`Loading ${def.name}...`);
      registry.setStatus(def.key, 'loading');
      try {
        const mod = await loadLayerModule(def);
        if (!ownsIntent()) return;
        ensurePopupsBound(def.key, mod);
        await mod.activate(map);
        if (!ownsIntent()) {
          // Turned off (or superseded by a newer flip) during activation:
          // undo before anything registers. A queued deactivation clears the
          // pill and announces; a queued newer activation starts clean.
          try {
            mod.deactivate(map);
          } catch (err) {
            console.error(`Layer "${def.key}" failed to deactivate cleanly:`, err);
          }
          return;
        }
        // A non-throwing activation failure (a module that catches its own fetch
        // error, calls reportStatus('error'), and returns) resolves normally, so
        // without this guard the key would fadeIn, register active, get counted
        // in the pill, and pollute the share URL. Treat a terminal 'error'
        // status as a failed activation and mirror the thrown-error cleanup:
        // never registry.activate on anything but a genuine on state (ready,
        // no-data, or zoom-in). This protects the URL-as-state invariant
        // (CLAUDE.md section 6 invariant 2). See docs/ddm-critical-review-2026-07-07.md #2.
        if (registry.getStatus(def.key) === 'error') {
          view.setCheckbox(def.key, false);
          desiredOn.set(def.key, false);
          try {
            mod.deactivate(map);
          } catch (err) {
            console.error(`Layer "${def.key}" failed to deactivate cleanly:`, err);
          }
          // Emit a `change` so the URL re-syncs from the active set without this
          // key (a boot from ?layers=<failed> must self-correct); registry.
          // deactivate also clears the stored status.
          registry.deactivate(def.key);
          // Re-assert the terminal 'error' after that clear so the pill and any
          // getStatus() reader see "unavailable", not "off".
          registry.setStatus(def.key, 'error');
          return;
        }
        // Ease the just-added layers in (no-op for reduced-motion users and
        // for modules without map layers; src/util/layer-fade.ts).
        fadeInLayers(map, mod.fadeLayerIds);
        // Keep the always-on-top reference labels on top: a surface
        // activated AFTER the labels appends above them otherwise (the U4
        // stage-5 adversarial major 2; src/map/layer-order.ts).
        reassertLabelOrder(map);
        registry.activate(def.key);
      } catch (err) {
        console.error(`Layer "${def.key}" failed to load:`, err);
        registry.setStatus(def.key, 'error');
        view.setCheckbox(def.key, false);
        desiredOn.set(def.key, false);
        registry.deactivate(def.key);
      } finally {
        hideLoading(token);
      }
    });
  }

  /**
   * Deactivate a layer: fade its map layers out (src/util/layer-fade.ts), call
   * the module's `deactivate` (which removes sources/layers and aborts in-flight
   * network operations), and remove the key from the registry. The fade runs
   * inside the per-key op chain, so a queued re-activation waits for the fade
   * plus removal instead of racing it; the registry, pill, and URL transition
   * after the removal, at most one fade duration later than before.
   *
   * The status pill is cleared back to its pre-activation empty state, and the
   * polite live region announces the off transition so a screen-reader user
   * hears why a checkbox they did not touch changed (a surface unchecked by the
   * exclusivity rule).
   */
  function deactivateInternal(def: LayerDef): void {
    bumpIntent(def.key, false);
    // Synchronously cancel any in-flight activation work through the optional
    // LayerModule seam: the queued teardown below cannot run until the
    // activation op ahead of it in the chain settles, so without this an
    // abandoned activation fetch would run out its full network budget after
    // the user withdrew intent (invariant 5; Codex Unit B finding 1,
    // 2026-07-15). Map-state teardown stays serialized in the op below.
    try {
      getLoadedLayerModule(def.key)?.cancelActivation?.();
    } catch (err) {
      console.error(`Layer "${def.key}" failed to cancel cleanly:`, err);
    }
    void enqueueLayerOp(def.key, async () => {
      // The user re-toggled the layer on while this off waited in the queue;
      // the newer activation owns the outcome.
      if (desiredOn.get(def.key) !== false) return;
      try {
        // A module that was never loaded has nothing on the map; the optional
        // chain is a no-op then, and the intent flip above makes any in-flight
        // activation stand down at its next checkpoint.
        const mod = getLoadedLayerModule(def.key);
        if (mod) {
          await fadeOutLayers(map, mod.fadeLayerIds);
          mod.deactivate(map);
        }
      } catch (err) {
        console.error(`Layer "${def.key}" failed to deactivate cleanly:`, err);
      }
      registry.deactivate(def.key);
      view.clearLayerStatus(def.key);
      view.announce(`${def.name}: off`);
    });
  }

  /**
   * Enforce the one-surface-at-a-time invariant (UX-1): deactivate every
   * surface other than `exceptKey` that is currently on. "On" means either
   * registered active or checked in the DOM; the DOM check covers a surface
   * whose activation is still in flight (the registry only records it after
   * `activate` resolves), and `deactivateInternal` aborts that in-flight work
   * through the layer module's cancellation contract.
   */
  function deactivateOtherSurfaces(exceptKey: string): void {
    const active = registry.getActiveKeys();
    for (const def of LAYER_DEFS) {
      if (def.role !== 'surface' || def.key === exceptKey) continue;
      const isOn = active.has(def.key) || view.isCheckboxChecked(def.key);
      if (!isOn) continue;
      view.setCheckbox(def.key, false);
      deactivateInternal(def);
    }
  }

  function activate(key: string, cascade = true): Promise<void> {
    const def = getLayerDef(key);
    if (!def) return Promise.resolve();
    // Surfaces are mutually exclusive: checking a surface first deactivates
    // whichever surface is on, through the same deactivate path a manual
    // off-toggle takes, so the registry (and with it the URL sync and the
    // pills) stays honest.
    if (def.role === 'surface') deactivateOtherSurfaces(def.key);
    const primary = activateWithIndicator(def);
    // Co-activation (D-0.7.0-018: the wildfire event pair). Turning a layer on
    // through a user toggle also turns on its partners, each still individually
    // toggleable off. `cascade` is false for the partners so the pair activates
    // one level and never ping-pongs. This lives ONLY here (the user-toggle
    // path): applyLayerSet and applyPreset name their layers explicitly, so a
    // deep link or preset stays authoritative about exactly what is on.
    if (cascade && def.coActivateWith) {
      for (const partnerKey of def.coActivateWith) {
        const partner = getLayerDef(partnerKey);
        if (!partner) continue;
        const isOn =
          registry.getActiveKeys().has(partnerKey) || view.isCheckboxChecked(partnerKey);
        if (isOn) continue;
        view.setCheckbox(partnerKey, true);
        void activate(partnerKey, false);
      }
    }
    return primary;
  }

  function deactivate(key: string): void {
    const def = getLayerDef(key);
    if (!def) return;
    deactivateInternal(def);
  }

  /**
   * Apply a preset: make the active layer set equal the preset's list, routing
   * every transition through the same activation and deactivation paths a
   * manual toggle takes (registry, URL sync, pills, and the UX-1 surface
   * exclusivity all hold for free; a preset names at most one surface by
   * construction). Layers already on and named by the preset are left
   * untouched. After application the user is free to adjust; the chip does not
   * lock anything.
   */
  function applyPreset(preset: ViewPreset): void {
    const wanted = new Set(preset.layers);
    const active = registry.getActiveKeys();

    for (const def of LAYER_DEFS) {
      if (wanted.has(def.key)) continue;
      const isOn = active.has(def.key) || view.isCheckboxChecked(def.key);
      if (!isOn) continue;
      view.setCheckbox(def.key, false);
      deactivateInternal(def);
    }

    for (const key of preset.layers) {
      const def = getLayerDef(key);
      if (!def) continue;
      const isOn = registry.getActiveKeys().has(key) || view.isCheckboxChecked(key);
      if (isOn) continue;
      view.setCheckbox(key, true);
      void activateWithIndicator(def);
    }

    view.announce(`View: ${preset.label}`);
  }

  /**
   * Activate a set of keys concurrently (the URL/default boot path). Mirrors
   * the old `applyUrlState` loop: each activation goes through the same path as
   * a user-initiated toggle, and `Promise.allSettled` lets a single slow or
   * failing layer not delay the rest. The URL parser guarantees at most one
   * surface in the set, so no exclusivity pass is needed here.
   */
  async function applyLayerSet(keys: Iterable<string>): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const key of keys) {
      const def = getLayerDef(key);
      if (!def) continue;
      view.setCheckbox(key, true);
      tasks.push(activateWithIndicator(def));
    }
    await Promise.allSettled(tasks);
  }

  /** Fire-and-forget activation (void, not awaited). */
  function ensureActive(key: string): void {
    void activate(key);
  }

  return { activate, deactivate, applyPreset, applyLayerSet, ensureActive };
}
