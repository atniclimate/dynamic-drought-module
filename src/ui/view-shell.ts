/**
 * The view shell (U1, D-ARCH-002: "two doors"; amended by S2,
 * D-0.7.0-041: no unsolicited briefing).
 *
 * Owns the mode chrome around the Brief/console split: the header mode
 * switch, the Brief head (the lede, the place picker, and the console
 * door), and the `#app` mode classes the stylesheet keys off. The U1
 * answer-first boot (a Brief boot auto-opened the active region's
 * briefing) is DELIBERATELY RETIRED (D-0.7.0-041 part 1): the boot
 * never opens the impact briefing without an explicit selection; a
 * briefing opens ONLY from an explicit place selection or a `select=`
 * deep link. What survives of D-0.7.0-006 is the never-fake half: this
 * module still never fabricates a briefing for an empty state.
 *
 * The mode itself lives in `src/state/view-mode.ts` (URL-derived at
 * boot, `view=` round-tripped by the sidebar's URL sync). BRIEF leads
 * with the briefing search and keeps the catalog beneath the Brief head
 * as the drill-down (layers-SECOND, not layers-never); CONSOLE is the
 * full instrument. Deeper console reshaping (the region grid demoting
 * to a jump-to list, the searchable catalog) is U3 (D-0.7.0-009), not
 * here.
 *
 * The mode swap crossfades via the View Transitions API where present,
 * guarded by prefers-reduced-motion (headroom B5); without support it
 * is an instant swap, which is also the reduced-motion behavior.
 *
 * Stewardship: the place picker routes through `openStateBriefing`,
 * which builds the same boundary context a map click would; no Tribal,
 * Treaty, or sovereign-jurisdiction data is surfaced by this module.
 */

import type maplibregl from 'maplibre-gl';

import {
  getPlaceSelection,
  onPlaceSelectionChange
} from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { getViewMode, onViewModeChange, setViewMode } from '../state/view-mode';
import type { ViewMode } from '../state/view-mode';
import { closeImpactPanel, openImpactPanel } from './impact-panel';
import { buildTribalNationsBriefAction } from './tribal-nations-action';
import { prefersReducedMotion } from '../util/motion';
import {
  backToMap,
  enterLayersStudio,
  enterPlaceStudio,
  fullSiteLayersStudioUrl,
  fullSitePlaceStudioUrl,
  getStudioRoute,
  isPhysicallyFramed,
  onStudioRouteChange
} from '../state/studio-route';
import type {
  StudioRoute,
  StudioRouteChangeSource
} from '../state/studio-route';
import { HAZARD_CLUSTERS } from '../config/clusters';
import {
  getCommittedSnapshot,
  onCommittedSnapshotChange
} from '../state/cluster-service';

const LAYERS_STUDIO_ENTRY_ID = 'layers-studio-entry';
const PLACE_STUDIO_ENTRY_ID = 'place-studio-entry';
const STUDIO_ENTRY_PAIR_ID = 'studio-entry-pair';
const STUDIO_LINKOUT_PAIR_ID = 'studio-linkout-pair';
const PLACE_STUDIO_OPENER_EVENT = 'ddm:place-studio-opener';
const LAYERS_STUDIO_ENTRY_TITLE =
  'Open the LAYERS studio: layer search, toggles, and sources';
const PLACE_STUDIO_ENTRY_TITLE =
  'Open the PLACE studio: choose a place for the briefing';

let placeStudioRoot: HTMLElement | null = null;
let placeStudioModule: typeof import('./island/place-studio') | null = null;
let placeStudioPromise: Promise<typeof import('./island/place-studio')> | null = null;
let placeStudioOpener: HTMLElement | null = null;

function restorePlaceStudioFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected) {
    opener.focus({ preventScroll: true });
    return;
  }
  const mapContainer = document.getElementById('map-container');
  if (!mapContainer) return;
  mapContainer.tabIndex = -1;
  mapContainer.focus({ preventScroll: true });
}

function capturePlaceStudioOpener(event: Event): void {
  const opener = (event as CustomEvent<unknown>).detail;
  if (opener instanceof HTMLElement) placeStudioOpener = opener;
}

/**
 * Render the shared accessible failure surface inside a studio route root.
 *
 * The retry is a full page reload rather than a re-import: Chromium caches
 * a FAILED dynamic-import in the document's module map, so re-running
 * import() with the same static specifier returns the same rejection for
 * the life of the page (observed at this fix's integration gate; the
 * lane's promise-reset alone could not recover). The studio route is URL
 * state, so the reload restores the studio honestly and refetches the
 * chunk.
 */
export function renderStudioLoadFailure(
  root: HTMLElement,
  headingId: string
): void {
  const surface = document.createElement('section');
  surface.className = 'studio-load-failure';
  surface.setAttribute('role', 'alert');
  surface.setAttribute('aria-labelledby', headingId);

  const panel = document.createElement('div');
  panel.className = 'studio-load-failure-panel';

  const heading = document.createElement('h2');
  heading.id = headingId;
  heading.textContent = 'Studio unavailable';

  const body = document.createElement('p');
  body.textContent = 'This screen failed to load. Check your connection and try again.';

  const actions = document.createElement('div');
  actions.className = 'studio-load-failure-actions';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'layers-studio-back';
  back.textContent = 'Back to map';
  back.addEventListener('click', backToMap);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'layers-studio-back';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => {
    retry.disabled = true;
    window.location.reload();
  });

  actions.append(back, retry);
  panel.append(heading, body, actions);
  surface.appendChild(panel);
  root.replaceChildren(surface);
  back.focus();
}

function loadPlaceStudio(root: HTMLElement): void {
  const promise = placeStudioPromise ?? import('./island/place-studio');
  placeStudioPromise = promise;
  void promise
    .then((module) => {
      placeStudioModule = module;
      const embed = document.getElementById('app')?.classList.contains('embed') ?? false;
      if (
        getStudioRoute() !== 'place' ||
        embed ||
        isPhysicallyFramed() ||
        placeStudioRoot !== root
      ) {
        return;
      }
      module.mountPlaceStudio(root);
    })
    .catch((err: unknown) => {
      if (placeStudioPromise === promise) placeStudioPromise = null;
      console.error('[view-shell] PLACE studio mount failed:', err);
      const embed = document.getElementById('app')?.classList.contains('embed') ?? false;
      if (
        getStudioRoute() === 'place' &&
        !embed &&
        !isPhysicallyFramed() &&
        placeStudioRoot === root
      ) {
        renderStudioLoadFailure(root, 'place-studio-failure-heading');
      }
    });
}

function syncPlaceStudioRoute(
  route: StudioRoute,
  source?: StudioRouteChangeSource
): void {
  if (route === 'place' && source === 'push') {
    const active = document.activeElement;
    placeStudioOpener =
      active instanceof HTMLElement &&
      (active.id === PLACE_STUDIO_ENTRY_ID || active.id === 'sheet-place-studio-entry')
        ? active
        : null;
  }

  const isEmbed = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (route !== 'place' || isEmbed || isPhysicallyFramed()) {
    if (placeStudioRoot) {
      const opener = placeStudioOpener;
      placeStudioOpener = null;
      if (placeStudioModule) placeStudioModule.unmountPlaceStudio(placeStudioRoot);
      placeStudioRoot.remove();
      placeStudioRoot = null;
      restorePlaceStudioFocus(opener);
    }
    return;
  }

  if (!placeStudioRoot) {
    placeStudioRoot = document.createElement('div');
    placeStudioRoot.id = 'place-studio-root';
    document.body.appendChild(placeStudioRoot);
  }
  const root = placeStudioRoot;
  loadPlaceStudio(root);
}

/**
 * Apply the mode to the app shell: the `view-brief`/`view-console`
 * classes (the stylesheet's hook) and both generated Brief regions.
 */
function applyModeClass(mode: ViewMode): void {
  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('view-brief', mode === 'brief');
    app.classList.toggle('view-console', mode === 'console');
  }
  const head = document.getElementById('brief-head');
  if (head) head.hidden = mode !== 'brief';
  const display = document.getElementById('brief-display');
  if (display) display.hidden = mode !== 'brief';
}

/** Reflect the mode into the header switch's pressed states. */
function updateModeSwitch(mode: ViewMode): void {
  document
    .querySelectorAll<HTMLButtonElement>('.view-switch [data-view]')
    .forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset['view'] === mode ? 'true' : 'false');
    });
}

/**
 * Reopen the briefing for the PERSISTING explicit place selection when
 * the Brief door opens, if one is current. This is the D-0.7.0-041
 * replacement for the retired U1 answer-first open: the selection was
 * an explicit user act and persists across the door switch (a selected
 * briefing place is cleared only by its own explicit control), so
 * reopening it is honoring that act, not soliciting a briefing. With no
 * selection, the panel simply stays closed; the region-anchor fallback
 * (the unsolicited half of the old behavior) is retired, and no
 * briefing is fabricated for an empty state (the surviving half of
 * D-0.7.0-006).
 */
function reopenSelectedPlace(): void {
  const place = getPlaceSelection();
  if (place) openImpactPanel(place.context);
}

/**
 * Switch modes with a crossfade. The mutation flips the store (whose
 * subscribers apply the classes, re-sync the URL, and mount the island
 * if needed) and swaps the briefing panel to match the door: console is
 * the map, so the panel closes; Brief reopens the persisting explicit
 * selection if one is current and otherwise stays closed (D-0.7.0-041:
 * never an unsolicited briefing).
 */
function switchMode(mode: ViewMode): void {
  if (mode === getViewMode()) return;
  const mutate = (): void => {
    setViewMode(mode);
    if (mode === 'console') {
      closeImpactPanel();
    } else {
      reopenSelectedPlace();
    }
  };
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    doc.startViewTransition(() => {
      mutate();
    });
  } else {
    mutate();
  }
}

/** Build the two-button mode switch into the sidebar header. */
function buildModeSwitch(): void {
  const header = document.querySelector('.sidebar-header');
  const collapseBtn = document.getElementById('sidebar-collapse');
  if (!header || !collapseBtn) return;

  const group = document.createElement('div');
  group.className = 'view-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'View');
  group.innerHTML = `
    <button type="button" data-view="brief" aria-pressed="false" title="The briefing-led view">Brief</button>
    <button type="button" data-view="console" aria-pressed="false" title="The full map and layers view">Console</button>
  `;
  group.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset['view'];
      if (target === 'brief' || target === 'console') switchMode(target);
    });
  });
  header.insertBefore(group, collapseBtn);
  updateModeSwitch(getViewMode());
}

/**
 * Fill the place-bearing Brief head. It deliberately ends after the concise
 * lede and the ONE search (U3, replacing the U1 stopgap state `<select>`).
 * The stable #time-bar sibling follows in index.html; display prose, studios,
 * and selection response live in #brief-display after that anchor.
 *
 * E1 deliverable 1 (D-0.7.0-041 part 2, review E1.2): the lede is worded
 * around selecting a place on the map, not around an already-open report,
 * and the interim console door is retired by D-0.7.0-055. The Brief-mode
 * section hiding itself is CSS-first (src/styles/app.css, the view-brief rules).
 */
function buildBriefHead(map: maplibregl.Map): void {
  const head = document.getElementById('brief-head');
  if (!head) return;

  head.innerHTML = `
    <p class="brief-head-lede">Select a Tribal land area, reservation, state, or watershed to read local drought conditions.</p>
    <p class="brief-place-context" id="brief-place-context" aria-live="polite" hidden>
      <span>Selected place</span>
      <strong id="brief-place-name"></strong>
      <small>Search below to change.</small>
    </p>
    <div id="brief-search"></div>
  `;
  syncBriefingTitle();
  refreshLayersStudioEntry();

  // The compact Tribal Nations action (umbrella Unit F) moved here from
  // the impact panel's chrome at the S2/E1 integration: D-0.7.0-041
  // retired the unsolicited briefing, so the panel is no longer the
  // default Brief surface, and the ratified visibility guarantee (the
  // group command and its health line visible on the default Brief,
  // Codex final-pass finding 2) now rides the post-time display block. A brief embed
  // keeps the panel-hosted instance instead (the sidebar is collapsed
  // there); one instance ever, the id is unique.
  const isEmbedBoot = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (!isEmbedBoot) {
    document.getElementById('brief-secondary-actions')?.appendChild(buildTribalNationsBriefAction());
  }

  mountBriefSearch(map);
}

function syncBriefingTitle(): void {
  const head = document.getElementById('brief-head');
  if (!head) return;
  const selectedHazard = getCommittedSnapshot().selectedHazard;
  const label = `${HAZARD_CLUSTERS[selectedHazard].title} briefing`;
  head.setAttribute('aria-label', label);
}

/**
 * Fill and wire the generated portion of the post-time display block. Static
 * hosts in index.html preserve the El Nino / Southern Oscillation disclosure
 * across lazy hydration and keep #time-bar outside every regenerated region.
 */
function buildBriefDisplay(): void {
  // The shell island renders the live, status-derived DisplaySummary.
  // Keeping a static sentence here would create a second, stale account
  // of the map state.

  document.getElementById('brief-full-report-link')?.addEventListener('click', () => {
    const place = getPlaceSelection();
    if (place) openImpactPanel(place.context);
  });
}

/**
 * Reflect the existing place-selection store into the two Brief regions. This
 * is presentation only: the store, report opener, and URL behavior remain the
 * single authorities. No selected-place response is exposed before an explicit
 * selection exists.
 */
function syncBriefSelection(selection: PlaceSelection | null): void {
  const app = document.getElementById('app');
  app?.toggleAttribute('data-place-selected', selection !== null);

  const context = document.getElementById('brief-place-context');
  const name = document.getElementById('brief-place-name');
  const selectionSummary = document.getElementById('brief-selection-summary');
  const selectionRead = document.getElementById('brief-selection-read');

  if (!selection) {
    if (context) context.hidden = true;
    if (name) name.textContent = '';
    if (selectionSummary) selectionSummary.hidden = true;
    if (selectionRead) selectionRead.textContent = '';
    return;
  }

  if (name) name.textContent = selection.label;
  if (context) context.hidden = false;
  if (selectionRead) {
    selectionRead.textContent = `The map and drought briefing are focused on ${selection.label}.`;
  }
  if (selectionSummary) selectionSummary.hidden = false;
}

/**
 * Render the ruled studio entry in the correct host. A full app gets the
 * adjacent PLACE and LAYERS doors after the display description. An embed or
 * physical frame gets only full-site link-outs, never an in-frame studio route.
 */
export function refreshLayersStudioEntry(): void {
  document.getElementById(STUDIO_ENTRY_PAIR_ID)?.remove();
  document.getElementById(STUDIO_LINKOUT_PAIR_ID)?.remove();
  document.getElementById(LAYERS_STUDIO_ENTRY_ID)?.remove();
  document.getElementById(PLACE_STUDIO_ENTRY_ID)?.remove();
  const app = document.getElementById('app');
  const isEmbed = app?.classList.contains('embed') ?? false;
  const studioMountProhibited = isEmbed || isPhysicallyFramed();

  if (studioMountProhibited) {
    const host = document.querySelector('.map-overlay-controls');
    if (!host) return;
    const pair = document.createElement('div');
    pair.id = STUDIO_LINKOUT_PAIR_ID;
    pair.className = 'studio-linkout-pair';

    const placeLink = document.createElement('a');
    placeLink.id = PLACE_STUDIO_ENTRY_ID;
    placeLink.className = 'overlay-btn layers-studio-linkout place-studio-linkout';
    placeLink.href = fullSitePlaceStudioUrl();
    placeLink.target = '_blank';
    placeLink.rel = 'noopener';
    placeLink.textContent = 'Open place selection on the full site';
    placeLink.addEventListener('click', () => {
      placeLink.href = fullSitePlaceStudioUrl();
    });

    const layersLink = document.createElement('a');
    layersLink.id = LAYERS_STUDIO_ENTRY_ID;
    layersLink.className = 'overlay-btn layers-studio-linkout';
    layersLink.href = fullSiteLayersStudioUrl();
    layersLink.target = '_blank';
    layersLink.rel = 'noopener';
    layersLink.textContent = 'Open layer controls on the full site';
    layersLink.addEventListener('click', () => {
      layersLink.href = fullSiteLayersStudioUrl();
    });

    pair.append(placeLink, layersLink);
    host.appendChild(pair);
    syncPlaceStudioRoute(getStudioRoute());
    return;
  }

  const host = document.getElementById('layers-studio-entry-host');
  if (!host) return;
  const pair = document.createElement('div');
  pair.id = STUDIO_ENTRY_PAIR_ID;
  pair.className = 'studio-entry-pair';

  const placeButton = document.createElement('button');
  placeButton.type = 'button';
  placeButton.id = PLACE_STUDIO_ENTRY_ID;
  placeButton.className = 'brief-console-door place-studio-entry';
  placeButton.textContent = 'PLACE';
  // Accessible name only (W2-D7): no title that duplicates it verbatim.
  placeButton.setAttribute('aria-label', PLACE_STUDIO_ENTRY_TITLE);
  placeButton.addEventListener('click', () => {
    placeStudioOpener = placeButton;
    enterPlaceStudio();
  });

  const layersButton = document.createElement('button');
  layersButton.type = 'button';
  layersButton.id = LAYERS_STUDIO_ENTRY_ID;
  layersButton.className = 'brief-console-door layers-studio-entry';
  layersButton.textContent = 'LAYERS';
  layersButton.setAttribute('aria-label', LAYERS_STUDIO_ENTRY_TITLE);
  layersButton.addEventListener('click', enterLayersStudio);

  pair.append(placeButton, layersButton);
  host.appendChild(pair);
  syncPlaceStudioRoute(getStudioRoute());
}

/**
 * Mount the shared search into the Brief head. Gated by the C1 rule: a brief
 * embed never downloads the island / search chunk at BOOT (the Brief head
 * chrome is not the embed's surface). The embed-exit path (the sidebar
 * expand control) calls back through `ensureBriefHeadSearch` once the embed
 * class is gone, so an exited embed gets the head search without a reload
 * (the U3 stage-5 minor 7 fix). Every other boot has the island mounted
 * already, so the extra chunk is free. Mounting is idempotent: the search
 * renders into a dedicated container and a re-render replaces it.
 */
function mountBriefSearch(map: maplibregl.Map): void {
  const isEmbed = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (isEmbed && getViewMode() === 'brief') return;
  const container = document.getElementById('brief-search');
  if (!container) return;
  void import('./search-controller').then(({ mountSearchInto }) => {
    mountSearchInto(map, container);
  });
}

/**
 * Public seam for the embed-exit path: mount the Brief-head search if the
 * boot-time C1 gate skipped it (a brief embed) and the app has since left
 * embed mode. Safe to call repeatedly.
 */
export function ensureBriefHeadSearch(map: maplibregl.Map): void {
  mountBriefSearch(map);
}

/**
 * Public seam for the embed-exit path (Codex S2/E1 integration finding
 * 2): an embed boot skips the head-hosted Tribal Nations action, and
 * the panel hosts it only when BUILT under the embed class, so an
 * exited embed could end up with no instance at all. Idempotent: if
 * the unique id already exists anywhere (the panel-hosted instance
 * from an embed-boot panel build), this is a no-op; otherwise the
 * post-time display block gains the action, keeping the umbrella's
 * default-Brief visibility guarantee after the exit.
 */
export function ensureBriefHeadTribalAction(): void {
  if (document.getElementById('tribal-nations-brief-action')) return;
  const host = document.getElementById('brief-secondary-actions');
  if (!host) return;
  host.appendChild(buildTribalNationsBriefAction());
}

/**
 * Initialize the view shell. Called once from boot, after the sidebar
 * (which seeds the mode from the URL). The shell builds chrome only:
 * the U1 answer-first boot open that used to fire here is retired
 * (D-0.7.0-041 part 1; no unsolicited briefing), so a `select=` deep
 * link (applied by the caller afterward) and explicit selections are
 * the only briefing openers.
 */
export function initViewShell(map: maplibregl.Map): void {
  document.addEventListener(PLACE_STUDIO_OPENER_EVENT, capturePlaceStudioOpener);
  onStudioRouteChange(syncPlaceStudioRoute);
  buildModeSwitch();
  buildBriefDisplay();
  buildBriefHead(map);
  onCommittedSnapshotChange(syncBriefingTitle);
  syncBriefSelection(getPlaceSelection());
  applyModeClass(getViewMode());
  syncPlaceStudioRoute(getStudioRoute());

  onPlaceSelectionChange(syncBriefSelection);

  onViewModeChange((mode) => {
    applyModeClass(mode);
    updateModeSwitch(mode);
  });
}
