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

import type * as maplibregl from 'maplibre-gl';

import {
  getPlaceSelection,
  onPlaceSelectionChange
} from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { getViewMode, onViewModeChange, setViewMode } from '../state/view-mode';
import type { ViewMode } from '../state/view-mode';
import { closeImpactPanel, openImpactPanel } from './impact-panel';
import { loadSearchController } from './search-chunk';
import { createChunkLoader } from '../util/chunk-retry';
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
import { bindStudioEscape, trapStudioTabFocus } from './island/studio-inert';

const LAYERS_STUDIO_ENTRY_ID = 'layers-studio-entry';
const PLACE_STUDIO_ENTRY_ID = 'place-studio-entry';
const STUDIO_ENTRY_PAIR_ID = 'studio-entry-pair';
const STUDIO_LINKOUT_PAIR_ID = 'studio-linkout-pair';
/** The seat of the two studio buttons, slots 2 and 3 of the map column (index.html). */
const MAP_STUDIO_SEAT_ID = 'map-studio-seat';
const PLACE_STUDIO_ENTRY_STATUS_ID = 'place-studio-entry-status';
const PLACE_STUDIO_OPENER_EVENT = 'ddm:place-studio-opener';
const LAYERS_STUDIO_ENTRY_TITLE =
  'Open the LAYERS studio: layer search, toggles, and sources';
const PLACE_STUDIO_ENTRY_TITLE =
  'Open the PLACE studio: choose a place for the briefing';
/**
 * The two map buttons' glyphs, drawn as the four top-right cells draw theirs:
 * inline SVG in a 24 box at 20 px with a 2 px round stroke. Place is a folded
 * map; Layer is a stack of three sheets.
 */
const MAP_CELL_SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const PLACE_STUDIO_ICON = `${MAP_CELL_SVG_OPEN}<path d="M2 6l7-3 6 3 7-3v15l-7 3-6-3-7 3z"/><path d="M9 3v15M15 6v15"/></svg>`;
const LAYERS_STUDIO_ICON = `${MAP_CELL_SVG_OPEN}<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></svg>`;

let placeStudioRoot: HTMLElement | null = null;
let placeStudioModule: typeof import('./island/place-studio') | null = null;
let placeStudioPromise: Promise<typeof import('./island/place-studio')> | null = null;
let placeStudioOpener: HTMLElement | null = null;
let releasePlaceStudioTabTrap: (() => void) | null = null;
let releasePlaceStudioEscape: (() => void) | null = null;

/**
 * Mark the PLACE entry button pending (found-012): an `aria-busy` state
 * plus a reused `.impact-spinner` glyph, set the SAME task as the press
 * (called synchronously from `syncPlaceStudioRoute`, itself called
 * synchronously from `enterStudio`'s `notify('push')`), so a held chunk
 * shows within one frame instead of the 2.4 to 3.6 s of silence the
 * register recorded. The one-time status paragraph is the "announced
 * once" half: its text is set once per press, not on every render.
 */
function markPlaceStudioEntryPending(el: HTMLElement | null): void {
  if (!el) return;
  el.setAttribute('aria-busy', 'true');
  el.classList.add('studio-entry-pending');
  if (!el.querySelector('.studio-entry-pending-spinner')) {
    const spinner = document.createElement('span');
    spinner.className = 'impact-spinner studio-entry-pending-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    el.appendChild(spinner);
  }
  let status = document.getElementById(PLACE_STUDIO_ENTRY_STATUS_ID);
  if (!status) {
    status = document.createElement('p');
    status.id = PLACE_STUDIO_ENTRY_STATUS_ID;
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    document.body.appendChild(status);
  }
  status.textContent = 'Opening the PLACE studio.';
}

function clearPlaceStudioEntryPending(el: HTMLElement | null): void {
  if (!el) return;
  el.removeAttribute('aria-busy');
  el.classList.remove('studio-entry-pending');
  el.querySelector('.studio-entry-pending-spinner')?.remove();
}

// DDM-P1-T10: a second `import()` of the SAME failed chunk URL replays the
// SAME rejection (Chromium's module map, no new request), so a retry after
// a failure only works under a NEW url. `createChunkLoader`
// (src/util/chunk-retry.ts) keeps that URL memory across every call the
// same way sidebar.ts's `loadIsland` does for the core island.
const loadPlaceStudioChunk = createChunkLoader(
  () => import('./island/place-studio'),
  import.meta.url
);

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
 * "Try again" reloads the page: Chromium caches a FAILED dynamic import in
 * the document's module map, so a fresh `import()` of the SAME url within
 * the SAME page would replay the SAME rejection. The studio route is URL
 * state, so the reload restores the studio honestly and starts every
 * import fresh.
 *
 * The studio chunk itself also self-heals without a reload: `loadPlaceStudio`
 * below and `loadStudio` (src/ui/sidebar.ts) route their import through
 * `createChunkLoader` (src/util/chunk-retry.ts), which remembers the
 * chunk's URL once a call rejects and retries a LATER call under a
 * `retry=<n>` query, a cache key the module map has never marked failed.
 * Leaving the studio (Back to map) and reopening it is such a later call,
 * so a studio that failed once can recover on its own re-entry, with no
 * reload at all.
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

  // Back to map is the same cell as in the studios (an arrow glyph, then the
  // word), seated at the area's top right by the studios' rule for a
  // `.layers-studio-back` that is a direct child of a `.layers-studio-header`
  // (src/styles/studios.css). The header carries only that button here.
  const header = document.createElement('div');
  header.className = 'layers-studio-header studio-load-failure-header';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'layers-studio-back';
  const svgNs = 'http://www.w3.org/2000/svg';
  const glyph = document.createElementNS(svgNs, 'svg');
  glyph.setAttribute('viewBox', '0 0 24 24');
  glyph.setAttribute('width', '20');
  glyph.setAttribute('height', '20');
  glyph.setAttribute('fill', 'none');
  glyph.setAttribute('stroke', 'currentColor');
  glyph.setAttribute('stroke-width', '2');
  glyph.setAttribute('stroke-linecap', 'round');
  glyph.setAttribute('stroke-linejoin', 'round');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.setAttribute('focusable', 'false');
  const arrow = document.createElementNS(svgNs, 'path');
  arrow.setAttribute('d', 'M19 12H5M12 19l-7-7 7-7');
  glyph.appendChild(arrow);
  const word = document.createElement('span');
  word.className = 'layers-studio-back-word';
  word.textContent = 'Back to map';
  back.append(glyph, word);
  back.addEventListener('click', backToMap);
  header.appendChild(back);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'layers-studio-back';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => {
    retry.disabled = true;
    window.location.reload();
  });

  actions.append(retry);
  panel.append(heading, body, actions);
  surface.append(header, panel);
  root.replaceChildren(surface);
  back.focus();
}

function loadPlaceStudio(root: HTMLElement): void {
  const promise = placeStudioPromise ?? loadPlaceStudioChunk();
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
      clearPlaceStudioEntryPending(placeStudioOpener);
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
        clearPlaceStudioEntryPending(placeStudioOpener);
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
    // Keep the click-set opener when the click left focus elsewhere (Safari does not focus buttons).
    if (
      active instanceof HTMLElement &&
      (active.id === PLACE_STUDIO_ENTRY_ID || active.id === 'sheet-place-studio-entry')
    ) {
      placeStudioOpener = active;
    }
  }

  const isEmbed = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (route !== 'place' || isEmbed || isPhysicallyFramed()) {
    if (placeStudioRoot) {
      const opener = placeStudioOpener;
      placeStudioOpener = null;
      clearPlaceStudioEntryPending(opener);
      if (releasePlaceStudioTabTrap) {
        releasePlaceStudioTabTrap();
        releasePlaceStudioTabTrap = null;
      }
      if (releasePlaceStudioEscape) {
        releasePlaceStudioEscape();
        releasePlaceStudioEscape = null;
      }
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
    releasePlaceStudioTabTrap = trapStudioTabFocus(placeStudioRoot);
    releasePlaceStudioEscape = bindStudioEscape(
      placeStudioRoot,
      '#place-studio-back',
      backToMap
    );
    markPlaceStudioEntryPending(placeStudioOpener);
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
 * The stable #time-bar sibling follows in index.html; the selection response
 * lives in #brief-display after that anchor, and the studio buttons on the map.
 *
 * E1 deliverable 1 (D-0.7.0-041 part 2, review E1.2): the lede is worded
 * around selecting a place on the map, not around an already-open report,
 * and the interim console door is retired by D-0.7.0-055. The Brief-mode
 * section hiding itself is CSS-first (src/styles/app.css, the view-brief rules).
 */
function buildBriefHead(map: maplibregl.Map): void {
  const head = document.getElementById('brief-head');
  if (!head) return;

  head.innerHTML = '<div id="brief-search"></div>';
  syncBriefingTitle();
  refreshLayersStudioEntry();

  mountBriefSearch(map);
}

/**
 * The selected hazard cluster's user-facing title ("Drought", "Wildfire",
 * "Extreme Heat", "ENSO"). One accessor so every briefing surface names the
 * same screen (UI-14f).
 */
function selectedHazardTitle(): string {
  return HAZARD_CLUSTERS[getCommittedSnapshot().selectedHazard].title;
}

/**
 * Keep every hazard-named briefing surface in step with the selected cluster
 * (UI-14f): the Brief head's accessible name and the mobile at-hand
 * landmark, which once stayed hardcoded to drought on every screen.
 *
 * The wording deliberately names the BRIEFING, not its contents: the panel
 * synthesizes several hazards behind one door, and the per-hazard depth
 * differs, so "read local conditions" stays neutral rather than promising a
 * hazard-specific read the sources may not support.
 */
function syncBriefingTitle(): void {
  const head = document.getElementById('brief-head');
  if (!head) return;
  const title = selectedHazardTitle();
  const label = `${title} briefing`;
  head.setAttribute('aria-label', label);

  document
    .getElementById('sheet-at-hand')
    ?.setAttribute('aria-label', `At-hand ${title} answer`);
}

/**
 * Reflect the existing place-selection store into the Brief display: the
 * chosen place's name, announced through a visually hidden live region and
 * nothing more. The name is drawn on its one briefing door, the region row's
 * (#region-briefing-btn, src/ui/sidebar.ts), in Brief and Console alike; the
 * card and the sentence that repeated it left the display (visual uniformity
 * wave 1, D6 and repair R2). Presentation only: the store, report opener, and URL behavior
 * remain the single authorities, and nothing shows before an explicit
 * selection exists.
 */
function syncBriefSelection(selection: PlaceSelection | null): void {
  const app = document.getElementById('app');
  app?.toggleAttribute('data-place-selected', selection !== null);

  const context = document.getElementById('brief-place-context');
  const name = document.getElementById('brief-place-name');
  const selectionSummary = document.getElementById('brief-selection-summary');

  if (name) name.textContent = selection?.label ?? '';
  if (context) context.hidden = selection === null;
  if (selectionSummary) selectionSummary.hidden = selection === null;
}

/** One studio button in the map cell family: the glyph, then the word. */
function mapStudioButton(id: string, kind: string, icon: string, word: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.className = `overlay-btn map-cell ${kind}`;
  button.innerHTML = `${icon}<span class="map-control-label">${word}</span>`;
  return button;
}

/**
 * Render the ruled studio entry in the correct host. A full app gets the Layer
 * and Place map buttons, slots 2 and 3 of the map's top-right column under
 * Reset, in its cells and on its x (owner, 2026-11-21 and 22); the stylesheet
 * shows the seat on the desktop shell only (721 px and wider, outside an
 * embed), and the phone keeps its sheet's Place door and footer Layers tab. An embed or
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
    // A framed full app draws the pair in the studio rows, under Reset, so it
    // sits where the studio seat is in the DOM and Tab reaches it second, as
    // it reads. The embed's stack keeps it last.
    const seat = document.getElementById(MAP_STUDIO_SEAT_ID);
    host.insertBefore(pair, !isEmbed && seat?.parentElement === host ? seat : null);
    syncPlaceStudioRoute(getStudioRoute());
    return;
  }

  const host = document.getElementById(MAP_STUDIO_SEAT_ID);
  if (!host) return;
  const pair = document.createElement('div');
  pair.id = STUDIO_ENTRY_PAIR_ID;
  pair.className = 'studio-entry-pair';

  // Mixed case, as the phone rail writes it (visual uniformity wave 1, D1).
  const placeButton = mapStudioButton(PLACE_STUDIO_ENTRY_ID, 'place-studio-entry', PLACE_STUDIO_ICON, 'Place');
  // Accessible name only (W2-D7): no title that duplicates it verbatim.
  placeButton.setAttribute('aria-label', PLACE_STUDIO_ENTRY_TITLE);
  placeButton.addEventListener('click', () => {
    placeStudioOpener = placeButton;
    enterPlaceStudio();
  });

  // "Layer", singular, on the face (owner, 2026-11-21); the name keeps the studio's.
  const layersButton = mapStudioButton(LAYERS_STUDIO_ENTRY_ID, 'layers-studio-entry', LAYERS_STUDIO_ICON, 'Layer');
  layersButton.setAttribute('aria-label', LAYERS_STUDIO_ENTRY_TITLE);
  layersButton.addEventListener('click', enterLayersStudio);

  // Layer above Place (owner, 2026-11-22: "reset, layer, place, sat, help,
  // share"): slots 2 and 3 of the column, in Tab order as they read.
  pair.append(layersButton, placeButton);
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
 * renders into a dedicated container and a re-render replaces it, so there
 * is no mounted flag to reset on failure. The chunk is imported through the
 * shared `loadSearchController` (src/ui/search-chunk.ts, DDM-P1-T04) rather
 * than a bare `import('./search-controller')`, so a failed attempt is
 * recorded there too: a later `ensureBriefHeadSearch` call (the same
 * embed-exit path) retries through that shared loader under a new URL
 * instead of replaying the same cached module-map failure.
 */
function mountBriefSearch(map: maplibregl.Map): void {
  const isEmbed = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (isEmbed && getViewMode() === 'brief') return;
  const container = document.getElementById('brief-search');
  if (!container) return;
  void loadSearchController()
    .then(({ mountSearchInto }) => {
      mountSearchInto(map, container);
    })
    .catch((err: unknown) => {
      console.error('[view-shell] Brief-head search mount failed:', err);
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
