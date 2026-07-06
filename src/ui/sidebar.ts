/**
 * Sidebar UI lifecycle for the Dynamic Drought Module (DDM).
 *
 * This module is the TypeScript port of the vanilla `app.js` UI builders
 * (`buildRegionButtons`, `buildLayerToggles`, `buildTelemetryList`),
 * status-pill helper (`setLayerStatus`), and `wireTopLevelEvents`. It also
 * picks up the [next-polish] accessibility quick wins from `TODO.md`:
 *
 *   - Region radiogroup arrow-key navigation (Up/Down/Left/Right cycle,
 *     Home/End first/last). Tab still moves between radiogroups.
 *   - Telemetry items are buttons (focusable, keyboard-activatable).
 *   - Visually-hidden polite live region for layer status announcements.
 *
 * Architectural responsibilities:
 *
 *   1. On `buildSidebar(map, onRegionSelect)`:
 *      - Build region radiogroup, layer toggles, and telemetry list.
 *      - Read the URL via `parseUrlParams`, apply embed mode, fit the
 *        active region, and toggle each default-on or URL-listed layer
 *        on (via the layer module's `activate`).
 *      - Wire share / reset / collapse / expand buttons and the
 *        viewport resize debounce.
 *      - Subscribe to the LayerRegistry's `change` event for URL sync
 *        and the active-count pill, and to `status-change` for the
 *        per-layer pill text and the polite live region.
 *
 *   2. `setLayerStatusInPill(key, status)` updates the per-layer status
 *      pill and the visually-hidden live region. Bound externally via
 *      `registry.on('status-change', ...)`; also exported so a layer
 *      module that wants to set its own status before activation
 *      completes can reach it without going through the registry.
 *
 * Deviation note (per CLAUDE.md section 12): the kickoff prescribed
 * splitting share, overlay, and sidebar into three files. We keep the
 * three-file split, with this module owning only the sidebar lifecycle.
 * `wireShareButton` lives in `./share`; `showLoading` / `hideLoading` /
 * `showToast` live in `./overlay`. The sidebar imports both.
 *
 * Stewardship: no Tribal, Treaty, or sovereign-jurisdiction data is
 * surfaced in this module. All region and layer labels come from the
 * config tables in `src/config/`.
 */

import maplibregl from 'maplibre-gl';

import {
  LAYER_DEFS,
  LAYER_ROLE_ORDER,
  getLayerDef,
  loadLayerModule,
  getLoadedLayerModule
} from '../config/layers';
import type { LayerDef, LayerModule } from '../config/layers';
import type { LayerRole } from '../types/layer';
import { VIEW_PRESETS } from '../config/presets';
import type { ViewPreset } from '../config/presets';
import {
  REGIONS,
  DEFAULT_REGION,
  regionToMapLibreBounds
} from '../config/regions';
import type { RegionKey, Region } from '../config/regions';
import { TELEMETRY_STATIONS } from '../config/telemetry';
import { registry } from '../state/registry';
import {
  fetchAwdbDailySeries,
  toStationValue,
  elementsForAwdbStationTriplet
} from '../util/awdb';
import { fetchCwmsLatest, cwmsStationValue } from '../util/cwms';
import { fetchHydrometDaily, hydrometStationValue } from '../util/hydromet';
import { fetchUsgsIV, usgsLatestStationValue } from '../util/usgs';
import type { StationValue, TelemetryStation } from '../types/station';
import { setCurrentRegion } from '../state/region-store';
import type { LayerStatus } from '../types/layer';
import { parseUrlParams, syncUrl } from '../state/url';
import { fadeInLayers, fadeOutLayers } from '../util/layer-fade';
import { flyToStation } from '../layers/telemetry';
import { buildConditionsStrip } from './conditions-strip';
import { wireShareButton } from './share';
import { showLoading, hideLoading, showToast } from './overlay';
import { escapeHtml } from '../util/escape';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Sidebar-owned mirror of the slice of application state the sidebar
 * itself drives. The orchestrator (`src/main.ts`) does not need to hand
 * the sidebar a state object; the sidebar is the state owner for region
 * selection (after a click) and for the embed flag (after the user
 * expands the sidebar in embed mode).
 *
 * Reset and URL sync read this object; keep mutations restricted to
 * `selectRegion` and the expand-button handler.
 */
interface SidebarState {
  currentRegion: RegionKey | null;
  embed: boolean;
}

const STATE: SidebarState = {
  currentRegion: null,
  embed: false
};

/**
 * Cached reference to the MapLibre map. Stored at `buildSidebar` time so
 * the registry-status subscription does not need to thread the map
 * through the callback.
 */
let mapRef: maplibregl.Map | null = null;

// ---------------------------------------------------------------------------
// Status pill rendering
// ---------------------------------------------------------------------------

/**
 * The five canonical layer states map to user-visible pill text per the
 * v0.1.2 wording. CLAUDE.md section 6 invariant 3 fixes this contract;
 * the `LayerStatus` union in `src/types/layer.ts` is the source of truth
 * for the keys.
 *
 * Note the punctuation: an ellipsis is rendered as three ASCII dots
 * (`loading...`) per the same v0.1.2 convention; em dashes are forbidden
 * by CLAUDE.md section 4.
 */
const STATUS_PILL_TEXT: Record<LayerStatus, string> = {
  loading: 'loading...',
  ready: 'live',
  error: 'unavailable',
  'no-data': 'empty placeholder (see data/README.md)',
  'zoom-in': 'zoom in to load'
};

const STATUS_CSS_CLASSES: ReadonlyArray<string> = [
  'loading',
  'ready',
  'error',
  'no-data',
  'zoom-in'
];

/**
 * Update the per-layer status pill text and CSS class. Called by both
 * the registry `status-change` subscription and any direct caller (for
 * example, a layer module that flips itself to `zoom-in` on a moveend
 * even while no activation is in flight).
 *
 * Also writes a sentence into the polite live region so screen readers
 * hear "Hydrography: live" when a layer transitions states.
 */
export function setLayerStatusInPill(key: string, status: LayerStatus): void {
  const el = document.querySelector<HTMLElement>(
    `[data-layer-status="${cssAttrEscape(key)}"]`
  );
  if (!el) return;

  for (const cls of STATUS_CSS_CLASSES) {
    el.classList.remove(cls);
  }
  el.classList.add(status);
  el.textContent = STATUS_PILL_TEXT[status];

  // Polite live region announcement. Resolves the layer's display name
  // so a screen-reader user hears "Hydrography: live" rather than the
  // bare key.
  const def = getLayerDef(key);
  const friendly = def ? def.name : key;
  announce(`${friendly}: ${STATUS_PILL_TEXT[status]}`);
}

/**
 * Update the active-count pill at the top of the layers panel. Mirrors
 * the vanilla baseline behavior: the text is `<n> on` and the
 * `.active` class is set when at least one layer is on.
 */
function updateActiveCountPill(active: ReadonlySet<string>): void {
  const pill = document.getElementById('layer-status');
  if (!pill) return;
  pill.textContent = `${active.size} on`;
  pill.classList.toggle('active', active.size > 0);
}

// ---------------------------------------------------------------------------
// Live region (visually-hidden polite announcer)
// ---------------------------------------------------------------------------

/**
 * Reference to the visually-hidden live region. Created at
 * `buildSidebar` time and reused for every announcement.
 */
let liveRegionEl: HTMLDivElement | null = null;

/**
 * Inject (once) a visually-hidden polite live region into the document
 * body. Screen readers announce changes to its text content; sighted
 * users see nothing because of the `.sr-only` class in `app.css`.
 */
function ensureLiveRegion(): HTMLDivElement {
  if (liveRegionEl) return liveRegionEl;
  let el = document.getElementById('layer-status-live') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'layer-status-live';
    el.className = 'sr-only';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  liveRegionEl = el;
  return el;
}

/**
 * Write `message` to the polite live region. A small `setTimeout` clear
 * is intentionally omitted: identical consecutive announcements are
 * merged by some screen readers, but the layer-status flow rarely fires
 * the same string twice in a row, and the simpler write avoids
 * introducing a race with the next status transition.
 */
function announce(message: string): void {
  const el = ensureLiveRegion();
  el.textContent = message;
}

// ---------------------------------------------------------------------------
// Region selection
// ---------------------------------------------------------------------------

/**
 * Apply a region selection: update sidebar state, mark the active radio,
 * fit the map bounds with the region's padding, and sync the URL.
 *
 * Mirrors the vanilla `selectRegion` (~app.js 1132-1151). The padding is
 * applied symmetrically in degrees on the raw bounds, then a 20-pixel
 * map-padding inset is added on `fitBounds`.
 *
 * `silent` suppresses the camera animation, used for the initial fit at
 * boot so the user does not see a fly-to from the world view.
 */
function selectRegion(
  map: maplibregl.Map,
  key: RegionKey,
  silent = false
): void {
  const region: Region | undefined = REGIONS[key];
  if (!region) return;

  STATE.currentRegion = key;
  // Mirror the active region into the shared store so the impact panel (and
  // any future consumer) can read it without threading it through every
  // layer signature. See src/state/region-store.ts.
  setCurrentRegion(key);

  const [west, south, east, north] = regionToMapLibreBounds(region);
  const pad = region.padding;
  map.fitBounds(
    [
      [west - pad, south - pad],
      [east + pad, north + pad]
    ],
    {
      padding: 20,
      animate: !silent
    }
  );

  document.querySelectorAll<HTMLButtonElement>('.region-btn').forEach((btn) => {
    const isActive = btn.dataset['regionKey'] === key;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    // Roving tabindex: the active button is focusable via Tab; the
    // others are reachable only via arrow keys within the radiogroup.
    btn.tabIndex = isActive ? 0 : -1;
  });

  pushUrl();
}

/**
 * Push the current region + active-layers + embed state to the URL. A
 * thin wrapper so callers do not have to assemble the snapshot.
 */
function pushUrl(): void {
  syncUrl({
    region: STATE.currentRegion,
    layers: registry.getActiveKeys(),
    embed: STATE.embed
  });
}

// ---------------------------------------------------------------------------
// Region radiogroup builder + keyboard navigation
// ---------------------------------------------------------------------------

/**
 * Build the region radiogroup. Each region key produces a `<button>`
 * with `role="radio"` and `aria-checked` so the group reads as a
 * radiogroup to assistive tech.
 *
 * Keyboard: ArrowUp / ArrowLeft cycle to the previous region;
 * ArrowDown / ArrowRight cycle to the next; Home / End jump to first
 * / last. Activation uses standard click semantics (Enter, Space).
 */
function buildRegionButtons(
  map: maplibregl.Map,
  onRegionSelect: (key: RegionKey) => void
): void {
  const container = document.getElementById('region-buttons');
  if (!container) return;
  container.innerHTML = '';

  const entries = Object.entries(REGIONS) as Array<[RegionKey, Region]>;

  entries.forEach(([key, region]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'region-btn';
    btn.dataset['regionKey'] = key;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.title = region.description;
    btn.textContent = region.short;
    btn.tabIndex = -1;
    btn.addEventListener('click', () => {
      onRegionSelect(key);
      // Keep keyboard focus on the just-selected button so the visual
      // focus ring remains where the user expects after activation.
      btn.focus();
    });
    container.appendChild(btn);
  });

  // Radiogroup keyboard navigation. Listening at the container so the
  // handler does not have to be re-bound for every button.
  container.addEventListener('keydown', (event: KeyboardEvent) => {
    handleRadiogroupKey(event, map, onRegionSelect);
  });
}

/**
 * Roving-tabindex handler for the region radiogroup. Cycles selection
 * (and focus) on the four arrow keys; jumps to first/last on Home/End.
 *
 * Note that pressing an arrow key both moves focus and changes the
 * active region, matching the standard radiogroup pattern (selection
 * follows focus). This is the WAI-ARIA radiogroup keyboard contract.
 */
function handleRadiogroupKey(
  event: KeyboardEvent,
  _map: maplibregl.Map,
  onRegionSelect: (key: RegionKey) => void
): void {
  const keys = Object.keys(REGIONS) as RegionKey[];
  if (keys.length === 0) return;

  const currentKey = STATE.currentRegion ?? keys[0];
  if (currentKey === undefined) return;
  const idx = keys.indexOf(currentKey);
  let nextIdx: number | null = null;

  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowRight':
      nextIdx = (idx + 1) % keys.length;
      break;
    case 'ArrowUp':
    case 'ArrowLeft':
      nextIdx = (idx - 1 + keys.length) % keys.length;
      break;
    case 'Home':
      nextIdx = 0;
      break;
    case 'End':
      nextIdx = keys.length - 1;
      break;
    default:
      return;
  }

  if (nextIdx === null) return;
  event.preventDefault();
  const target = keys[nextIdx];
  if (target === undefined) return;
  onRegionSelect(target);

  // Move focus to the now-active button.
  const btn = document.querySelector<HTMLButtonElement>(
    `.region-btn[data-region-key="${cssAttrEscape(target)}"]`
  );
  if (btn) btn.focus();
}

// ---------------------------------------------------------------------------
// Layer toggles builder
// ---------------------------------------------------------------------------

/**
 * User-facing labels for the four role groups (UX-1). The headings carry
 * the ratified place/state taxonomy into the sidebar: condition surfaces
 * describe the state a place is in (one at a time); references are the
 * tactile anchor for place; events and stations sit on top.
 */
const ROLE_GROUP_LABELS: Record<LayerRole, { title: string; hint: string | null }> = {
  surface: { title: 'Conditions', hint: 'one at a time' },
  reference: { title: 'Place', hint: 'boundaries & rivers' },
  event: { title: 'Events', hint: null },
  stations: { title: 'Stations', hint: null }
};

/**
 * Build the layer toggle list from `LAYER_DEFS`, grouped by role in
 * `LAYER_ROLE_ORDER` (surfaces, references, events, stations; UX-1).
 * Within a group, entries keep their `LAYER_DEFS` order. Each entry is a
 * `<label>` wrapping a checkbox plus three text spans (name, source,
 * status pill). The checkbox `change` handler activates or deactivates
 * the corresponding layer module and updates the registry.
 *
 * Surfaces are mutually exclusive: checking a surface first deactivates
 * whichever surface is on, through the same `deactivateLayer` path a
 * manual off-toggle takes, so the registry (and with it the URL sync and
 * the pills) stays honest. All four groups keep checkbox semantics
 * because, unlike a radio group, every surface may be off at once.
 *
 * The activation path wraps the layer module's `activate` in a
 * `showLoading` / `hideLoading` token so parallel toggles do not stomp
 * each other's indicator text. On activation failure the checkbox is
 * unchecked so the UI does not lie about a layer being on.
 */
function buildLayerToggles(map: maplibregl.Map): void {
  const container = document.getElementById('layer-toggles');
  if (!container) return;
  container.innerHTML = '';

  for (const role of LAYER_ROLE_ORDER) {
    const defs = LAYER_DEFS.filter((def) => def.role === role);
    if (defs.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'layer-group';
    group.setAttribute('role', 'group');

    const label = ROLE_GROUP_LABELS[role];
    const heading = document.createElement('div');
    heading.className = 'layer-group-title';
    heading.id = `layer-group-${role}`;
    heading.innerHTML = label.hint
      ? `${escapeHtml(label.title)} <span class="layer-group-hint">${escapeHtml(label.hint)}</span>`
      : escapeHtml(label.title);
    group.setAttribute('aria-labelledby', heading.id);
    group.appendChild(heading);

    for (const def of defs) {
      group.appendChild(buildLayerToggle(map, def));
    }
    container.appendChild(group);
  }
}

/**
 * Build a single layer toggle row. Split out of `buildLayerToggles` when
 * UX-1 introduced role groups; behavior is unchanged from the flat list.
 */
function buildLayerToggle(map: maplibregl.Map, def: LayerDef): HTMLLabelElement {
  const id = `layer-toggle-${def.key}`;
  const wrapper = document.createElement('label');
  wrapper.className = 'layer-toggle';
  wrapper.htmlFor = id;
  wrapper.innerHTML = `
    <input type="checkbox" id="${escapeHtml(id)}" data-layer-key="${escapeHtml(def.key)}" />
    <span class="layer-toggle-text">
      <span class="layer-toggle-name">${escapeHtml(def.name)}</span>
      <span class="layer-toggle-source">${escapeHtml(def.source)}</span>
      <span class="layer-toggle-status" data-layer-status="${escapeHtml(def.key)}"></span>
    </span>
  `;

  const cb = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (cb) {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (def.role === 'surface') {
          deactivateOtherSurfaces(map, def.key);
        }
        void activateLayerWithIndicator(map, def, cb);
      } else {
        deactivateLayer(map, def);
      }
    });
  }

  return wrapper;
}

/**
 * Enforce the one-surface-at-a-time invariant (UX-1): deactivate every
 * surface other than `exceptKey` that is currently on. "On" means either
 * registered active or checked in the DOM; the DOM check covers a surface
 * whose activation is still in flight (the registry only records it after
 * `activate` resolves), and `deactivateLayer` aborts that in-flight work
 * through the layer module's cancellation contract.
 */
function deactivateOtherSurfaces(map: maplibregl.Map, exceptKey: string): void {
  const active = registry.getActiveKeys();
  for (const def of LAYER_DEFS) {
    if (def.role !== 'surface' || def.key === exceptKey) continue;
    const cb = document.querySelector<HTMLInputElement>(
      `input[data-layer-key="${cssAttrEscape(def.key)}"]`
    );
    const isOn = active.has(def.key) || (cb?.checked ?? false);
    if (!isOn) continue;
    if (cb) cb.checked = false;
    deactivateLayer(map, def);
  }
}

/**
 * The latest per-layer user intent (on or off), recorded synchronously the
 * moment a toggle, preset, or deep-link path asks for a change. The queued
 * operations below consult it at every await boundary, so an operation the
 * user has since reversed (toggled off while the chunk import or the
 * activation fetch was in flight) becomes a no-op instead of resurrecting
 * a turned-off layer into the registry and the URL.
 */
const desiredOn = new Map<string, boolean>();

/**
 * Per-layer operation chain: activations and deactivations for one key run
 * strictly in sequence. Without this, a rapid off/on could overlap a
 * module's `activate()` with itself (tribal and treaty throw on a duplicate
 * source id) or with its own `deactivate()`. Chains are per key, so
 * distinct layers still activate in parallel.
 */
const layerOpChain = new Map<string, Promise<void>>();

function enqueueLayerOp(key: string, op: () => Promise<void> | void): Promise<void> {
  const prev = layerOpChain.get(key) ?? Promise.resolve();
  // Run after the prior op regardless of how it settled; each op carries its
  // own error handling, so the chain itself never sticks in a rejected state.
  const next = prev.then(op, op);
  layerOpChain.set(key, next);
  return next;
}

/**
 * Activate a layer with a loading-indicator token around the call.
 * Updates the registry on success; unchecks the checkbox on failure.
 *
 * Mirrors the vanilla `activateLayer` flow (~app.js 1067-1097). The
 * registry is set to `loading` before the activation so the status
 * pill updates immediately; the layer module is responsible for
 * setting its own `ready`, `error`, `no-data`, or `zoom-in` once it
 * finishes.
 *
 * Intent checks: the queued operation re-reads `desiredOn` after each
 * await. A layer toggled off mid-import stops before activating; a layer
 * toggled off mid-activation is deactivated before it can register. The
 * matching queued deactivation (there is always one; only `deactivateLayer`
 * flips the intent off) then clears the pill and announces the off state.
 */
function activateLayerWithIndicator(
  map: maplibregl.Map,
  def: LayerDef,
  cb: HTMLInputElement
): Promise<void> {
  desiredOn.set(def.key, true);
  return enqueueLayerOp(def.key, async () => {
    // The user reversed this toggle while it waited in the queue, or the
    // layer is already fully active (an off/on flip whose off was skipped
    // as stale); either way there is nothing to do.
    if (desiredOn.get(def.key) !== true) return;
    if (registry.getActiveKeys().has(def.key)) return;

    const token = showLoading(`Loading ${def.name}...`);
    registry.setStatus(def.key, 'loading');
    try {
      const mod = await loadLayerModule(def);
      if (desiredOn.get(def.key) !== true) return;
      ensurePopupsBound(map, def.key, mod);
      await mod.activate(map);
      if (desiredOn.get(def.key) !== true) {
        // Turned off during activation: undo before anything registers. The
        // queued deactivation clears the pill and announces.
        try {
          mod.deactivate(map);
        } catch (err) {
          console.error(`Layer "${def.key}" failed to deactivate cleanly:`, err);
        }
        return;
      }
      // Ease the just-added layers in (no-op for reduced-motion users and
      // for modules without map layers; src/util/layer-fade.ts).
      fadeInLayers(map, mod.fadeLayerIds);
      registry.activate(def.key);
    } catch (err) {
      console.error(`Layer "${def.key}" failed to load:`, err);
      registry.setStatus(def.key, 'error');
      cb.checked = false;
      desiredOn.set(def.key, false);
      registry.deactivate(def.key);
    } finally {
      hideLoading(token);
    }
  });
}

/** Layers whose bindPopups has already run (once, on first activation). */
const popupsBound = new Set<string>();

/**
 * Bind a layer's popup click handlers on its first activation. Popups are no
 * longer bound at boot (that would pull every layer module into the initial
 * bundle); binding once here, guarded, matches the old survive-toggle-cycles
 * behavior, and MapLibre tolerates a handler bound before its layer exists.
 */
function ensurePopupsBound(map: maplibregl.Map, key: string, mod: LayerModule): void {
  if (popupsBound.has(key)) return;
  if (mod.bindPopups) mod.bindPopups(map);
  popupsBound.add(key);
}

/**
 * Deactivate a layer: fade its map layers out (src/util/layer-fade.ts),
 * call the module's `deactivate` (which removes sources/layers and aborts
 * in-flight network operations), and remove the key from the registry.
 * The fade runs inside the per-key op chain, so a queued re-activation
 * waits for the fade plus removal instead of racing it; the registry,
 * pill, and URL transition after the removal, at most one fade duration
 * later than before.
 *
 * The status pill is cleared back to its pre-activation empty state: an
 * off layer has no load status, and leaving a stale "live" pill on a row
 * the surface radio behavior just unchecked (UX-1) would misreport the
 * map. The polite live region announces the off transition so a
 * screen-reader user hears why a checkbox they did not touch changed.
 */
function deactivateLayer(map: maplibregl.Map, def: LayerDef): void {
  desiredOn.set(def.key, false);
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
    clearLayerStatusPill(def.key);
    announce(`${def.name}: off`);
  });
}

/**
 * Reset a layer's status pill to the empty pre-activation state (no text,
 * no status class). The five canonical states describe load progress; an
 * intentionally-off layer is none of them.
 */
function clearLayerStatusPill(key: string): void {
  const el = document.querySelector<HTMLElement>(
    `[data-layer-status="${cssAttrEscape(key)}"]`
  );
  if (!el) return;
  for (const cls of STATUS_CSS_CLASSES) {
    el.classList.remove(cls);
  }
  el.textContent = '';
}

// ---------------------------------------------------------------------------
// View preset chips (UX-2)
// ---------------------------------------------------------------------------

/**
 * Build the question-first preset chip row from `VIEW_PRESETS`. Each chip
 * is a plain button (not a toggle: presets set state without locking it,
 * so no chip carries a pressed state) whose click applies the preset's
 * layer-set. The tooltip carries the question the preset answers.
 */
function buildPresetChips(map: maplibregl.Map): void {
  const container = document.getElementById('preset-chips');
  if (!container) return;
  container.innerHTML = '';

  for (const preset of VIEW_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-chip';
    btn.textContent = preset.label;
    btn.title = preset.description;
    btn.addEventListener('click', () => {
      applyPreset(map, preset);
    });
    container.appendChild(btn);
  }
}

/**
 * Apply a preset: make the active layer set equal the preset's list,
 * routing every transition through the same activation and deactivation
 * paths a manual toggle takes (registry, URL sync, pills, and the UX-1
 * surface exclusivity all hold for free; a preset names at most one
 * surface by construction). Layers already on and named by the preset
 * are left untouched. After application the user is free to adjust;
 * the chip does not lock anything.
 */
function applyPreset(map: maplibregl.Map, preset: ViewPreset): void {
  const wanted = new Set(preset.layers);
  const active = registry.getActiveKeys();

  for (const def of LAYER_DEFS) {
    if (wanted.has(def.key)) continue;
    const cb = document.querySelector<HTMLInputElement>(
      `input[data-layer-key="${cssAttrEscape(def.key)}"]`
    );
    const isOn = active.has(def.key) || (cb?.checked ?? false);
    if (!isOn) continue;
    if (cb) cb.checked = false;
    deactivateLayer(map, def);
  }

  for (const key of preset.layers) {
    const def = getLayerDef(key);
    if (!def) continue;
    const cb = document.querySelector<HTMLInputElement>(
      `input[data-layer-key="${cssAttrEscape(key)}"]`
    );
    const isOn = registry.getActiveKeys().has(key) || (cb?.checked ?? false);
    if (isOn) continue;
    if (cb) cb.checked = true;
    void activateLayerWithIndicator(map, def, cb ?? createDetachedCheckbox());
  }

  announce(`View: ${preset.label}`);
}

// ---------------------------------------------------------------------------
// Telemetry list builder
// ---------------------------------------------------------------------------

/**
 * Build the telemetry list. Each entry is a `<button>` (per the
 * [next-polish] accessibility quick win) carrying a colored dot and
 * the station name + agency / type. Click handler ensures the
 * telemetry layer is on, then calls `flyToStation`.
 */
function buildTelemetryList(map: maplibregl.Map): void {
  const container = document.getElementById('telemetry-list');
  if (!container) return;
  container.innerHTML = '';

  for (const station of TELEMETRY_STATIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'telemetry-item';
    item.title = station.description;
    item.innerHTML = `
      <span class="telemetry-marker-dot" style="background:${escapeHtml(station.color)}"></span>
      <span class="telemetry-meta">
        <span class="telemetry-name">${escapeHtml(station.name)}</span>
        <span class="telemetry-agency">${escapeHtml(station.agency)} (${escapeHtml(station.type)})</span>
        <span class="telemetry-values" data-station-values="${escapeHtml(station.id)}"></span>
      </span>
    `;
    item.addEventListener('click', () => {
      ensureTelemetryActive(map);
      flyToStation(map, station.id);
    });
    container.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Telemetry live values (Tier 2, through src/util/awdb.ts)
// ---------------------------------------------------------------------------

/**
 * One-shot-per-session guard for the station-value hydration. The skill
 * vocabulary's `unknown` state is "not yet fetched in this session"; the
 * first telemetry-layer activation triggers the fetch round trip.
 */
let stationValuesHydrated = false;

/** Master abort for in-flight value fetches; fired on telemetry layer-off. */
let stationValuesController: AbortController | null = null;

/** Compact display date for a YYYY-MM-DD reading ("Jun 30"). */
function shortReadingDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The primary StationValue for one station, by whichever live source it
 * carries: NRCS SNOTEL Snow Water Equivalent (`awdbStation`), the first
 * configured USBR Hydromet parameter (`hydrometParams`), the USACE
 * CWMS reading (`cwms`), or the latest USGS Instantaneous Values reading
 * (`usgsSite`). Null when the station has no wired source.
 */
async function fetchPrimaryStationValue(
  station: TelemetryStation,
  signal: AbortSignal
): Promise<StationValue | null> {
  if (station.awdbStation) {
    const elements = elementsForAwdbStationTriplet(station.awdbStation);
    const series = await fetchAwdbDailySeries(station.awdbStation, elements, 7, signal);
    const primary = series.find((s) => s.element === elements[0]);
    return primary ? toStationValue(station.id, primary) : null;
  }
  if (station.hydrometParams && station.hydrometParams.length > 0) {
    const series = await fetchHydrometDaily(station.hydrometParams, 7, signal);
    const primary = series[0];
    return primary ? hydrometStationValue(station.id, primary) : null;
  }
  if (station.cwms) {
    const latest = await fetchCwmsLatest(station.cwms, signal);
    return cwmsStationValue(station.id, station.cwms.label, latest);
  }
  if (station.usgsSite) {
    const payload = await fetchUsgsIV(station.usgsSite, signal);
    return usgsLatestStationValue(station.id, payload);
  }
  return null;
}

/**
 * Compact display label for a station's primary value. Snow Water
 * Equivalent keeps its conventional SWE shorthand; storage readings get a
 * thousands separator; everything else renders label, value, and unit as
 * the source reported them.
 */
function formatStationValue(value: StationValue): string {
  const label = value.parameter === 'snow_water_equivalent_in' ? 'SWE' : value.label;
  const wantsThousands =
    value.parameter === 'reservoir_storage_acft' || value.parameter === 'discharge_cfs';
  const num =
    wantsThousands && value.value !== null
      ? value.value.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : String(value.value);
  const day = value.timestamp ? ` · ${shortReadingDate(value.timestamp.slice(0, 10))}` : '';
  const staleNote = value.freshness === 'stale' ? ' (stale)' : '';
  return `${label} ${num} ${value.unit}${day}${staleNote}`;
}

/**
 * Hydrate the sidebar station rows that have a live-value source wired
 * (NRCS SNOTEL, USBR Hydromet/AgriMet, USACE CWMS, USGS Instantaneous
 * Values). Stations without a fetcher keep the `unknown` state (an empty
 * slot), which is honest: nothing was attempted.
 *
 * Each station renders its primary parameter compactly (the 400 pixel
 * embed is first-class), with the reading date, "(stale)" appended when
 * the reading is older than its freshness window, or "values
 * unavailable" on fetch failure. A zero reading renders as 0; summer
 * snowpack is legitimately zero.
 */
function hydrateStationValues(): void {
  stationValuesController = new AbortController();
  const signal = stationValuesController.signal;

  for (const station of TELEMETRY_STATIONS) {
    if (!station.awdbStation && !station.hydrometParams && !station.cwms && !station.usgsSite)
      continue;
    const slot = document.querySelector<HTMLElement>(
      `[data-station-values="${cssAttrEscape(station.id)}"]`
    );
    if (!slot) continue;

    slot.textContent = 'loading...';
    slot.className = 'telemetry-values loading';

    void fetchPrimaryStationValue(station, signal)
      .then((value) => {
        if (signal.aborted || !slot.isConnected) return;
        if (!value || value.value === null) {
          slot.textContent = 'values unavailable';
          slot.className = 'telemetry-values unavailable';
          return;
        }
        slot.textContent = formatStationValue(value);
        slot.className = `telemetry-values ${value.freshness}`;
      })
      .catch(() => {
        if (signal.aborted || !slot.isConnected) return;
        slot.textContent = 'values unavailable';
        slot.className = 'telemetry-values unavailable';
      });
  }
}

/**
 * Registry hook for the value lifecycle: first telemetry activation
 * hydrates once per session; a telemetry layer-off aborts anything still
 * in flight (CLAUDE.md section 6 invariant 5). Values already rendered
 * stay rendered; the list is catalog metadata plus last-known readings,
 * not something to blank on toggle.
 */
function onActiveChangeForStationValues(active: ReadonlySet<string>): void {
  if (active.has('telemetry') && !stationValuesHydrated) {
    stationValuesHydrated = true;
    hydrateStationValues();
  } else if (!active.has('telemetry') && stationValuesController) {
    stationValuesController.abort();
    stationValuesController = null;
  }
}

/**
 * Toggle the telemetry layer on if it is currently off, by routing
 * through the same checkbox change handler the user would. This keeps
 * the registry, URL, and DOM checkbox in sync with whatever the layer
 * module needs to do on activation.
 *
 * No-op when the telemetry layer is already active or when the
 * checkbox is missing from the DOM (defensive; should not happen in
 * practice).
 */
function ensureTelemetryActive(_map: maplibregl.Map): void {
  if (registry.getActiveKeys().has('telemetry')) return;
  const cb = document.querySelector<HTMLInputElement>(
    'input[data-layer-key="telemetry"]'
  );
  if (!cb) return;
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
}

// ---------------------------------------------------------------------------
// Top-level event wiring (share / reset / collapse / expand / resize)
// ---------------------------------------------------------------------------

/**
 * Wire the share / reset buttons, the sidebar collapse / expand
 * controls, and the debounced viewport resize handler that keeps
 * `map.resize()` in sync with the container.
 *
 * The share button defers to `wireShareButton` from `./share`, which
 * uses `showToast` from `./overlay` for its success / failure
 * feedback. The vanilla baseline's inline toast is now obsolete.
 */
function wireTopLevelEvents(map: maplibregl.Map): void {
  wireShareButton('share-btn');

  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (STATE.currentRegion) {
        selectRegion(map, STATE.currentRegion);
      }
    });
  }

  const collapseBtn = document.getElementById('sidebar-collapse');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      const app = document.getElementById('app');
      if (app) app.classList.add('sidebar-collapsed');
      // Allow the CSS grid transition to settle before resizing the
      // map. The 220 ms delay matches the vanilla baseline.
      window.setTimeout(() => {
        map.resize();
      }, 220);
    });
  }

  const expandBtn = document.getElementById('sidebar-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const app = document.getElementById('app');
      if (app) app.classList.remove('sidebar-collapsed', 'embed');
      // Expanding always exits embed mode so the user gets the full
      // chrome back. Persist that to the URL so a refresh holds.
      STATE.embed = false;
      pushUrl();
      window.setTimeout(() => {
        map.resize();
      }, 220);
    });
  }

  // Debounced resize handler: rapid resize events (mobile rotation,
  // browser address-bar collapse) coalesce into a single map.resize().
  let resizeTimer: number | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      map.resize();
      resizeTimer = null;
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// Boot-time URL application
// ---------------------------------------------------------------------------

/**
 * Apply the parsed URL state at boot: set the embed class, fit the
 * region without animation, and toggle each requested layer on.
 *
 * Activation is concurrent across layers (`Promise.allSettled`) so a
 * single slow or failing layer does not delay the rest. Each
 * activation goes through the same path as a user-initiated toggle
 * (loading indicator, registry update, status pill).
 */
async function applyUrlState(map: maplibregl.Map): Promise<void> {
  const params = parseUrlParams();
  STATE.embed = params.embed;

  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('embed', params.embed);
  }

  // Initial region fit; suppress animation so the user does not see a
  // long fly-to on first paint.
  selectRegion(map, params.region, true);

  const tasks: Array<Promise<void>> = [];
  for (const key of params.layers) {
    const def = getLayerDef(key);
    if (!def) continue;
    const cb = document.querySelector<HTMLInputElement>(
      `input[data-layer-key="${cssAttrEscape(key)}"]`
    );
    if (cb) cb.checked = true;
    tasks.push(activateLayerWithIndicator(map, def, cb ?? createDetachedCheckbox()));
  }
  await Promise.allSettled(tasks);
}

/**
 * Fallback checkbox for `applyUrlState` when the DOM lookup yields
 * `null` (an unknown layer key listed in the URL). The activation
 * path needs an HTMLInputElement to uncheck on failure; this
 * detached element absorbs that without affecting the DOM.
 */
function createDetachedCheckbox(): HTMLInputElement {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  return cb;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Build the sidebar UI and wire every event the sidebar owns. Called
 * once from `boot()` in `src/main.ts` after the map has fired `load`.
 *
 * `onRegionSelect` is invoked whenever the user picks a region (click
 * or arrow-key). The orchestrator can listen if it wants to react
 * outside the sidebar; the sidebar always calls `selectRegion`
 * internally regardless of what the orchestrator does.
 */
export function buildSidebar(
  map: maplibregl.Map,
  onRegionSelect: (key: RegionKey) => void
): void {
  mapRef = map;
  ensureLiveRegion();

  const handleRegion = (key: RegionKey): void => {
    selectRegion(map, key);
    onRegionSelect(key);
  };

  buildConditionsStrip(map);
  buildRegionButtons(map, handleRegion);
  buildPresetChips(map);
  buildLayerToggles(map);
  buildTelemetryList(map);
  wireTopLevelEvents(map);

  // Subscribe to the registry. `change` drives URL sync + active-count
  // pill; `status-change` drives the per-layer pill text + live region.
  registry.on('change', (active) => {
    pushUrl();
    updateActiveCountPill(active);
    onActiveChangeForStationValues(active);
  });
  registry.on('status-change', (key, status) => {
    setLayerStatusInPill(key, status);
  });

  // Apply the URL state. If parsing fails (no params), we fall back to
  // the default region and the default-on layer set, both of which are
  // handled inside `applyUrlState` via `parseUrlParams`.
  void applyUrlState(map).catch((err: unknown) => {
    console.error('[sidebar] applyUrlState failed:', err);
    // Defensive fallback: at least fit the default region so the user
    // sees the map.
    selectRegion(map, DEFAULT_REGION, true);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe use inside a CSS attribute selector. The
 * layer keys and region keys we accept are restricted (kebab-case
 * identifiers) so this is defensive rather than load-bearing, but it
 * keeps the behavior correct if a future config table introduces a
 * key with a quote or backslash.
 */
function cssAttrEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Re-export internal handles for test harnesses and the toast helper.
 * `showToast` is re-exported so the orchestrator can surface
 * embed-mode messages without importing from `./overlay` directly when
 * the sidebar is the only UI module already in scope.
 */
export { showToast };

/**
 * Read-only getter for the cached map reference. Exists so future test
 * harnesses can assert that `buildSidebar` was called; the harness
 * checks this is non-null after boot.
 */
export function getMapRef(): maplibregl.Map | null {
  return mapRef;
}
