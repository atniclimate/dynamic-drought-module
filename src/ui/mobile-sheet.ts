/**
 * The phone sheet's controller (the sheet form is owner direction
 * 2026-11-09 (sprint), DR-pending).
 *
 * Below 720 pixels the sidebar element is one glass sheet that rises from
 * the bottom edge beside the right-edge column and rests at a stop: closed,
 * peek (its header and first lines), half, or full. The four doors in the
 * column open it; pressing the open door again, the close control, Escape,
 * or a drag below peek closes it. This module owns the LOGICAL state (which
 * stop, which door), stamps it on #app for the stylesheets, and keeps the
 * contract other modules call. It is eager and small on purpose.
 *
 * Everything that makes the sheet follow the hand (the drag, the spring,
 * the header's title and close control, the grabber's keys) is
 * src/ui/sheet-motion.ts, loaded only when the phone shell activates. Until
 * it arrives, or under reduced motion, a stop change lands at once on the
 * same end state.
 *
 * The panel state is ephemeral and never enters the URL. Embed mode keeps its
 * hidden-chrome behavior. The search chunk still mounts only when the mobile
 * shell activates, and report content remains owned by the impact panel.
 */

import type * as maplibregl from 'maplibre-gl';

import type { ImpactBriefing } from '../impact/types';
import { selectBriefNarrativeLine } from '../impact/brief-narrative-selector';
import { getViewMode, setViewMode } from '../state/view-mode';
import { escapeHtml } from '../util/escape';
import { TRIBAL_NATIONS_GROUP } from '../config/layer-groups';
import { getPlaceSelection, onPlaceSelectionChange } from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { enterPlaceStudio } from '../state/studio-route';
import {
  toggleTribalNationsGroup,
  wireTribalNationsHealth,
  wireTribalNationsToggle
} from './tribal-nations-action';
import { loadSearchController } from './search-chunk';

// ---------------------------------------------------------------------------
// Types and module state
// ---------------------------------------------------------------------------

/**
 * The sheet's stops. `closed` is off screen, `peek` shows the header and the
 * first lines, `half` is an ordinary open door, and `full` reaches the key
 * chip and exposes report or catalog content.
 */
export type SheetDetent = 'closed' | 'peek' | 'half' | 'full';

/** The side rail's four doors. Ephemeral like the detent; never in the URL. */
export type SheetTab = 'brief' | 'place' | 'layers' | 'alerts';

/** How long a stop change waits to settle when no motion module drives it. */
const SETTLE_FALLBACK_MS = 220;
const PLACE_STUDIO_OPENER_EVENT = 'ddm:place-studio-opener';

let mapRef: maplibregl.Map | null = null;

let appEl: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;
/** The dynamic read region rebuilt on every briefing push (the search and
 * the report door are stable siblings, so an innerHTML rebuild never wipes
 * the mounted Preact search). */
let atHandBodyEl: HTMLElement | null = null;
/** Guard so the shared search mounts at most once (idempotent activation). */
let searchMounted = false;
let liveRegionEl: HTMLElement | null = null;

/** The active detent, or null when the sheet is inactive (desktop or embed). */
let detent: SheetDetent | null = null;
/** The pressed door, or null: a closed sheet, or one raised by something else. */
let activeTab: SheetTab | null = null;

/**
 * What the motion module asks of this controller. Handed over as an object,
 * not imported, so the lazy module has no runtime tie to this eager one.
 */
export interface SheetMotionHost {
  /** The logical stop, as `getSheetDetent`. */
  detent(): SheetDetent | null;
  /** Ask for a stop, as `setSheetDetent`. */
  request(next: SheetDetent): void;
  /** Stamp the logical stop and door on #app; the content follows. */
  present(): void;
  /** The sheet came to rest: resize the map and tell the listeners. */
  settle(): void;
}

/** What the motion module does for this controller. */
export interface SheetMotion {
  /** The logical stop changed: present it and bring the sheet to rest there. */
  go(from: SheetDetent, to: SheetDetent): void;
  /** The phone shell went away: drop every inline style and running motion. */
  reset(): void;
}

let motion: SheetMotion | null = null;
let motionAsked = false;

/**
 * A text entry raised the sheet to full (see the focus rule in
 * `initMobileSheet`). Cleared as soon as the sheet leaves full by any road.
 */
let raisedForEntry = false;

/**
 * Whether a briefing open may auto-raise the CLOSED sheet to half. The
 * map-first boot must stay closed, so the raise is earned by either a
 * real user gesture (the first pointer or key event) or a `?select=`
 * deep link (where the shared link itself is the ask; since S2,
 * D-0.7.0-041, that deep link is the only boot-time briefing opener).
 * Read by the impact panel's mobile host through `sheetAllowsAutoRaise`.
 */
let userInteracted = false;
let deepLinkRaise = false;

/** The detent to restore when the report closes (set by the impact-panel host). */
let restoreDetent: SheetDetent | null = null;

// A print paper size is not a reader resize. Keep the current sheet/host while
// the browser temporarily evaluates width media queries against that paper.
let printing = false;
let printReleaseFrame: number | null = null;

/** The briefing the at-hand block renders, pushed by the impact panel. */
let sheetBriefing: ImpactBriefing | null = null;

let settleTimer: number | null = null;
const settleListeners = new Set<(active: SheetDetent | null) => void>();

const mql: MediaQueryList | null =
  typeof window !== 'undefined' ? window.matchMedia('(max-width: 720px)') : null;

// ---------------------------------------------------------------------------
// Public read surface
// ---------------------------------------------------------------------------

/** Whether the mobile panel shell currently exists (mobile viewport, not embed). */
export function isSheetActive(): boolean {
  return detent !== null;
}

/** The current detent, or null when the sheet is inactive. */
export function getSheetDetent(): SheetDetent | null {
  return detent;
}

/** Whether a briefing open may auto-raise the closed sheet (see above). */
export function sheetAllowsAutoRaise(): boolean {
  return userInteracted || deepLinkRaise;
}

/**
 * The bottom band, in px, a camera fit should keep clear so the place it
 * frames is not left under the sheet: the half stop (half the window) while
 * the phone sheet is active in its bottom form, and 0 on desktop, in an
 * embed and for the landscape drawer. A fit made with the sheet closed or at
 * full uses it too: the briefing it frames answers at half, or is one drag
 * from it. Transient fit padding only; the map's own padding stays zero, so
 * Reset and a shared link frame exactly as before.
 */
export function sheetCameraInset(): number {
  if (detent === null || !sidebarEl || isDrawerForm()) return 0;
  return Math.round(window.innerHeight / 2);
}

/**
 * The band, in px from the left edge, a camera fit should keep clear: the
 * landscape drawer's width while the panel is in that form, and 0 otherwise.
 * The drawer covers the left of the map the way the bottom sheet covers its
 * lower half, so a fit that ignored it framed the place under the drawer.
 */
export function sheetCameraSideInset(): number {
  if (detent === null || !sidebarEl || !isDrawerForm()) return 0;
  return Math.round(sidebarEl.getBoundingClientRect().width);
}

/**
 * Whether the panel is the landscape drawer. Read from the element, so this
 * eager module shares no constant with the lazy one: the drawer's box starts
 * at the top edge of the window, and the bottom sheet's box always starts
 * below it, at every stop and while closed. (Its height is not the tell: the
 * drawer stops 2 px short of the bottom edge on purpose.)
 */
function isDrawerForm(): boolean {
  return sidebarEl !== null && sidebarEl.getBoundingClientRect().top <= 0;
}

/** Subscribe to detent settles (after the sheet comes to rest and map.resize). */
export function onSheetDetentSettle(fn: (active: SheetDetent | null) => void): () => void {
  settleListeners.add(fn);
  return () => {
    settleListeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// Detent mechanics
// ---------------------------------------------------------------------------

const DETENT_ANNOUNCE: Record<SheetDetent, string> = {
  closed: 'Panel closed. The map is in view.',
  peek: 'Panel lowered to its first lines.',
  half: 'Panel open.',
  full: 'Full panel open.'
};

function announce(text: string): void {
  if (liveRegionEl) liveRegionEl.textContent = text;
}

/**
 * Stamp the logical stop and door on #app. The stylesheets key the sheet's
 * height and its content off these two attributes, so this is the moment
 * the content changes. The motion module calls it before a rise (the
 * content travels up with the glass) and after a close (the content travels
 * down with it); without that module it runs at once.
 */
function present(): void {
  if (!appEl || detent === null) return;
  const before = appEl.getAttribute('data-sheet-detent');
  appEl.setAttribute('data-sheet-detent', detent);
  if (activeTab) appEl.setAttribute('data-sheet-tab', activeTab);
  else appEl.removeAttribute('data-sheet-tab');
  // Full content always opens at its top.
  if (detent === 'full' && before !== 'full') {
    const scroll = sidebarEl?.querySelector<HTMLElement>('.sidebar-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
}

/**
 * Move the sheet to a stop. The logical state changes at once (every
 * reader of `getSheetDetent` sees it); the glass follows on its spring
 * when the motion module is present.
 */
export function setSheetDetent(next: SheetDetent, opts: { announce?: boolean } = {}): void {
  if (detent === null || !appEl) return;
  if (next === detent) return;
  const from = detent;
  detent = next;
  if (next !== 'full') raisedForEntry = false;
  if (next === 'closed') {
    // Closing by any road clears the open door. Focus that was inside the
    // sheet returns to that door (or to the map when no door claimed it),
    // never to the page body.
    const door = document.querySelector<HTMLElement>(
      '#mobile-footer-nav button.active[data-tab]'
    );
    const held = sidebarEl?.contains(document.activeElement) ?? false;
    syncFooterTab(null);
    if (held) (door ?? document.querySelector<HTMLElement>('.maplibregl-canvas'))?.focus();
  }
  if (opts.announce !== false) announce(DETENT_ANNOUNCE[next]);
  if (motion) {
    motion.go(from, next);
  } else {
    present();
    scheduleSettle();
  }
}

function scheduleSettle(): void {
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    settle();
  }, SETTLE_FALLBACK_MS);
}

/**
 * The sheet came to rest (or the shell changed): resize MapLibre, keep the
 * camera free of any retired padding, and tell the listeners.
 */
function settle(): void {
  if (settleTimer !== null) {
    window.clearTimeout(settleTimer);
    settleTimer = null;
  }
  if (!mapRef) return;
  const map = mapRef;
  map.resize();
  // `jumpTo` stops a running camera move where it stands, and a briefing
  // frames its place while the sheet rises: the reset waits for that fit to
  // land instead of cutting it short (owner direction 2026-11-09 (sprint),
  // DR-pending).
  const clearPadding = (): void => {
    map.jumpTo({ padding: { top: 0, left: 0, right: 0, bottom: 0 } });
  };
  if (map.isMoving()) map.once('moveend', clearPadding);
  else clearPadding();
  for (const fn of [...settleListeners]) {
    try {
      fn(detent);
    } catch (err) {
      console.error('[mobile-sheet] settle listener threw:', err);
    }
  }
}

/**
 * Load the motion module the first time the phone shell activates. A
 * desktop or embed session never downloads it; a failed load leaves the
 * sheet working without motion, and is tried again when the shell next
 * activates or a door is next pressed (`openFooterTab`).
 */
function loadMotion(): void {
  if (motionAsked) return;
  motionAsked = true;
  void import('./sheet-motion')
    .then(({ attachSheetMotion }) => {
      if (!appEl || !sidebarEl) return;
      motion = attachSheetMotion(appEl, sidebarEl, {
        detent: getSheetDetent,
        request: setSheetDetent,
        present,
        settle
      });
    })
    .catch((err: unknown) => {
      motionAsked = false;
      console.error('[mobile-sheet] sheet motion failed to load:', err);
    });
}

// ---------------------------------------------------------------------------
// The at-hand block (the half detent's Brief content)
// ---------------------------------------------------------------------------

/**
 * Push the active briefing into the at-hand block (called by the impact
 * panel's internals on every paint/refresh, and with null on close). The
 * block renders the place title, its kind qualifier, the one-paragraph
 * current-horizon read, the place picker, and the one door to the full
 * report; it never invents a claim (an unhydrated current horizon reads
 * as the honest "open the full report" line).
 */
export function setSheetBriefing(briefing: ImpactBriefing | null): void {
  const chosen = briefing !== null && briefing !== sheetBriefing;
  sheetBriefing = briefing;
  renderAtHand();
  // A place chosen from a text entry that raised the sheet answers at half,
  // where the map shows it above the sheet; the full report stays one press
  // away. The Brief door is the report door, so it keeps full.
  if (chosen && raisedForEntry && detent === 'full' && activeTab !== 'brief') {
    const held = sidebarEl?.contains(document.activeElement) ?? false;
    setSheetDetent('half');
    if (held) document.getElementById('sheet-report-door')?.focus();
  }
}

/** The critical-first point-heat or current-horizon line, when available. */
function currentHeadline(briefing: ImpactBriefing): string | null {
  return selectBriefNarrativeLine(briefing);
}

/**
 * A place that is selected on the map with no briefing read for it yet
 * (shown from the Place studio, or chosen while the console view was up).
 * The at-hand block names it and its one door opens the briefing, so the
 * sheet never says "Pick a place" under a map that marks one (owner
 * direction 2026-11-09 (sprint), DR-pending).
 */
function selectedWithoutBriefing(): PlaceSelection | null {
  return sheetBriefing === null ? getPlaceSelection() : null;
}

/**
 * Opens the briefing of a selected place. Set by the briefing's own module
 * (src/ui/impact-panel.ts), which imports this one; the reverse import
 * would close a cycle.
 */
let openSelectedBriefing: ((selection: PlaceSelection) => void) | null = null;

/** Register the opener the at-hand door uses for a selected place with no briefing yet. */
export function setSheetBriefingOpener(open: (selection: PlaceSelection) => void): void {
  openSelectedBriefing = open;
}

function updateAtHandActions(): void {
  const hasBriefing = sheetBriefing !== null;
  const offersBriefing = hasBriefing || selectedWithoutBriefing() !== null;
  document
    .getElementById('sheet-at-hand-actions')
    ?.classList.toggle('has-briefing', offersBriefing);
  const reportDoor = document.getElementById('sheet-report-door');
  if (!reportDoor) return;
  reportDoor.hidden = !offersBriefing;
  // One door, named for what it does next: the report of a briefing that is
  // read, or the briefing of a place that is only selected.
  const word = hasBriefing || !offersBriefing ? 'Read the full report' : 'Open briefing';
  if (reportDoor.textContent !== word) reportDoor.textContent = word;
}

function renderAtHand(): void {
  updateAtHandActions();
  if (!atHandBodyEl) return;
  const briefing = sheetBriefing;
  const selected = selectedWithoutBriefing();
  const title = briefing ? briefing.landTitle : selected ? selected.label : 'Pick a place';
  const kind = briefing ? briefing.landKind : '';
  const headline = briefing ? currentHeadline(briefing) : null;
  const headlineHtml = headline
    ? `<p class="sheet-at-hand-headline">${escapeHtml(headline)}</p>`
    : selected
      ? `<p class="sheet-at-hand-headline sheet-at-hand-headline-empty">Selected on the map. Open its briefing for sourced conditions, outlooks, and resources.</p>`
      : `<p class="sheet-at-hand-headline sheet-at-hand-headline-empty">Open the full report for sourced conditions, outlooks, and resources.</p>`;

  // Only the dynamic read is rebuilt here; the search and the report door
  // are stable siblings (see initMobileSheet), so a briefing push never
  // wipes the mounted search.
  atHandBodyEl.innerHTML = `
    <p class="sheet-at-hand-kicker">Conditions briefing</p>
    <h2 class="sheet-at-hand-title">${escapeHtml(title)}</h2>
    ${kind ? `<p class="sheet-at-hand-kind">${escapeHtml(kind)}</p>` : ''}
    ${headlineHtml}
  `;
}

/**
 * Mount the ONE shared search into the sheet's at-hand block, replacing the
 * U2 stopgap place `<select>`. Called on first sheet activation (guarded to
 * run once); the sheet activates only on a mobile, non-embed viewport, so the
 * search-controller chunk (and the island it pulls) never loads for an embed
 * (the C1 rule). The container is stable DOM, so the mount survives every
 * `renderAtHand()` rebuild; the component's `useId()` keeps its element ids
 * distinct from the console-catalog and Brief-head mounts.
 */
function mountSheetSearch(): void {
  if (searchMounted || !mapRef) return;
  const container = document.getElementById('sheet-search');
  if (!container) return;
  searchMounted = true;
  const map = mapRef;
  void loadSearchController()
    .then(({ mountSearchInto }) => {
      mountSearchInto(map, container);
    })
    .catch((err: unknown) => {
      searchMounted = false;
      console.error('[mobile-sheet] search mount failed:', err);
    });
}

/** Add the one D-0.7.0-054 entry below the sheet's time control. */
function buildSheetPlaceStudioEntry(): void {
  if (document.getElementById('sheet-place-studio-entry')) return;
  const timeHost = document.getElementById('sheet-time-host');
  const reportDoor = document.getElementById('sheet-report-door');
  if (!timeHost || !reportDoor) return;

  const actions = document.createElement('div');
  actions.id = 'sheet-at-hand-actions';
  actions.className = 'sheet-at-hand-actions';

  const placeButton = document.createElement('button');
  placeButton.type = 'button';
  placeButton.id = 'sheet-place-studio-entry';
  placeButton.className = 'sheet-report-door sheet-place-studio-entry';
  placeButton.textContent = 'PLACE';
  // Accessible name only (W2-D7): no title that duplicates it verbatim.
  placeButton.setAttribute(
    'aria-label',
    'Open the PLACE studio: choose a place for the briefing'
  );
  placeButton.addEventListener('click', () => {
    document.dispatchEvent(
      new CustomEvent(PLACE_STUDIO_OPENER_EVENT, { detail: placeButton })
    );
    enterPlaceStudio();
  });

  timeHost.insertAdjacentElement('afterend', actions);
  actions.append(placeButton, reportDoor);
  updateAtHandActions();
}

// ---------------------------------------------------------------------------
// Report hosting handles (used by the impact panel's mobile host)
// ---------------------------------------------------------------------------

/** The sheet's report region, where the impact panel rehosts below 720px. */
export function sheetReportHost(): HTMLElement | null {
  return detent !== null ? document.getElementById('sheet-report') : null;
}

/**
 * Record the detent to restore when the report closes, then drive the
 * sheet. `closeImpactPanel()`'s mobile host calls `restoreSheetDetent`.
 */
export function driveSheetForReport(target: SheetDetent): void {
  if (detent === null) return;
  if (restoreDetent === null && detent !== 'full') restoreDetent = detent;
  setSheetDetent(target);
}

/** Restore the pre-report detent (the ratified close behavior). */
export function restoreSheetDetent(): void {
  if (detent === null) return;
  const target = restoreDetent ?? 'half';
  restoreDetent = null;
  setSheetDetent(target);
}

// ---------------------------------------------------------------------------
// The mobile side rail
// ---------------------------------------------------------------------------

/**
 * The door a raised sheet shows when none was pressed (a map selection, a
 * shared link, Locate): the one whose word the sheet's title reads. The
 * same three tests in the same order as `describe` in
 * src/ui/sheet-motion.ts, so the title and the lit door cannot disagree:
 * Brief while the report is open at full, Layers in the console view,
 * otherwise Place (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * One sheet is none of these: a surface that fills a sheet no door pressed
 * and says its own name in `data-sheet-name` on #app (the ENSO guide,
 * src/ui/enso-chain.ts). The title reads that name, and the surface lights
 * its own door, so `litTab` lights none of the four for it.
 */
function impliedTab(): SheetTab {
  if (
    appEl?.getAttribute('data-sheet-detent') === 'full' &&
    sidebarEl?.querySelector('#sheet-report .impact-panel.open')
  ) {
    return 'brief';
  }
  return appEl?.classList.contains('view-console') ? 'layers' : 'place';
}

/**
 * The door shown as open: the pressed one, else the implied one. None while
 * closed, and none for a sheet that names itself (its own door is lit).
 */
function litTab(): SheetTab | null {
  if (detent === null || detent === 'closed') return null;
  if (activeTab) return activeTab;
  return appEl?.hasAttribute('data-sheet-name') ? null : impliedTab();
}

/**
 * Show the lit door on the door buttons (the open door inverts through
 * `aria-expanded`). An implied door is lit and nothing more: it is never
 * `activeTab`, so `data-sheet-tab` stays unstamped and a selection keeps its
 * answer-first content order.
 */
function lightDoors(): void {
  const lit = litTab();
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    '#mobile-footer-nav button[data-tab]'
  )) {
    const active = btn.dataset['tab'] === lit;
    btn.classList.toggle('active', active);
    if (btn.getAttribute('aria-expanded') !== String(active)) {
      btn.setAttribute('aria-expanded', String(active));
    }
  }
}

/**
 * Record the pressed door and reflect it on the door buttons at once. Null
 * means no door was pressed: the closed sheet lights none, and a sheet
 * raised by something else lights the door its title names (`impliedTab`).
 * The `data-sheet-tab` attribute the content gates read is stamped with the
 * stop, in `present`, and only for a pressed door.
 */
function syncFooterTab(tab: SheetTab | null): void {
  activeTab = tab;
  const footer = document.getElementById('mobile-footer-nav');
  if (!footer) return;
  footer.setAttribute('aria-label', 'Mobile panels');
  for (const btn of footer.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
    btn.setAttribute('aria-controls', 'sidebar');
  }
  lightDoors();
}

/**
 * Open a door. Place (the at-hand answer with the one search), Layers (the
 * console controls) and Alerts open at half, where the map still leads.
 * Brief is the report door: with a briefing to read it opens at full, and
 * with no place chosen yet it opens at half, because a sheet is only as
 * tall as what it has to say (owner direction 2026-11-09 (sprint),
 * DR-pending; before this Brief always opened at full). Brief and Place
 * ride the Brief view mode, Layers rides console; the mode is real URL
 * state and moves through the existing `setViewMode` machinery. Pressing
 * the lit door closes the sheet.
 */
function openFooterTab(tab: SheetTab): void {
  if (detent === null || !appEl) return;
  // The sheet's title and close control arrive with the motion module. A
  // load that failed is asked for again by the next door press, and not
  // only by the next activation of the shell; once loaded this is a no-op.
  loadMotion();
  // The lit door closes the sheet, whether it was pressed or implied.
  if (litTab() === tab) {
    setSheetDetent('closed');
    return;
  }
  if (tab === 'brief' || tab === 'place') {
    if (getViewMode() !== 'brief') setViewMode('brief');
  } else if (tab === 'layers') {
    if (getViewMode() !== 'console') setViewMode('console');
  }
  syncFooterTab(tab);
  if (tab === 'alerts') {
    // Lazy: the alerts pane module rides the same activation the layer
    // does; an embed or desktop session never downloads it.
    void import('./sheet-alerts')
      .then(({ openSheetAlerts }) => {
        if (mapRef) openSheetAlerts(mapRef);
      })
      .catch((err: unknown) => {
        console.error('[mobile-sheet] alerts pane failed to load:', err);
      });
  }
  const target: SheetDetent = tab === 'brief' && sheetBriefing ? 'full' : 'half';
  if (detent === target) {
    // Same stop, new door (e.g. Layers -> Alerts at half): stamping the
    // door re-gates the content; still settle so the listeners hear it.
    present();
    scheduleSettle();
  } else {
    setSheetDetent(target);
  }
}

function wireFooterNav(): void {
  const footer = document.getElementById('mobile-footer-nav');
  if (!footer) return;
  for (const btn of footer.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
    btn.addEventListener('click', () => {
      const tab = btn.dataset['tab'] as SheetTab | undefined;
      if (tab) openFooterTab(tab);
    });
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(initial?: SheetDetent): void {
  if (!appEl || detent !== null) return;
  // Panel visibility is ephemeral: even an app-stamped view=brief URL
  // reloads with the map clear. Explicit doors and place selections open it.
  detent = initial ?? 'closed';
  // Stamp the static navigation with its panel semantics on the first
  // mobile activation, before any door has been pressed.
  syncFooterTab(null);
  present();
  renderAtHand();
  // Mount the shared search now (never at boot): the sheet is active only on
  // a mobile, non-embed viewport, so the C1 rule holds and the chunk is free.
  mountSheetSearch();
  loadMotion();
  // Activation settles SYNCHRONOUSLY (adversarial-review finding 3):
  // the settle listeners rehost an open briefing panel, and a delayed
  // settle leaves it in the wrong host (invisible) for the delay.
  settle();
}

function deactivate(): void {
  if (!appEl || detent === null) return;
  detent = null;
  restoreDetent = null;
  motion?.reset();
  appEl.removeAttribute('data-sheet-detent');
  appEl.removeAttribute('data-sheet-tab');
  syncFooterTab(null);
  // Synchronous for the same reason as activate(): an open report must
  // return to its document.body host in the same frame the sheet goes
  // away, not after the settle fallback delay.
  settle();
}

/** Whether the sheet should exist right now (mobile viewport, not embed). */
function shouldBeActive(): boolean {
  return Boolean(mql?.matches) && !(appEl?.classList.contains('embed') ?? false);
}

function evaluate(): void {
  if (printing) return;
  if (shouldBeActive()) {
    if (detent === null) activate();
  } else if (detent !== null) {
    deactivate();
  }
}

/**
 * Compatibility entry used by the embed expand control. Exiting embed
 * restores the mobile rail with its panels closed.
 */
export function revealSheetAtPeek(): void {
  if (!shouldBeActive()) return;
  if (detent === null) {
    activate('closed');
  } else {
    setSheetDetent('closed');
  }
}

/**
 * Initialize the mobile sheet. Called once from boot, after the sidebar
 * (which seeds the view mode from the URL) and before the view shell
 * (so a Brief boot finds the shell already seated). `opts.deepLinkBoot`
 * marks a `?select=` boot: its briefing open may auto-raise the closed
 * sheet (the shared link is the ask; since S2, D-0.7.0-041, the deep
 * link is also the ONLY boot-time briefing opener).
 */
export function initMobileSheet(
  map: maplibregl.Map,
  opts: { deepLinkBoot?: boolean } = {}
): void {
  mapRef = map;
  deepLinkRaise = opts.deepLinkBoot ?? false;
  const markInteracted = (): void => {
    userInteracted = true;
  };
  document.addEventListener('pointerdown', markInteracted, { once: true, capture: true });
  document.addEventListener('keydown', markInteracted, { once: true, capture: true });
  appEl = document.getElementById('app');
  sidebarEl = document.getElementById('sidebar');
  atHandBodyEl = document.getElementById('sheet-at-hand-body');
  if (!appEl || !sidebarEl) return;

  // Module-local polite live region for detent announcements.
  const region = document.createElement('div');
  region.className = 'sr-only';
  region.setAttribute('aria-live', 'polite');
  document.body.appendChild(region);
  liveRegionEl = region;

  // The console half detent's one door to the full catalog stack.
  document.getElementById('sheet-all-layers-btn')?.addEventListener('click', () => {
    setSheetDetent('full');
  });

  // The at-hand Tribal Nations action (umbrella build Unit F): the Brief
  // half detent shows the at-hand summary INSTEAD of the report, so the
  // report-hosted action needs this mirror to stay reachable. found-090:
  // wired as a real toggle through the same shared command and pressed-state
  // mirror the Brief-door host uses (M14), not a one-shot activation, so a
  // third press can turn the set off again. The visible label is re-stamped
  // from the group config so the static index.html copy cannot drift from
  // it; the accessible name and description are the toggle wiring's job.
  const atHandAction = document.getElementById('tribal-nations-at-hand-action');
  if (atHandAction instanceof HTMLButtonElement) {
    atHandAction.textContent = TRIBAL_NATIONS_GROUP.label;
    atHandAction.addEventListener('click', () => toggleTribalNationsGroup());
    const atHandDesc = document.getElementById('tribal-nations-at-hand-action-desc') ?? undefined;
    wireTribalNationsToggle(atHandAction, atHandDesc);
    const atHandHealth = document.getElementById('tribal-nations-at-hand-health');
    if (atHandHealth) wireTribalNationsHealth(atHandHealth);
  }

  buildSheetPlaceStudioEntry();

  // The Brief half detent's one door to the standalone report (stable DOM
  // now, so it is wired once here rather than on every renderAtHand()).
  document.getElementById('sheet-report-door')?.addEventListener('click', () => {
    // A place that is only selected has no report to rise to: the door
    // opens its briefing, which answers in this block first.
    const selected = selectedWithoutBriefing();
    if (selected) {
      openSelectedBriefing?.(selected);
      return;
    }
    setSheetDetent('full');
  });
  // The block names the selected place as soon as there is one, and lets go
  // of it when the selection is cleared.
  onPlaceSelectionChange(() => {
    if (sheetBriefing === null) renderAtHand();
  });

  // Nothing takes focus where it cannot be seen. Peek shows only the first
  // lines, so focus entering the content raises the sheet to half; a text
  // entry raises it to full, where the on-screen keyboard leaves its
  // results room (not while a report is open: at full the report replaces
  // the at-hand block the entry lives in).
  sidebarEl.addEventListener('focusin', (event) => {
    const target = event.target;
    if (detent === null || detent === 'closed' || !(target instanceof HTMLElement)) return;
    if (!target.closest('.sidebar-scroll')) return;
    const typing =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && /^(text|search)$/.test(target.type));
    if (typing && !sidebarEl?.querySelector('#sheet-report .impact-panel.open')) {
      if (detent !== 'full') {
        raisedForEntry = true;
        setSheetDetent('full');
      }
    } else if (detent === 'peek') {
      setSheetDetent('half');
    }
  });

  wireFooterNav();
  // The title re-reads on these three attributes (src/ui/sheet-motion.ts);
  // the lit door re-reads with it, in the same turn.
  new MutationObserver(lightDoors).observe(appEl, {
    attributes: true,
    attributeFilter: ['data-sheet-detent', 'data-sheet-name', 'class']
  });

  document.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      detent === null ||
      detent === 'closed'
    ) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Nested surfaces own their first Escape. In particular, the search
    // clears its query and the briefing returns from the report to the
    // at-hand panel; neither action should also dismiss the side panel.
    if (target.closest('#impact-panel, #map-key, #map-info-panel')) return;
    if (!sidebarEl?.contains(target) && !target.closest('#mobile-footer-nav')) return;
    const active = document.querySelector<HTMLButtonElement>(
      '#mobile-footer-nav button.active[data-tab]'
    );
    setSheetDetent('closed');
    active?.focus();
  });

  mql?.addEventListener('change', evaluate);
  window.addEventListener('beforeprint', () => {
    if (printReleaseFrame !== null) window.cancelAnimationFrame(printReleaseFrame);
    printReleaseFrame = null;
    printing = true;
  });
  window.addEventListener('afterprint', () => {
    if (printReleaseFrame !== null) window.cancelAnimationFrame(printReleaseFrame);
    // Width media queries can still describe paper inside afterprint. Reconcile
    // at the next screen frame, retaining ordinary resize behavior thereafter.
    printReleaseFrame = window.requestAnimationFrame(() => {
      printReleaseFrame = null;
      printing = false;
      evaluate();
    });
  });

  // Browser chrome and the keyboard can resize the map behind an open panel.
  const vv = window.visualViewport;
  if (vv) {
    let vvTimer: number | null = null;
    vv.addEventListener('resize', () => {
      if (vvTimer !== null) window.clearTimeout(vvTimer);
      vvTimer = window.setTimeout(() => {
        vvTimer = null;
        if (detent !== null) settle();
      }, 150);
    });
  }

  evaluate();
}
