/**
 * Sidebar UI lifecycle for the Dynamic Drought Module (DDM).
 *
 * This module is the TypeScript port of the vanilla `app.js` UI builders
 * (`buildRegionButtons`, `buildLayerToggles`, `buildTelemetryList`),
 * status-pill helper (`setLayerStatus`), and `wireTopLevelEvents`. It also
 * picks up the accessibility quick wins:
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
 *   2. Per-layer status pills: rendered by the Preact island (the
 *      `resolveStatusPillText` copy lives in `src/ui/island/pill-text.ts`),
 *      driven by the registry's `status-change` event. The once-frozen
 *      named export `setLayerStatusInPill` no longer
 *      exists as a function; the island subscription replaced it
 *      (corrected 2026-07-28, ground-truth audit).
 *
 * Deviation note (recorded deliberately): the kickoff prescribed
 * splitting share, overlay, and sidebar into three files. We keep the
 * three-file split, with this module owning only the sidebar lifecycle.
 * `wireShareButton` lives in `./share`; `showLoading` / `hideLoading` /
 * `showToast` live in `./overlay`. The sidebar imports both.
 *
 * ISLAND NOTE (ADR 0002, D-0.7.0-021): the layers catalog, the status
 * pills, and the conditions strip are rendered by the Preact island in
 * `./island/`, loaded via dynamic import so the framework rides a lazy
 * chunk (condition 1). The view adapter's checkbox reads and writes go
 * through the eager `./island/bridge` store (buffered until the island
 * mounts); the live-region announcements stay here. Boot is split per
 * the ADR's U1 integration note: the embed class, the timeline seed,
 * and the region fit apply synchronously; only the layer-set activation
 * chains on the island mount.
 *
 * Stewardship: no Tribal, Treaty, or sovereign-jurisdiction data is
 * surfaced in this module. All region and layer labels come from the
 * config tables in `src/config/`.
 */

import maplibregl from 'maplibre-gl';

import {
  LAYER_DEFS,
  getLayerDef,
  resetDroughtSurfacePresentation,
  setDroughtSurfacePresentation
} from '../config/layers';
import { MOBILE_HAZARD_PRESETS, VIEW_PRESETS } from '../config/presets';
import type { ViewPreset } from '../config/presets';
import {
  REGIONS,
  DEFAULT_REGION,
  regionToMapLibreBounds
} from '../config/regions';
import type { RegionKey, Region } from '../config/regions';
import { regionCapabilityLevel } from '../config/region-capability';
import { TELEMETRY_STATIONS } from '../config/telemetry';
import { registry } from '../state/registry';
import { createLayerController } from '../state/layer-controller';
import type { LayerController, LayerControllerView } from '../state/layer-controller';
import { openStateBriefing } from '../state/deep-link';
import {
  isCurrentBriefingIntent,
  nextBriefingIntent,
  openImpactPanel,
  closeImpactPanel
} from './impact-panel';
import { getPlaceSelection, onPlaceSelectionChange } from '../state/place-selection';
import {
  ensureBriefHeadSearch,
  ensureBriefHeadTribalAction,
  refreshLayersStudioEntry,
  renderStudioLoadFailure
} from './view-shell';
import { prefersReducedMotion } from '../util/motion';
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
import type { ParsedUrlParams } from '../state/url';
import {
  getStudioRoute,
  initializeStudioRoute,
  isPhysicallyFramed,
  onStudioRouteChange
} from '../state/studio-route';
import type {
  StudioRoute,
  StudioRouteChangeSource
} from '../state/studio-route';
import {
  getViewMode,
  onViewModeChange,
  setViewMode,
  setExplicitBriefBoot
} from '../state/view-mode';
import { installPopupViewportContainment } from './popup-viewport';
import { getBasemapMode, onBasemapChange, setBasemapMode } from '../state/basemap-store';
import { getFraming, onFramingChange, setFraming } from '../state/framing-store';
import {
  clearOceanFraming,
  getHazardCluster,
  getOceanFraming,
  onHazardClusterChange,
  setHazardCluster
} from '../state/cluster-store';
import { reconcileClusterWithLayerIntent } from '../state/cluster-service';
import {
  ALL_FRAMING_BOUNDS,
  FRAMING_KEYS,
  FRAMINGS,
  framingFitBounds
} from '../config/framings';
import type { FramingKey } from '../config/framings';
import { OCEANS } from '../config/oceans';
import { applyBasemapMode, requestBasemapMode } from '../map/basemap-switcher';
import { timeline } from '../state/timeline';
import { resolveStatusPillText } from './island/pill-text';
import {
  isChecked as bridgeIsChecked,
  setChecked as bridgeSetChecked,
  checkedSnapshot as bridgeCheckedSnapshot,
  onCheckedChange as bridgeOnCheckedChange
} from './island/bridge';
import { bindLayerToggleController, requestLayerOn } from './layer-toggle-command';
import { getSheetDetent, isSheetActive, revealSheetAtPeek, setSheetDetent } from './mobile-sheet';
import { wireShareButton } from './share';
import { showToast } from './overlay';
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

/**
 * The layer-activation controller (the extracted spine, D-ARCH-004). Created
 * once in `buildSidebar` with the map plus the DOM view adapter below; the
 * toggle rows, preset chips, and the URL-boot path drive layer state through
 * it. Held module-level, mirroring `mapRef`, so the DOM builders can reach it
 * without threading it through every signature.
 */
let controllerRef: LayerController | null = null;

/**
 * The island mount trigger, set by `buildSidebar` (a closure over the map
 * and controller). Callers outside the boot path (the sidebar-expand
 * handler, the view shell's mode switch) use `mountSidebarIslandNow` to
 * bring the catalog up when a brief embed deferred it (headroom C1).
 */
let onIslandNeeded: (() => Promise<void>) | null = null;

let onStudioRouteNeeded:
  | ((route: StudioRoute, source: StudioRouteChangeSource) => void)
  | null = null;

/** Mount the catalog/strip island if it is not already mounted or mounting. */
export function mountSidebarIslandNow(): Promise<void> {
  return onIslandNeeded?.() ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Status announcements (pill DOM moved to the island)
// ---------------------------------------------------------------------------

/**
 * Announce a layer status transition to the polite live region so a
 * screen-reader user hears "Hydrography: live". The pill DOM itself is
 * rendered by the island's catalog component from the registry mirror
 * (ADR 0002, D-0.7.0-021); the pill text table is shared from
 * `./island/pill-text` so the two surfaces can never drift.
 */
function announceLayerStatus(key: string, status: LayerStatus): void {
  const def = getLayerDef(key);
  const friendly = def ? def.name : key;
  announce(`${friendly}: ${resolveStatusPillText(status, def?.noDataLabel)}`);
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

  // A region without impact-synthesis capability cannot inherit a briefing
  // from the prior region. The matrix is authoritative: closing here aborts
  // hydration, clears the panel-owned place selection, and drops the mobile
  // at-hand briefing before the new region is presented or printed.
  if (regionCapabilityLevel(key, 'impactSynthesis') === 'none') {
    closeImpactPanel();
  }

  // An EXPLICIT region choice (click or arrow-key; silent marks the boot
  // fit) is a legacy camera gesture: it clears the minimap camera and drops
  // any ocean camera claim, so the URL never asserts
  // two cameras at once (S2, D-0.7.0-041/044/053). The hazard cluster
  // itself persists (camera gestures never change the display).
  if (!silent) {
    setFraming(null);
    clearOceanFraming();
  }

  STATE.currentRegion = key;
  if (key === 'british_columbia') {
    setDroughtSurfacePresentation({
      edition: 'bc-basin',
      name: 'British Columbia Basin Drought Levels',
      source: 'Province of British Columbia · source date loads with data',
      sourceDate: null
    });
  } else {
    resetDroughtSurfacePresentation();
  }
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
      // Suppress the fit animation for reduced-motion users (WCAG 2.3.3, #7).
      animate: !silent && !prefersReducedMotion()
    }
  );

  syncRegionSelect();

  // Keep the keyboard briefing trigger in sync with the active region (#9).
  updateRegionBriefingTrigger(key);

  pushUrl();
}

/**
 * The `layers` value for EVERY URL write is the bridge's checkbox INTENT:
 * the one synchronous store every door writes (the catalog checkbox, the
 * shared toggle command and with it the Tribal Nations action, presets,
 * surface exclusivity, the boot seeding below, and the controller's
 * failure cleanup). Never the registry's completion-order active set, and
 * never a frozen boot snapshot. This closes both halves of the URL-race
 * pair the umbrella reviews converged on (Codex Unit E finding 1; the
 * final-pass finding 1; the independent code review's boot-window
 * finding): a bare or deep-link boot serializes its full parsed set from
 * the first write, a user action during boot or during any in-flight
 * activation serializes the moment intent is declared, and a terminal
 * activation failure unchecks the bridge so the failed key self-corrects
 * out of the URL. Unknown URL keys never enter the bridge (the boot seed
 * validates against getLayerDef, exactly like applyLayerSet), so the
 * canonical rewrite still drops them (URL policy rules 2 and 7).
 */
function checkedLayerKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [key, on] of bridgeCheckedSnapshot()) {
    if (on) keys.add(key);
  }
  return keys;
}

/**
 * Push the current region + intended-layers + embed state to the URL. A
 * thin wrapper so callers do not have to assemble the snapshot.
 */
function pushUrl(): void {
  // Camera exclusivity (S2): while a minimap camera is active the URL carries
  // `framing=` INSTEAD of `region=` (one camera vocabulary claimed at a
  // time); `framing=all` preserves the explicit North American ALL fit, while
  // null keeps the legacy region emission. The cluster/ocean pair rides the durable-truth model inside
  // syncUrl (D-0.7.0-044): a clean cluster replaces `layers=`.
  const framing = getFraming();
  syncUrl({
    region: framing !== null ? null : STATE.currentRegion,
    layers: checkedLayerKeys(),
    embed: STATE.embed,
    view: getViewMode(),
    usdmWeek: timeline.usdmWeek,
    usdmMode: timeline.usdmMode,
    sstDate: timeline.sstDate,
    outlookRange: timeline.outlookRange,
    horizon: timeline.horizon,
    basemap: getBasemapMode(),
    framing,
    cluster: getHazardCluster(),
    ocean: getOceanFraming(),
    studio: getStudioRoute()
  });
}

// ---------------------------------------------------------------------------
// Region and minimap-framing selector
// ---------------------------------------------------------------------------

function syncRegionSelect(): void {
  const select = document.getElementById('region-select');
  if (!(select instanceof HTMLSelectElement)) return;
  const framing = getFraming();
  select.value = framing !== null
    ? `framing:${framing}`
    : `region:${STATE.currentRegion ?? DEFAULT_REGION}`;
}

/** Build one dropdown that follows minimap choices while preserving every
 * established detailed `region=` camera as a second option group. */
function buildRegionSelect(
  map: maplibregl.Map,
  onRegionSelect: (key: RegionKey) => void
): void {
  const select = document.getElementById('region-select');
  if (!(select instanceof HTMLSelectElement)) return;
  select.replaceChildren();

  const overviewGroup = document.createElement('optgroup');
  overviewGroup.label = 'North America overview';
  const allOption = document.createElement('option');
  allOption.value = 'framing:all';
  allOption.textContent = 'All of North America';
  overviewGroup.appendChild(allOption);
  for (const key of FRAMING_KEYS) {
    const option = document.createElement('option');
    option.value = `framing:${key}`;
    option.textContent = FRAMINGS[key].label;
    overviewGroup.appendChild(option);
  }

  const detailGroup = document.createElement('optgroup');
  detailGroup.label = 'Detailed regions';
  for (const [key, region] of Object.entries(REGIONS) as Array<[RegionKey, Region]>) {
    const option = document.createElement('option');
    option.value = `region:${key}`;
    option.textContent = region.label;
    option.title = region.description;
    detailGroup.appendChild(option);
  }
  select.append(overviewGroup, detailGroup);

  select.addEventListener('change', () => {
    const [kind, rawKey] = select.value.split(':', 2);
    if (kind === 'region' && rawKey && rawKey in REGIONS) {
      onRegionSelect(rawKey as RegionKey);
      return;
    }
    if (kind !== 'framing') return;
    clearOceanFraming();
    if (rawKey === 'all') {
      setFraming('all');
      map.fitBounds(
        framingFitBounds({ bounds: ALL_FRAMING_BOUNDS, padding: 0 }),
        { padding: 20, animate: !prefersReducedMotion() }
      );
      return;
    }
    if (!rawKey || !(rawKey in FRAMINGS)) return;
    const key = rawKey as FramingKey;
    setFraming(key);
    map.fitBounds(
      framingFitBounds(FRAMINGS[key]),
      { padding: 20, animate: !prefersReducedMotion() }
    );
  });

  // The keyboard-reachable drought impact briefing trigger (critical-review
  // #9). It sits after the radiogroup as an ordinary tabbable button (not part
  // of the roving-tabindex group), so a keyboard user reaches it with one Tab.
  // It opens the selected region's anchored state briefing, the same panel a
  // map click builds; selectRegion() shows/labels or hides it per region. Being
  // a real focusable opener, it also completes the impact panel's focus-restore
  // (#16): focus returns here when the briefing closes.
  const briefingBtn = document.createElement('button');
  briefingBtn.type = 'button';
  briefingBtn.id = 'region-briefing-btn';
  briefingBtn.className = 'region-briefing-btn';
  briefingBtn.hidden = true;
  briefingBtn.addEventListener('click', () => {
    // Front door (F3): a selected map place takes precedence, opening the same
    // briefing its boundary popup would. Otherwise fall back to the
    // region-anchored briefing. The anchor path resolves after an async
    // boundary fetch, so it carries the standard yield guard: any panel
    // interaction after THIS click (another open, an Escape close) wins
    // over this one instead of being stomped by its late resolve.
    const place = getPlaceSelection();
    if (place) {
      openImpactPanel(place.context);
      return;
    }
    const anchor = STATE.currentRegion ? REGIONS[STATE.currentRegion]?.briefing : undefined;
    if (!anchor) return;
    const intent = nextBriefingIntent();
    void openStateBriefing(map, anchor.id, {
      fit: false,
      guard: () => isCurrentBriefingIntent(intent)
    });
  });
  select.insertAdjacentElement('afterend', briefingBtn);
  // Reflect the region active at build time (boot applies it again via selectRegion).
  syncRegionSelect();
  updateRegionBriefingTrigger(STATE.currentRegion);
}

/**
 * Show, label, or hide the region-briefing trigger for the active region (#9).
 * A region with a briefing anchor shows an explicit trigger naming the boundary
 * the briefing describes; a region that spans several states (or the national
 * framing) has no anchor and hides the trigger.
 */
function updateRegionBriefingTrigger(regionKey: RegionKey | null | undefined): void {
  const btn = document.getElementById('region-briefing-btn');
  if (!(btn instanceof HTMLButtonElement)) return;
  // A selected map place takes precedence over the region anchor (F3, the
  // answer-first front door): the button becomes "See what this means" for the
  // place the user just clicked.
  const place = getPlaceSelection();
  if (place) {
    btn.hidden = false;
    btn.textContent = 'See what this means';
    btn.setAttribute('aria-label', `See what the drought means for ${place.label}`);
    return;
  }
  const anchor = regionKey ? REGIONS[regionKey]?.briefing : undefined;
  if (!anchor) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = `Drought impact briefing: ${anchor.label}`;
  btn.setAttribute('aria-label', `Open the drought impact briefing for ${anchor.label}`);
}

// ---------------------------------------------------------------------------
// Layer toggles: rendered by the island (ADR 0002, D-0.7.0-021)
//
// The vanilla `buildLayerToggles` / `buildLayerToggle` builders and the
// `clearLayerStatusPill` helper are replaced by the island's catalog
// component (`./island/catalog.tsx`), which renders the same DOM contract
// (checkboxes at `input[data-layer-key]`, pills at `[data-layer-status]`,
// role groups per UX-1) from the registry and the bridge intent store.
// The explicit pill clear became unnecessary: the registry deletes a
// key's status on deactivate and the island derives pill text from the
// registry, so the empty pre-activation state falls out of the data.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// View preset chips (UX-2)
// ---------------------------------------------------------------------------

/**
 * Build the question-first preset chip row from `VIEW_PRESETS`. Each chip
 * is a plain button (not a toggle: presets set state without locking it,
 * so no chip carries a pressed state) whose click applies the preset's
 * layer-set and any explicit preferred basemap. The tooltip carries the
 * question the preset answers.
 */
function applyViewPreset(map: maplibregl.Map, preset: ViewPreset): void {
  if (!controllerRef) return;
  controllerRef.applyPreset(preset);
  if (preset.preferredBasemap) {
    requestBasemapMode(map, preset.preferredBasemap);
  }
}

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
    // Preset application (deactivate the non-wanted, activate the wanted,
    // preserving the at-most-one-surface invariant) now lives in the
    // controller; the chip is a thin trigger.
    btn.addEventListener('click', () => {
      applyViewPreset(map, preset);
      // Mobile shell (the mockup's rule 5): a quick view applies its
      // preset and closes the sheet so the map answers. Desktop is
      // untouched (the sheet is never active there).
      if (isSheetActive()) {
        const d = getSheetDetent();
        if (d === 'half' || d === 'full') setSheetDetent('closed');
      }
    });
    container.appendChild(btn);
  }
}

/**
 * Wire the mobile hazard rail (0.7.0 mobile shell; the ratified 2026-07-11
 * mockup's lower-right thumb rail). The rail's markup is static in
 * index.html; visibility is stylesheet-gated to the mobile shell's
 * map-visible detents, so this wiring is inert on desktop and in embed.
 * Each button applies its hazard preset through the one controller, requests
 * its preferred basemap when declared, and then an open sheet closes to the
 * edgeless map (the mockup: a quick select is a
 * request to SEE the hazard map). The pressed state REFLECTS the registry
 * (the rail and the catalog share one state, per the mockup): a button
 * reads pressed while its surface layer is actually active, so the rail
 * never claims a hazard the map is not showing.
 */
function wireHazardRail(map: maplibregl.Map): void {
  const rail = document.getElementById('hazard-rail');
  if (!rail) return;
  const buttons: Array<{ btn: HTMLButtonElement; surface: string }> = [];
  for (const btn of rail.querySelectorAll<HTMLButtonElement>('button[data-preset]')) {
    const preset = MOBILE_HAZARD_PRESETS.find((p) => p.key === btn.dataset.preset);
    if (!preset) continue;
    btn.title = preset.description;
    btn.setAttribute('aria-label', preset.description);
    // The preset's first layer is its condition surface (the table is
    // ordered surface-first); the pressed state mirrors that layer.
    const surface = preset.layers[0] ?? '';
    buttons.push({ btn, surface });
    btn.addEventListener('click', () => {
      applyViewPreset(map, preset);
      if (isSheetActive()) {
        const d = getSheetDetent();
        if (d === 'half' || d === 'full') setSheetDetent('closed');
      }
    });
  }
  if (buttons.length === 0) return;
  const reflect = (): void => {
    const active = registry.getActiveKeys();
    for (const { btn, surface } of buttons) {
      btn.setAttribute('aria-pressed', String(active.has(surface)));
    }
  };
  registry.on('change', reflect);
  reflect();
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
      // Dynamic import (ADR 0002 condition 7, the entry-diet unit): a
      // static `flyToStation` import here was the ONE eager edge into
      // src/layers/telemetry, and it dragged that module plus
      // src/ui/popups plus the whole station registry into the entry
      // chunk, defeating the catalog's lazy split (Rolldown warned
      // INEFFECTIVE_DYNAMIC_IMPORT on every build). The activation
      // above already loads the same chunk, so this import resolves
      // from cache or joins the in-flight fetch.
      void import('../layers/telemetry')
        .then(({ flyToStation }) => {
          flyToStation(map, station.id);
        })
        .catch((err: unknown) => {
          console.error('[sidebar] telemetry fly-to failed to load:', err);
        });
    });
    container.appendChild(item);
  }
}

/**
 * Wire the Water & Snow panel's reveal disclosure (U3f2, D-0.7.0-018). The
 * telemetry panel is collapsed by default: its featured-station list is
 * opt-in, matching the telemetry layer leaving the default-on set (H4). The
 * button toggles the collapsible body and its own `aria-expanded`. This is
 * sidebar-local presentation only; revealing the panel never activates or
 * deactivates the telemetry layer.
 */
function wireTelemetryReveal(): void {
  const btn = document.getElementById('telemetry-reveal');
  const body = document.getElementById('telemetry-body');
  if (!(btn instanceof HTMLButtonElement) || !body) return;
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    body.hidden = expanded;
  });
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
    // The skeleton-shimmer marks the network wait; each terminal branch below
    // reassigns className without it, so the shimmer clears on its own.
    slot.className = 'telemetry-values loading skeleton-shimmer';

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
 * in flight (the cancellation invariant). Values already rendered
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
 * The telemetry list's click-through, via the shared toggle command
 * (ADR 0002 condition 2, D-0.7.0-008): the DOM-free door every
 * non-checkbox caller takes, so it works before the island mounts.
 */
function ensureTelemetryActive(_map: maplibregl.Map): void {
  requestLayerOn('telemetry');
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
      // chrome back. Persist that to the URL so a refresh holds. A brief
      // embed deferred the catalog island (headroom C1); the full chrome
      // needs it, so mount it now (idempotent). The Brief-head search was
      // gated by the same C1 rule at boot, so remount it too (the U3
      // stage-5 minor 7 fix: without this, a desktop expand from a brief
      // embed left an empty #brief-search host until a reload).
      STATE.embed = false;
      void mountSidebarIslandNow();
      ensureBriefHeadSearch(map);
      // An embed boot hosts the Tribal Nations Brief-door action on the
      // impact panel (or nowhere, if the panel builds after this exit);
      // the full chrome's host is the Brief head. Idempotent (Codex
      // S2/E1 integration finding 2).
      ensureBriefHeadTribalAction();
      pushUrl();
      refreshLayersStudioEntry();
      onStudioRouteNeeded?.(getStudioRoute(), 'push');
      // Below 720px the post-embed chrome is the bottom sheet, revealed
      // at peek (the ratified embed-exit path, D-0.7.0-017); a desktop
      // expand is a no-op inside the helper.
      revealSheetAtPeek();
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
 * Apply the SYNCHRONOUS half of the parsed URL state at boot: the embed
 * class, the temporal seed, and the region fit. Returns the parsed
 * params so the caller can chain the layer-set activation separately.
 *
 * The split is the ADR 0002 U1 integration requirement: the parked
 * spike branch chained ALL of the URL application on the island mount,
 * which also delayed the `.embed` class and the initial region fit, so
 * a slow island chunk could flash non-embed chrome for a beat. The
 * first-paint state (embed chrome, camera) must never wait on a lazy
 * chunk; only the layer-set activation does (see `buildSidebar`).
 */
function applyUrlStateSync(map: maplibregl.Map): ParsedUrlParams {
  const params = parseUrlParams();
  STATE.embed = params.embed;

  // Seed the view mode BEFORE the first pushUrl below (selectRegion syncs
  // the URL, and the URL must carry the derived mode from its first write).
  setViewMode(params.view);

  // Record the RAW explicit-view ask beside the mode (U-UX-FIX-1 DEF-2):
  // once the first pushUrl stamps `view=` onto every URL, only this
  // parse-time flag still distinguishes a shared `?view=brief` link from
  // a bare boot's derived Brief mode. The mobile sheet consumes it at its
  // boot activation (see initMobileSheet) to honor the shared link with
  // the half-detent Brief surface while a bare boot stays map-first
  // closed (D-0.7.0-041).
  setExplicitBriefBoot(params.explicitView && params.view === 'brief');

  // Seed the region-shell stores (S2) BEFORE the first pushUrl for the
  // same reason: a `framing=` or `cluster=` deep link must survive the
  // first canonical write. The parser already resolved the precedence
  // pairs (`layers=` outranks `cluster=`; `ocean=` needs cluster=enso),
  // so the seeds are the committed truth.
  setFraming(params.framing);
  setHazardCluster(params.cluster, params.ocean);

  // Seed the temporal store BEFORE any layer activates, so a layer module
  // that reads the timeline during activate() (USDM restoring a scrubbed
  // week, SST restoring a frame date) sees the URL's temporal state.
  timeline.setUsdmWeek(params.usdmWeek);
  timeline.setUsdmMode(params.usdmMode);
  timeline.setSstDate(params.sstDate);
  timeline.setOutlookRange(params.outlookRange);
  // Seed the committed horizon after the outlook register. The horizon
  // owns the register mapping for explicit horizon deep links; otherwise
  // the rendered drought surface commits its own honest temporal claim.
  timeline.setHorizon(params.horizon);

  // Seed the basemap mode BEFORE the first pushUrl for the same reason as
  // the view mode: a `basemap=satellite` deep link must survive the first
  // canonical write. The satellite layer itself rides a lazy chunk, so the
  // visual switch is kicked off here and settles asynchronously (the
  // desaturated default paints first; the U1 boot-split precedent).
  setBasemapMode(params.basemap);
  if (params.basemap === 'satellite') {
    void applyBasemapMode(map, 'satellite');
  }

  // The studio composes with all map state. Seed it only after every
  // underlying store above is ready, and before selectRegion performs the
  // first canonical URL write. A non-embed direct studio boot synthesizes
  // its map predecessor so Back to map never leaves the application; an
  // embed or physical-frame boot never mounts a studio, so it skips the
  // synthesis.
  initializeStudioRoute(params.studio, {
    synthesizeReturnEntry: !params.embed && !isPhysicallyFramed()
  });

  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('embed', params.embed);
  }

  // Initial region fit; suppress animation so the user does not see a
  // long fly-to on first paint. This runs even when a framing or ocean
  // camera follows (below): selectRegion also owns the region-state
  // bookkeeping (STATE.currentRegion, the radio marks, the store
  // mirror), and both fits are instant in the same task, so only the
  // winning camera ever paints.
  selectRegion(map, params.region, true);

  // The boot camera precedence (S2): `ocean=` (the most specific gesture,
  // pairing display with camera, D-0.7.0-053) wins over `framing=`
  // (D-0.7.0-039/041), which wins over the legacy `region=` fit above.
  // Both are camera-only: they select nothing and brief nothing.
  const cameraDef = params.ocean
    ? OCEANS[params.ocean]
    : params.framing === 'all'
      ? { bounds: ALL_FRAMING_BOUNDS, padding: 0 }
      : params.framing
        ? FRAMINGS[params.framing]
        : null;
  if (cameraDef) {
    map.fitBounds(
      framingFitBounds(cameraDef),
      { padding: 20, animate: false }
    );
  }

  return params;
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

  // U-UX-FIX-1 DEF-3/DEF-4 (triage 2026-07-24): clamp every MapLibre
  // popup card toward its reachable region (the visual viewport
  // intersected with the map container, minus the active mobile sheet
  // and footer rects) under the tiered contract of THE CANONICAL TIER
  // TABLE beside the boundary constants in popup-viewport.ts (the one
  // authoritative statement of what each region size is promised), so
  // the scroll region genuinely overflows and the close control sits in
  // reachable pixels wherever that table promises them. Installed here
  // because buildSidebar runs on every boot path (embeds included),
  // before any layer can paint a popup.
  installPopupViewportContainment();

  // The activation state machine lives in the controller now (D-ARCH-004).
  // The checkbox reads and writes go through the eager island bridge instead
  // of the DOM (ADR 0002): the bridge is the one source of truth for checkbox
  // intent, written synchronously by both this adapter and the island's own
  // change handler, and it buffers boot writes made before the lazy island
  // mounts. The island renders the checkbox DOM from it, so the two can
  // never disagree.
  const view: LayerControllerView = {
    setCheckbox(key, checked) {
      bridgeSetChecked(key, checked);
    },
    isCheckboxChecked(key) {
      return bridgeIsChecked(key);
    },
    clearLayerStatus() {
      // Intentionally empty: the registry deletes a key's status on
      // deactivate and the island derives pill text from the registry
      // mirror, so the empty pre-activation pill falls out of the data
      // instead of an imperative clear.
    },
    announce(message) {
      announce(message);
    }
  };
  controllerRef = createLayerController(map, view);
  // Arm the shared toggle command (ADR 0002 condition 2): the DOM-free
  // door for the time bar's instrument switches, the ENSO driver, the
  // telemetry list, and the conditions tiles. Bound before any DOM
  // builder or boot path can invoke it.
  bindLayerToggleController(controllerRef);

  const handleRegion = (key: RegionKey): void => {
    selectRegion(map, key);
    onRegionSelect(key);
  };

  buildRegionSelect(map, handleRegion);
  buildPresetChips(map);
  wireHazardRail(map);
  buildTelemetryList(map);
  wireTelemetryReveal();
  wireTopLevelEvents(map);

  // Mount the view island (the catalog and the conditions strip) from its
  // lazy chunk (ADR 0002 condition 1). Checkbox intent buffers in the bridge
  // and the registry holds the statuses, so the island snapshots both at
  // mount; a mount failure degrades to a map without a catalog rather than
  // a dead app (the boot chain below proceeds regardless).
  //
  // PER-MODE IMPORT (U1, headroom C1): a BRIEF EMBED never downloads the
  // catalog chunk at boot; the collapsed sidebar shows nothing the island
  // renders, the briefing panel is the surface, and every activation door
  // is DOM-free through the shared toggle command since U1b. The mount is
  // deferred, not dropped: expanding the sidebar or switching to console
  // calls `ensureIslandMounted` below, and the island snapshots the bridge
  // and the registry at that moment, so a late mount is always consistent.
  const controllerForIsland = controllerRef;
  let islandPromise: Promise<void> | null = null;
  const ensureIslandMounted = (): Promise<void> => {
    if (!islandPromise) {
      // The search controller rides the same lazy chunk as the island (U3d):
      // it reaches impact / deep-link, which the pure island must not, so it
      // stays outside the island and is injected as props. Loading it here
      // keeps it off the entry chunk.
      islandPromise = Promise.all([import('./island'), import('./search-controller')])
        .then(([{ mountSidebarIsland }, { buildSearchWiring }]) => {
          mountSidebarIsland(map, controllerForIsland, buildSearchWiring(map));
        })
        .catch((err: unknown) => {
          console.error('[sidebar] island mount failed:', err);
        });
    }
    return islandPromise;
  };
  onIslandNeeded = ensureIslandMounted;

  let studioRoot: HTMLElement | null = null;
  let studioModule: typeof import('./island/layers-studio') | null = null;
  let studioPromise: Promise<typeof import('./island/layers-studio')> | null = null;
  let studioOpener: HTMLElement | null = null;

  const restoreLayersStudioFocus = (opener: HTMLElement | null): void => {
    if (opener?.isConnected) {
      opener.focus({ preventScroll: true });
      return;
    }
    const mapContainer = document.getElementById('map-container');
    if (!mapContainer) return;
    mapContainer.tabIndex = -1;
    mapContainer.focus({ preventScroll: true });
  };

  const loadStudio = (root: HTMLElement): void => {
    const promise = studioPromise ?? import('./island/layers-studio');
    studioPromise = promise;
    void Promise.all([promise, import('./search-controller')])
      .then(([module, { buildSearchWiring }]) => {
        studioModule = module;
        if (
          getStudioRoute() !== 'layers' ||
          STATE.embed ||
          isPhysicallyFramed() ||
          studioRoot !== root
        ) {
          return;
        }
        module.mountLayersStudio(
          root,
          controllerForIsland,
          buildSearchWiring(map, {
            permittedKinds: ['layer'],
            placeholder: 'Search layers'
          })
        );
      })
      .catch((err: unknown) => {
        if (studioPromise === promise) studioPromise = null;
        console.error('[sidebar] LAYERS studio mount failed:', err);
        if (
          getStudioRoute() === 'layers' &&
          !STATE.embed &&
          !isPhysicallyFramed() &&
          studioRoot === root
        ) {
          renderStudioLoadFailure(root, 'layers-studio-failure-heading');
        }
      });
  };

  const syncStudioRoute = (
    route: StudioRoute,
    source: StudioRouteChangeSource
  ): void => {
    if (route === 'layers' && source === 'push') {
      const active = document.activeElement;
      studioOpener =
        active instanceof HTMLElement && active.id === 'layers-studio-entry'
          ? active
          : null;
    }

    if (source === 'popstate') {
      // A studio toggle replaces the pushed studio entry. On the one-step
      // return, rewrite the prior entry from the still-live map state so the
      // URL and the display remain the same snapshot.
      pushUrl();
    }

    if (route !== 'layers' || STATE.embed || isPhysicallyFramed()) {
      if (studioRoot) {
        const opener = studioOpener;
        studioOpener = null;
        if (studioModule) studioModule.unmountLayersStudio(studioRoot);
        studioRoot.remove();
        studioRoot = null;
        restoreLayersStudioFocus(opener);
      }
      return;
    }

    if (!studioRoot) {
      studioRoot = document.createElement('div');
      studioRoot.id = 'layers-studio-root';
      document.body.appendChild(studioRoot);
    }
    const root = studioRoot;
    loadStudio(root);
  };
  onStudioRouteNeeded = syncStudioRoute;
  onStudioRouteChange(syncStudioRoute);

  // Subscribe to the registry. `change` drives URL sync + active-count
  // pill; `status-change` drives the live-region announcement (the pill
  // DOM is the island's).
  registry.on('change', (active) => {
    pushUrl();
    updateActiveCountPill(active);
    onActiveChangeForStationValues(active);
  });
  registry.on('status-change', (key, status) => {
    announceLayerStatus(key, status);
  });

  // Temporal-state changes re-sync the URL the same way layer changes do
  // (invariant 2: the selected week / mode / SST frame is shareable state).
  timeline.onChange(pushUrl);

  // Basemap-mode changes are durable shareable state too (U4d,
  // D-0.7.0-031): `basemap=satellite` must survive every later syncUrl.
  onBasemapChange(pushUrl);

  // The region-shell stores re-sync the URL the same way (S2): a
  // framing change rewrites `framing=`/`region=`, and a cluster change
  // swaps between the one-word `cluster=` claim and the granular
  // `layers=` list (D-0.7.0-044).
  onFramingChange(() => {
    syncRegionSelect();
    pushUrl();
  });
  onHazardClusterChange(pushUrl);

  // The front-door trigger (F3): when a map place is selected or cleared, the
  // region-briefing button relabels to "See what this means" for that place, or
  // reverts to the region anchor.
  onPlaceSelectionChange(() => updateRegionBriefingTrigger(STATE.currentRegion));

  // Apply the URL state, split per the ADR 0002 U1 integration note. The
  // synchronous half (embed class, timeline seed, region fit) applies NOW,
  // so the first paint never waits on a lazy chunk. Only the layer-set
  // activation chains on the island mount settling (success or failure):
  // the vanilla builders ran synchronously before the boot path, so the
  // catalog DOM always existed before any layer activated; the lazy island
  // reopened that window, and the time bar's instrument switches
  // (usdm/drought) still reach for the checkbox DOM until the shared
  // toggle command retires that door (ADR 0002 condition 2). Sequencing
  // the layer set on the mount restores the old guarantee: no layer, and
  // therefore no time bar, can exist before the checkboxes do. Measured
  // cost under regional-4G throttle: +15 ms to the visible pill (ADR 0002
  // condition 8; ruled not material).
  // Seed the bridge's checkbox intent from the parsed URL BEFORE the
  // synchronous state application: its region fit writes the URL, and that
  // write must carry the parsed layer set (the deep-link set or the
  // explicit default list), never an empty pre-boot bridge. Validated
  // against the layer registry so an unknown key survives the LOAD but not
  // the canonical rewrite (URL policy rule 2). applyLayerSet re-asserts the
  // same intent later; setChecked is idempotent.
  try {
    const bootLayers = parseUrlParams().layers;
    // Seed every known key so the cluster service can distinguish an
    // explicit all-off or granular deep link from a pristine bridge.
    for (const def of LAYER_DEFS) {
      bridgeSetChecked(def.key, bootLayers.has(def.key));
    }
  } catch (err) {
    console.error('[sidebar] boot intent seeding failed:', err);
  }
  let bootParams: ParsedUrlParams | null = null;
  try {
    bootParams = applyUrlStateSync(map);
  } catch (err) {
    console.error('[sidebar] URL state application failed:', err);
    // Defensive fallback: at least fit the default region so the user
    // sees the map.
    selectRegion(map, DEFAULT_REGION, true);
  }

  // Every checkbox-intent flip serializes the URL the moment it happens
  // (invariant 2: the URL mirrors what the user asked for, never network
  // completion order). Registered AFTER the synchronous boot application
  // so the seeding loop above cannot emit writes carrying the pre-boot
  // region; user interaction cannot precede this line (it is the same
  // synchronous task). The registry subscription above still writes on
  // activation settle; the two writes are idempotent.
  //
  // The reconcile first (S2, D-0.7.0-044): any intent flip that makes
  // the checked set diverge from the active cluster's composition drops
  // the cluster claim, so this write (and every later one) carries the
  // honest granular `layers=` instead of a cluster the display is not.
  // The boot re-assertions from applyLayerSet are set-equal by
  // construction, so they never clear a cluster boot.
  bridgeOnCheckedChange(() => {
    reconcileClusterWithLayerIntent(checkedLayerKeys());
    pushUrl();
  });

  // The island boot decision (headroom C1): a brief embed defers the
  // catalog chunk entirely; every other boot mounts it now. The mode is
  // authoritative only after applyUrlStateSync seeded it above.
  const isBriefEmbed = (bootParams?.embed ?? false) && getViewMode() === 'brief';
  const islandReady = isBriefEmbed ? Promise.resolve() : ensureIslandMounted();

  // A mode change re-syncs the URL (view= is state, invariant 2) and
  // guarantees the catalog exists for the console door (idempotent).
  onViewModeChange(() => {
    pushUrl();
    void ensureIslandMounted();
  });

  void islandReady
    .then(async () => {
      // Activate the URL/default layer set through the controller. It runs
      // the same activation path a user toggle takes (concurrent across
      // layers via Promise.allSettled), records each row's intent through
      // the view adapter, and tolerates an unknown key honestly.
      if (bootParams && controllerRef) {
        await controllerRef.applyLayerSet(bootParams.layers);
      }
    })
    .catch((err: unknown) => {
      console.error('[sidebar] boot layer activation failed:', err);
    })
    .finally(() => {
      // One canonical post-settle write (URL policy rule 7). Terminal
      // failures already unchecked their bridge intent (each triggering its
      // own write); this is the belt-and-braces canonicalization on the
      // success and failure paths alike.
      pushUrl();
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
