/**
 * Layer-activation state machine for the Dynamic Drought Module (DDM).
 *
 * Extracted from `src/ui/sidebar.ts` in phase 0.6.0 (the spine extraction,
 * decision D-ARCH-004). The sidebar
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
 * prove it.
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

import * as maplibregl from 'maplibre-gl';

import {
  LAYER_DEFS,
  getLayerDef,
  loadLayerModule,
  getLoadedLayerModule
} from '../config/layers';
import type { LayerActivation, LayerDef, LayerModule } from '../config/layers';
import type { ViewPreset } from '../config/presets';
import { isCommittedCompositionKey } from './cluster-service';
import { registry } from './registry';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
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
 *   - `applyLayerSet` activates a set of keys: the URL/default boot path,
 *     boot-only and called once. It skips every key any command has ever
 *     set (`desiredOn` is only ever added to), so a later caller would
 *     silently skip every layer a person has touched.
 *   - `ensureActive` is fire-and-forget activation (void, not awaited).
 */
export interface LayerController {
  activate(key: string, cascade?: boolean): Promise<void>;
  deactivate(key: string): void;
  applyPreset(preset: ViewPreset): void;
  /** Boot-only, call once: skips every key a command has already set. */
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
   * reactivation (Codex Unit B re-verify finding 1, 2026-07-15).
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

  /**
   * The controller-owned cancellation seam (DDM-P1-T02, 2026-09-08): the
   * live activation attempt per key. Exactly one exists per key at a time;
   * it is created inside the activation op, handed to the module as
   * `LayerActivation`, and aborted by `abortAttempt` the moment off intent
   * is recorded (synchronously, ahead of the serialized teardown), when a
   * newer activate of the same key supersedes it, and when the attempt stands
   * down or fails. The modules' own `cancelActivation` seam stays beside it
   * for the modules that keep private controllers; this signal is what lets a
   * module without one (hydrography) abort just as promptly.
   */
  const attempts = new Map<string, AbortController>();

  /** Abort and forget the key's live attempt, if any. Safe to call twice. */
  function abortAttempt(key: string): void {
    const attempt = attempts.get(key);
    if (!attempt) return;
    attempts.delete(key);
    attempt.abort();
  }

  /** Supersede any prior attempt for the key and open a new one. */
  function beginAttempt(key: string, generation: number): LayerActivation {
    abortAttempt(key);
    const attempt = new AbortController();
    attempts.set(key, attempt);
    return { signal: attempt.signal, generation };
  }

  /**
   * Close one attempt that stood down or failed, but only if it is still the
   * key's live attempt: a deactivate that already aborted it, or a newer
   * activate that already superseded it, owns the map entry by then.
   */
  function endAttempt(key: string, activation: LayerActivation): void {
    const attempt = attempts.get(key);
    if (!attempt || attempt.signal !== activation.signal) return;
    attempts.delete(key);
    attempt.abort();
  }

  /**
   * The shared tail of a failed activation, thrown or not (DDM-P1-T03,
   * 2026-09-08; corrected same day after the verifier found a double
   * announcement): uncheck the box and clear the on-intent BEFORE
   * `registry.deactivate`, because the sidebar's URL sync reads the checkbox
   * DOM snapshot synchronously off the registry's `change` event
   * (`checkedLayerKeys` in src/ui/sidebar.ts), not the registry's active set;
   * a share URL booted from a failed key must self-correct on this same
   * tick. Since D1 M5 (2026-09-27) the uncheck is scoped: a member of the
   * committed cluster's composition, recipe or persistent reference
   * (`isCommittedCompositionKey`; widened for found-073) stays checked and in
   * the share URL, so its failure never demotes the committed view; the
   * registry steps below run for every failure.
   *
   * Then read `registry.getStatus(key)` BEFORE deactivating, to tell the two
   * failure shapes apart:
   *
   *   - A module that follows the self-reporting contract already called
   *     `registry.setStatus(key, 'error')` itself (for example
   *     usdm.ts:794 `reportStatus('error'); return`) before this ever runs.
   *     Its status-change already announced "unavailable" once. Calling
   *     `registry.deactivate(key)` plain would wipe that stored status
   *     (registry.ts's documented clear-on-deactivate), and re-asserting it
   *     with a second `setStatus` would emit and announce it a second time
   *     for the same failure. So here we call
   *     `registry.deactivate(key, { keepStatus: true })` and do NOT call
   *     `setStatus` again: one status-change, one announcement.
   *   - Otherwise (a thrown chunk import, or any other path that never
   *     reported a status) there is nothing recorded yet, so
   *     `registry.deactivate(key)` (default: clears status, which is a
   *     no-op here) followed by `registry.setStatus(key, 'error')` is the
   *     ONE status-change for this failure.
   *
   * Either branch produces exactly one `registry.setStatus` call carrying
   * 'error' per failure, so `getStatus()` reads 'error' afterward and
   * `#layer-status-live` announces "unavailable" once, not twice.
   */
  function failActivation(key: string): void {
    // Scope of the uncheck (D1 M5, 2026-09-27; found-002 and found-003,
    // the director's Tier 1 scope; found-073 widened it from the recipe to
    // the whole composition, so hillshade and the boundaries count too): a
    // member of the committed composition keeps its checkbox and its
    // on-intent. Unchecking it made the
    // checked set diverge from the committed composition, so the cluster
    // service demoted the view to a custom set: no hazard pressed,
    // `cluster=` gone from the URL, and the horizon chips locked. Kept
    // checked, the key stays in the share URL (the one-word `cluster=`
    // token, or Drought's `layers=` list), reads unavailable from its
    // 'error' status, and a press of the committed hazard re-requests it
    // (cluster-service.ts applyCluster). Every other failure (a custom
    // `layers=` set) self-corrects out of the URL exactly as before. The
    // predicate is read BEFORE anything changes, while the checked set
    // still describes the display.
    if (!isCommittedCompositionKey(key)) {
      view.setCheckbox(key, false);
      desiredOn.set(key, false);
    }
    if (registry.getStatus(key) === 'error') {
      registry.deactivate(key, { keepStatus: true });
    } else {
      registry.deactivate(key);
      registry.setStatus(key, 'error');
    }
  }

  function enqueueLayerOp(key: string, op: () => Promise<void> | void): Promise<void> {
    const prev = layerOpChain.get(key) ?? Promise.resolve();
    // Run after the prior op regardless of how it settled; each op carries its
    // own error handling, so the chain itself never sticks in a rejected state.
    const next = prev.then(op, op);
    layerOpChain.set(key, next);
    return next;
  }

  /**
   * Run a layer's `bindPopups` on its first activation: the module
   * registers its click target with the InteractionCoordinator (one
   * response per click; no layer binds its own map click handler) and
   * wires hover cursors. Not run at boot (that would pull every layer
   * module into the initial bundle); once here, guarded, survives
   * toggle cycles, and registration order never affects arbitration.
   */
  function ensurePopupsBound(key: string, mod: LayerModule): void {
    if (popupsBound.has(key)) return;
    if (mod.bindPopups) mod.bindPopups(map);
    popupsBound.add(key);
  }

  /**
   * Activate a layer with a loading-indicator token around the call. Updates
   * the registry on success; on failure runs `failActivation`, which
   * unchecks the checkbox unless the key is a member of the committed
   * cluster's composition (D1 M5, found-073).
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
        // The attempt opens here, after the chunk import, so a module never
        // sees a signal older than its own code; it is aborted by
        // deactivateInternal the instant off intent is recorded, so a held
        // fetch inside mod.activate aborts promptly rather than running out
        // its network budget behind this op (DDM-P1-T02).
        const activation = beginAttempt(def.key, gen);
        await mod.activate(map, activation);
        if (!ownsIntent()) {
          // Turned off (or superseded by a newer flip) during activation:
          // undo before anything registers. A queued deactivation clears the
          // pill and announces; a queued newer activation starts clean.
          endAttempt(def.key, activation);
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
        // (critical-review finding #2, 2026-07-07). Scope since D1 M5
        // (2026-09-27): the key never registers active either way, but a
        // member of the committed composition keeps its checkbox and its
        // place in the share URL, because the URL then claims the committed
        // view the user chose, whose summary names the layer unavailable;
        // only a custom set's failure leaves the URL (found-073).
        if (registry.getStatus(def.key) === 'error') {
          endAttempt(def.key, activation);
          try {
            mod.deactivate(map);
          } catch (err) {
            console.error(`Layer "${def.key}" failed to deactivate cleanly:`, err);
          }
          // Shared failure tail (DDM-P1-T03): the module already
          // self-reported 'error', so failActivation keeps that status
          // instead of re-asserting it. See failActivation above.
          failActivation(def.key);
          return;
        }
        // Ease the just-added layers in (no-op for reduced-motion users and
        // for modules without map layers; src/util/layer-fade.ts).
        fadeInLayers(map, mod.fadeLayerIds);
        // Re-seat the deterministic thematic chain (E1 deliverable 2,
        // D-0.7.0-041 part 2): basemap < hillshade < USDM < state hairline
        // < Tribal Lands < Reservation Boundaries < labels, stable
        // regardless of which activation's fetch resolved first
        // (src/map/layer-order.ts).
        reassertThematicOrder(map);
        // Keep the always-on-top reference labels on top: a surface
        // activated AFTER the labels appends above them otherwise (the U4
        // stage-5 adversarial major 2; src/map/layer-order.ts).
        reassertLabelOrder(map);
        registry.activate(def.key);
      } catch (err) {
        if (!ownsIntent()) return;
        // A thrown activation has nothing left in flight worth keeping; the
        // attempt closes so a later activate starts from a fresh signal.
        // `mod` may never have been assigned (a chunk import failure throws
        // before that binding exists), so unlike the non-thrown branch above
        // there is no module instance here to call `deactivate` on.
        abortAttempt(def.key);
        console.error(`Layer "${def.key}" failed to load:`, err);
        // Shared failure tail (DDM-P1-T03): nothing was reported here, so
        // failActivation asserts 'error' once after registry.deactivate.
        // See failActivation above.
        failActivation(def.key);
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
    // Synchronously abort the controller-owned attempt FIRST (DDM-P1-T02):
    // every fetch the module linked to it, the initial load and any viewport
    // refresh alike, aborts here and now, and the module's late-response
    // guards then drop whatever raced past the abort. Then the optional
    // module seam: the queued teardown below cannot run until the
    // activation op ahead of it in the chain settles, so without these an
    // abandoned activation fetch would run out its full network budget after
    // the user withdrew intent (invariant 5; Codex Unit B finding 1,
    // 2026-07-15). Map-state teardown stays serialized in the op below.
    abortAttempt(def.key);
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
    // Co-activation. Turning a layer on through a user toggle also turns on
    // the partners its `coActivateWith` declares, each still individually
    // toggleable off. `cascade` is false for the partners so a pair activates
    // one level and never ping-pongs. This lives ONLY here (the user-toggle
    // path): applyLayerSet and applyPreset name their layers explicitly, so a
    // deep link or preset stays authoritative about exactly what is on.
    // No layer declares partners today: the wildfire event pair
    // (D-0.7.0-018) was made independent by the owner's ruling of 2026-09-28
    // (found-007), so this block is a no-op kept for any future pair.
    if (cascade && def.coActivateWith) {
      for (const partnerKey of def.coActivateWith) {
        const partner = getLayerDef(partnerKey);
        if (!partner) continue;
        // Read INTENT, never the registry (found-092, 2026-09-28). A manual
        // uncheck bumps `desiredOn` to false synchronously (deactivateInternal,
        // above), but `registry.deactivate` only runs inside that key's queued
        // teardown op, AFTER any fade completes. Between those two moments the
        // registry still reports the partner active, so checking it here would
        // skip re-cascading a partner the user just turned off and is now
        // turning back on through the OTHER member of the pair (unchecking
        // both, then rechecking either, never brought the first back). The
        // intent map is exactly right for "is this partner already on":
        // activateWithIndicator, applyLayerSet, and applyPreset each bump it
        // to true before the key can ever become active, so `desiredOn` is
        // never a false negative here, only the registry read was.
        if (desiredOn.get(partnerKey) === true) continue;
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
      // A key left checked by a failed activation (a recipe member of the
      // committed cluster, D1 M5) is not on: it is checked, never
      // registered, and holds 'error'. The preset asks for it again, the
      // same re-request a press of the committed hazard makes.
      const failedButChecked =
        view.isCheckboxChecked(key) &&
        !registry.getActiveKeys().has(key) &&
        registry.getStatus(key) === 'error';
      const isOn =
        registry.getActiveKeys().has(key) ||
        (view.isCheckboxChecked(key) && !failedButChecked);
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
   *
   * The boot runs this only once the lazy island settles, after the controls
   * already work (found-114, S30D P3-BOOT). A key whose intent a command has
   * recorded since then (a preset chip, the hazard rail, a toggle, a studio)
   * belongs to that newer command, on or off, and is skipped: the boot applies
   * its captured set as the person has since left it, so a surface they
   * replaced never returns beside their choice, and a key their command kept
   * checked still activates. The exclusivity holds too, since a command that
   * turns any surface on has already turned the boot's surface off. With no
   * command in the window no key has an intent yet, and every key activates
   * exactly as before, with one automatic exception: a `studio=place` deep
   * link whose Place studio mounts first records off intent for the surface
   * its clean display sets aside (src/state/display-snapshot.ts,
   * `beginPlaceStudioDisplay`). The end state is the same; that surface is
   * simply no longer started and then cancelled here. Boot-only and called
   * once: `desiredOn` is never cleared, so a second caller would skip every
   * key a person has ever touched.
   */
  async function applyLayerSet(keys: Iterable<string>): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const key of keys) {
      const def = getLayerDef(key);
      if (!def || desiredOn.has(key)) continue;
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
