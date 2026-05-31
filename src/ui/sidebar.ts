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
  getLayerDef
} from '../config/layers';
import type { LayerDef } from '../config/layers';
import {
  REGIONS,
  DEFAULT_REGION,
  regionToMapLibreBounds
} from '../config/regions';
import type { RegionKey, Region } from '../config/regions';
import { TELEMETRY_STATIONS } from '../config/telemetry';
import { registry } from '../state/registry';
import { setCurrentRegion } from '../state/region-store';
import type { LayerStatus } from '../types/layer';
import { parseUrlParams, syncUrl } from '../state/url';
import { flyToStation } from '../layers/telemetry';
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
 * Build the layer toggle list from `LAYER_DEFS`. Each entry is a
 * `<label>` wrapping a checkbox plus three text spans (name, source,
 * status pill). The checkbox `change` handler activates or deactivates
 * the corresponding layer module and updates the registry.
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

  for (const def of LAYER_DEFS) {
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
          void activateLayerWithIndicator(map, def, cb);
        } else {
          deactivateLayer(map, def);
        }
      });
    }

    container.appendChild(wrapper);
  }
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
 */
async function activateLayerWithIndicator(
  map: maplibregl.Map,
  def: LayerDef,
  cb: HTMLInputElement
): Promise<void> {
  const token = showLoading(`Loading ${def.name}...`);
  registry.setStatus(def.key, 'loading');
  try {
    await def.module.activate(map);
    registry.activate(def.key);
  } catch (err) {
    console.error(`Layer "${def.key}" failed to load:`, err);
    registry.setStatus(def.key, 'error');
    cb.checked = false;
    registry.deactivate(def.key);
  } finally {
    hideLoading(token);
  }
}

/**
 * Deactivate a layer: call the module's `deactivate` and remove the key
 * from the registry. Synchronous; the deactivate contract is "remove
 * sources/layers and abort in-flight network operations."
 */
function deactivateLayer(map: maplibregl.Map, def: LayerDef): void {
  try {
    def.module.deactivate(map);
  } catch (err) {
    console.error(`Layer "${def.key}" failed to deactivate cleanly:`, err);
  }
  registry.deactivate(def.key);
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
      </span>
    `;
    item.addEventListener('click', () => {
      ensureTelemetryActive(map);
      flyToStation(map, station.id);
    });
    container.appendChild(item);
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

  buildRegionButtons(map, handleRegion);
  buildLayerToggles(map);
  buildTelemetryList(map);
  wireTopLevelEvents(map);

  // Subscribe to the registry. `change` drives URL sync + active-count
  // pill; `status-change` drives the per-layer pill text + live region.
  registry.on('change', (active) => {
    pushUrl();
    updateActiveCountPill(active);
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
