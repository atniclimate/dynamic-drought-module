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

import * as maplibregl from 'maplibre-gl';

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
// The featured-station table (`src/config/telemetry.ts`) is imported
// dynamically inside `ensureTelemetryList` below, not here (DR-008a,
// 2026-09-03). It feeds only the Water & Snow list, which sits behind a
// collapsed reveal, so a boot pays for it on first reveal or first telemetry
// activation, whichever comes first, and never at first paint. The
// activation gate forbids the table from the initial static set.
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
// The four telemetry network adapters (NRCS AWDB, USACE CWMS, USBR
// Hydromet, USGS Instantaneous Values) are imported dynamically inside
// `fetchPrimaryStationValue` below, not here (DR-008a). They were about
// 27.8 kB of source in the entry chunk for work that cannot happen before a
// user reveals the telemetry list, and each station uses exactly one of the
// four, so a boot now pays for none of them.
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
import { seedFire3DPreference } from '../state/fire3d-store';
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
// The map-free shell and its honest disabled state
// (2026-09-03 launch ruling section 4; DR-065; DDM-P14-T02)
// ---------------------------------------------------------------------------

/**
 * The region observer the orchestrator hands to `buildSidebar`. Held here
 * so the dropdown built at DOM ready can reach it once the map exists.
 */
let onRegionSelectRef: ((key: RegionKey) => void) | null = null;

/** The shell builds once per page; its builders clear and refill their hosts. */
let shellBuilt = false;

/**
 * False until `buildSidebar` has wired the map-dependent half. Every
 * generated control reads it before acting, so a click landing in the
 * window between DOM ready and map ready does nothing rather than half of
 * something.
 */
let mapDependentControlsEnabled = false;

/**
 * What the interface says about a control it cannot honor yet. One reason
 * at a time, in the words a person who is not a specialist reads, and each
 * says only what was observed: none names a cause, promises a fix, or asks
 * the user to do anything.
 *
 * `map-starting` is the ordinary boot window. `map-not-started` is the
 * DR-035a bounded wait expiring (`MAP_LOAD_BOUND_MS`, `src/main.ts`): the
 * map may still arrive, and the copy says so without claiming it will.
 * `no-map` is boot deciding there will be no renderer at all.
 *
 * These are CONTROL affordances. They are not layer states: the six honest
 * layer states (`loading`, `live`, `live (partial)`, `unavailable`,
 * `no data`, `zoom in to load`) neither gain a seventh member here nor lend
 * one of their words to this vocabulary.
 */
export type SidebarControlReason = 'map-starting' | 'map-not-started' | 'no-map';

const CONTROL_REASON_TEXT: Readonly<Record<SidebarControlReason, string>> = {
  'map-starting':
    'The map is still starting. These controls turn on when it is ready.',
  'map-not-started':
    'The map has not started yet. These controls turn on if it does.',
  'no-map':
    'This browser cannot show the map, so these controls have nothing to change.'
};

/**
 * The machine-readable half, on `<html data-ddm-controls>`, beside
 * `data-ddm-boot`. Three words chosen so none of them is a layer state:
 * `waiting` while the map may still arrive, `no-map` once boot has decided
 * it will not, `ready` once the controls answer for what their names say.
 */
const CONTROL_PHASE: Readonly<Record<SidebarControlReason, string>> = {
  'map-starting': 'waiting',
  'map-not-started': 'waiting',
  'no-map': 'no-map'
};

const CONTROL_NOTE_ID = 'sidebar-control-note';

/**
 * Every generated control the map has to be alive for. Read fresh on each
 * call: the chips and the dropdown are rebuilt by the shell builders, and
 * the hazard rail's markup is static in `index.html`.
 *
 * Deliberately NOT included: the share button (it copies a URL, which works
 * without a renderer), the sidebar collapse and expand controls (chrome
 * geometry), and the reset button, which lives in the map overlay rather
 * than the sidebar and would carry a reason the embed cannot show.
 */
function mapDependentControls(): HTMLElement[] {
  const found: HTMLElement[] = [];
  const push = (el: Element | null): void => {
    if (el instanceof HTMLElement) found.push(el);
  };
  push(document.getElementById('region-select'));
  push(document.getElementById('region-briefing-btn'));
  for (const chip of document.querySelectorAll('#preset-chips .preset-chip')) {
    push(chip);
  }
  for (const btn of document.querySelectorAll('#hazard-rail button[data-preset]')) {
    push(btn);
  }
  return found;
}

/**
 * The visible half of the disabled state: one line seated in the region
 * panel, which travels with those controls through every surface that
 * shows them (desktop console, the Brief shell host, the sheet's half and
 * full console detents). A polite live region rather than an alert: the
 * wait is ordinary and must not talk over the boot announcements.
 */
function ensureControlNote(): HTMLElement | null {
  const existing = document.getElementById(CONTROL_NOTE_ID);
  if (existing) return existing;
  const host = document.getElementById('panel-region');
  if (!host) return null;
  const note = document.createElement('p');
  note.id = CONTROL_NOTE_ID;
  note.className = 'sidebar-control-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  host.appendChild(note);
  return note;
}

/**
 * Honest disablement, following the pattern this project already uses for
 * the horizon chips: `aria-disabled` rather than the `disabled` property,
 * so the control keeps its place in the tab order and a keyboard or
 * screen-reader user can still reach it and its reason. Its accessible NAME
 * is untouched, so a disabled control still says what it will do, and the
 * reason arrives as its description.
 *
 * The one exception is the native `<select>`, which ignores `aria-disabled`
 * and would otherwise let a person change a value nothing would honor. It
 * takes the native property as well; its `aria-label` is unchanged.
 */
function applyDisabledAffordance(el: HTMLElement, describe: boolean): void {
  el.setAttribute('aria-disabled', 'true');
  if (describe) el.setAttribute('aria-describedby', CONTROL_NOTE_ID);
  if (el instanceof HTMLSelectElement) el.disabled = true;
}

/**
 * Say why the map-dependent controls cannot act, and keep saying it until
 * they can. Called at DOM ready by the shell, and again by the boot
 * watchdog when the bounded wait expires or boot decides there will be no
 * renderer (DDM-P14-T02). A no-op once the controls are live: nothing may
 * re-disable a working interface.
 */
export function setSidebarControlReason(reason: SidebarControlReason): void {
  if (typeof document === 'undefined') return;
  if (mapDependentControlsEnabled) return;
  document.documentElement.dataset['ddmControls'] = CONTROL_PHASE[reason];
  const note = ensureControlNote();
  if (note) note.textContent = CONTROL_REASON_TEXT[reason];
  for (const el of mapDependentControls()) {
    applyDisabledAffordance(el, note !== null);
  }
}

/**
 * The map is wired: the controls now do what their names say. Removes the
 * note rather than rewriting it, so nothing on screen keeps saying
 * something that has stopped being true.
 */
function enableMapDependentControls(): void {
  mapDependentControlsEnabled = true;
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['ddmControls'] = 'ready';
  for (const el of mapDependentControls()) {
    el.removeAttribute('aria-disabled');
    if (el.getAttribute('aria-describedby') === CONTROL_NOTE_ID) {
      el.removeAttribute('aria-describedby');
    }
    if (el instanceof HTMLSelectElement) el.disabled = false;
  }
  document.getElementById(CONTROL_NOTE_ID)?.remove();
}

/**
 * Build the sidebar's generated controls WITHOUT a map (the 2026-09-03
 * launch ruling, section 4; the shared root of DR-065 modes 1 and 2, the
 * no-WebGL-2 shell gap, and the DDM-P14 boot watchdog).
 *
 * Called from the first lines of `boot()`, before the WebGL 2 probe, so the
 * dropdown and the chips exist on EVERY boot path, including the two that
 * never get a map. Until the map is ready they are visibly and audibly
 * disabled with a reason a non-specialist reads; `buildSidebar` enables
 * them when the map-dependent wiring is live.
 *
 * State discipline: this function writes no application state. `STATE`, the
 * timeline, the region and framing stores, and the checkbox bridge are all
 * still seeded by `applyUrlStateSync` when the map arrives, and it applies
 * every one of them again. What the shell reads from the URL it uses for
 * presentation only, so a control a person can see never shows a region the
 * link did not ask for and an iframe does not flash a populated sidebar it
 * is about to hide.
 *
 * The embed class is the one piece of chrome the shell does apply early, and
 * it comes with an obligation. `#app.embed` collapses the sidebar and REVEALS
 * `#sidebar-expand`, whose handler resizes the map, mounts the catalog island
 * and rebuilds the Brief head, so it cannot act until `wireTopLevelEvents`
 * has run with a live map. Applying the class early therefore used to put a
 * control on screen that existed and did nothing, which is the exact defect
 * this shell exists to remove. The stylesheet closes it: the expand control
 * is withheld until `<html data-ddm-controls="ready">`, which is where it
 * became reachable before this change too, because the embed class itself
 * did not exist until then.
 */
export function buildSidebarShell(): void {
  if (shellBuilt) return;
  shellBuilt = true;
  if (typeof document === 'undefined') return;
  ensureLiveRegion();

  let boot: ParsedUrlParams | null = null;
  try {
    boot = parseUrlParams();
  } catch (err) {
    console.error('[sidebar] the shell could not read the URL:', err);
  }

  const app = document.getElementById('app');
  if (app && boot) app.classList.toggle('embed', boot.embed);

  buildRegionSelect();
  buildPresetChips();
  wireHazardRail();

  if (boot) {
    const select = document.getElementById('region-select');
    if (select instanceof HTMLSelectElement) {
      select.value =
        boot.framing !== null
          ? `framing:${boot.framing}`
          : `region:${boot.region}`;
    }
  }

  setSidebarControlReason('map-starting');
}

/**
 * A region choice from the dropdown. Inert until the map is wired: the
 * control is disabled in that window, and this guard is the second lock so
 * a programmatic or assistive dispatch cannot slip through it either.
 */
function handleRegionChoice(key: RegionKey): void {
  const map = mapRef;
  if (!map || !mapDependentControlsEnabled) return;
  selectRegion(map, key);
  onRegionSelectRef?.(key);
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
 * established detailed `region=` camera as a second option group.
 *
 * Map-free (2026-09-03 launch ruling section 4): the options come from the
 * static `REGIONS`, `FRAMINGS` and `FRAMING_KEYS` tables, and the handlers
 * read the module-level `mapRef` when they fire rather than closing over a
 * map that does not exist yet. */
function buildRegionSelect(): void {
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
    const map = mapRef;
    if (!map || !mapDependentControlsEnabled) return;
    const [kind, rawKey] = select.value.split(':', 2);
    if (kind === 'region' && rawKey && rawKey in REGIONS) {
      handleRegionChoice(rawKey as RegionKey);
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

  // The keyboard-reachable impact briefing trigger (critical-review
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
    const map = mapRef;
    if (!map || !mapDependentControlsEnabled) return;
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
  btn.textContent = `Impact briefing: ${anchor.label}`;
  btn.setAttribute('aria-label', `Open the impact briefing for ${anchor.label}`);
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
function applyViewPreset(preset: ViewPreset): void {
  const map = mapRef;
  if (!map || !controllerRef) return;
  controllerRef.applyPreset(preset);
  if (preset.preferredBasemap) {
    requestBasemapMode(map, preset.preferredBasemap);
  }
}

/**
 * Map-free (2026-09-03 launch ruling section 4): the chips are generated
 * from the static `VIEW_PRESETS` table at DOM ready and stay disabled with
 * a stated reason until the map is wired.
 */
function buildPresetChips(): void {
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
      if (!mapDependentControlsEnabled) return;
      applyViewPreset(preset);
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
function wireHazardRail(): void {
  const rail = document.getElementById('hazard-rail');
  if (!rail) return;
  const buttons: Array<{ btn: HTMLButtonElement; surface: string }> = [];
  for (const btn of rail.querySelectorAll<HTMLButtonElement>('button[data-preset]')) {
    const preset = MOBILE_HAZARD_PRESETS.find((p) => p.key === btn.dataset.preset);
    if (!preset) continue;
    // Accessible name only (W2-D7): a title that duplicates the accessible
    // name verbatim adds a redundant tooltip and double speech, not information.
    btn.setAttribute('aria-label', preset.description);
    // The preset's first layer is its condition surface (the table is
    // ordered surface-first); the pressed state mirrors that layer.
    const surface = preset.layers[0] ?? '';
    buttons.push({ btn, surface });
    btn.addEventListener('click', () => {
      if (!mapDependentControlsEnabled) return;
      applyViewPreset(preset);
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
 * The featured-station table and the list built from it, resolved once per
 * page on first need (DR-008a). Two doors open it: the Water & Snow reveal
 * (a person asked to see the list) and the first telemetry activation (the
 * value hydration needs the slots the list carries). Whichever comes first
 * pays the chunk; the other joins the same promise. A failed load clears
 * the memo so the next door retries instead of remembering the failure.
 */
let telemetryListReady: Promise<readonly TelemetryStation[]> | null = null;
function ensureTelemetryList(
  map: maplibregl.Map
): Promise<readonly TelemetryStation[]> {
  telemetryListReady ??= import('../config/telemetry')
    .then(({ TELEMETRY_STATIONS }) => {
      buildTelemetryList(map, TELEMETRY_STATIONS);
      return TELEMETRY_STATIONS;
    })
    .catch((err: unknown) => {
      console.error('[sidebar] the featured-station table failed to load:', err);
      telemetryListReady = null;
      return [] as readonly TelemetryStation[];
    });
  return telemetryListReady;
}

/**
 * Build the telemetry list. Each entry is a `<button>` (per the
 * [next-polish] accessibility quick win) carrying a colored dot and
 * the station name + agency / type. Click handler ensures the
 * telemetry layer is on, then calls `flyToStation`.
 */
function buildTelemetryList(
  map: maplibregl.Map,
  stations: readonly TelemetryStation[]
): void {
  const container = document.getElementById('telemetry-list');
  if (!container) return;
  container.innerHTML = '';

  for (const station of stations) {
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
function wireTelemetryReveal(map: maplibregl.Map): void {
  const btn = document.getElementById('telemetry-reveal');
  const body = document.getElementById('telemetry-body');
  if (!(btn instanceof HTMLButtonElement) || !body) return;
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    body.hidden = expanded;
    // Opening the panel is the first of the two doors that build the list
    // (DR-008a); the memo makes a second open free.
    if (!expanded) void ensureTelemetryList(map);
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
  // Each branch loads only the adapter it uses (DR-008a). The import sits
  // inside a function that already awaits a network round trip, so the
  // chunk fetch overlaps work the caller was going to wait for anyway, and
  // the eager import graph the activation gate walks is unchanged.
  if (station.awdbStation) {
    const { elementsForAwdbStationTriplet, fetchAwdbDailySeries, toStationValue } =
      await import('../util/awdb');
    const elements = elementsForAwdbStationTriplet(station.awdbStation);
    const series = await fetchAwdbDailySeries(station.awdbStation, elements, 7, signal);
    const primary = series.find((s) => s.element === elements[0]);
    return primary ? toStationValue(station.id, primary) : null;
  }
  if (station.hydrometParams && station.hydrometParams.length > 0) {
    const { fetchHydrometDaily, hydrometStationValue } = await import(
      '../util/hydromet'
    );
    const series = await fetchHydrometDaily(station.hydrometParams, 7, signal);
    const primary = series[0];
    return primary ? hydrometStationValue(station.id, primary) : null;
  }
  if (station.cwms) {
    const { cwmsStationValue, fetchCwmsLatest } = await import('../util/cwms');
    const latest = await fetchCwmsLatest(station.cwms, signal);
    return cwmsStationValue(station.id, station.cwms.label, latest);
  }
  if (station.usgsSite) {
    const { fetchUsgsIV, usgsLatestStationValue } = await import('../util/usgs');
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
function hydrateStationValues(map: maplibregl.Map): void {
  const controller = new AbortController();
  stationValuesController = controller;
  const signal = controller.signal;

  // The slots live in the list, and the list arrives with the station table
  // (DR-008a): the second of the two doors. An abort while the table is
  // still loading (telemetry toggled off again) hydrates nothing.
  void ensureTelemetryList(map).then((stations) => {
    if (signal.aborted) return;
    for (const station of stations) {
      if (!station.awdbStation && !station.hydrometParams && !station.cwms && !station.usgsSite)
        continue;
      const slot = document.querySelector<HTMLElement>(
        `[data-station-values="${cssAttrEscape(station.id)}"]`
      );
      if (!slot) continue;

      slot.textContent = 'loading...';
      // The skeleton-shimmer marks the network wait; each terminal branch
      // below reassigns className without it, so the shimmer clears on its
      // own.
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
  });
}

/**
 * Registry hook for the value lifecycle: first telemetry activation
 * hydrates once per session; a telemetry layer-off aborts anything still
 * in flight (the cancellation invariant). Values already rendered
 * stay rendered; the list is catalog metadata plus last-known readings,
 * not something to blank on toggle.
 */
function onActiveChangeForStationValues(
  map: maplibregl.Map,
  active: ReadonlySet<string>
): void {
  if (active.has('telemetry') && !stationValuesHydrated) {
    stationValuesHydrated = true;
    hydrateStationValues(map);
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

  // Seed the 3D Fire mode preference beside the basemap seed and for the
  // same reason: a `fire3d=true` deep link must survive the first canonical
  // write (syncUrl re-reads the parameter fresh). The seed never writes the
  // URL; the orchestrator (src/map/fire3d.ts, a desktop-only lazy chunk
  // loaded from main.ts) observes the store and applies the map side.
  seedFire3DPreference(params.fire3d);

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
  onRegionSelectRef = onRegionSelect;
  // The shell (the dropdown, the chips, the hazard rail, the live region)
  // normally built at DOM ready from `boot()`. Idempotent, and called here
  // too so a host that reaches `buildSidebar` by another route still gets
  // one complete sidebar rather than half of one.
  buildSidebarShell();

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
  // door for the time bar's instrument switches, the telemetry list, and
  // the conditions tiles. Bound before any DOM builder or boot path can
  // invoke it.
  bindLayerToggleController(controllerRef);

  // The dropdown, the chips and the hazard rail are already built (the
  // shell above); what follows is the half that needs a live map.
  // The Water & Snow list is not built here (DR-008a): the reveal and the
  // first telemetry activation each build it on demand.
  wireTelemetryReveal(map);
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
    onActiveChangeForStationValues(map, active);
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

  // The map-dependent half is wired and the URL state is applied, so the
  // controls now do what their names say (2026-09-03 launch ruling section
  // 4). Last, and synchronous: `<html data-ddm-controls="ready">` is the
  // signal a verification suite waits on in place of the preset chips,
  // which no longer prove a finished boot because they exist before one.
  enableMapDependentControls();
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
