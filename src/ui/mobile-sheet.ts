/**
 * Mobile side-panel controller.
 *
 * Below 720 pixels the existing footer doors become a side rail. Each door
 * opens one glass panel below the map's top chrome, and pressing the active
 * door again closes it. The legacy detent names stay as internal adapters so
 * report hosting, deep links, and existing sidebar actions keep one contract.
 * They no longer describe drawer heights or add bottom camera padding.
 *
 * The panel state is ephemeral and never enters the URL. Embed mode keeps its
 * hidden-chrome behavior. The search chunk still mounts only when the mobile
 * shell activates, and report content remains owned by the impact panel.
 */

import type * as maplibregl from 'maplibre-gl';

import type { ImpactBriefing } from '../impact/types';
import { selectBriefNarrativeLine } from '../impact/brief-narrative-selector';
import {
  getViewMode,
  onViewModeChange,
  setViewMode,
  clearExplicitBriefBoot
} from '../state/view-mode';
import { escapeHtml } from '../util/escape';
import { TRIBAL_NATIONS_GROUP } from '../config/layer-groups';
import { enterPlaceStudio } from '../state/studio-route';
import { activateTribalNationsGroup, wireTribalNationsHealth } from './tribal-nations-action';
import { loadSearchController } from './search-chunk';

// ---------------------------------------------------------------------------
// Types and module state
// ---------------------------------------------------------------------------

/**
 * Legacy depth names retained for existing callers. `closed` hides the panel,
 * `half` opens an ordinary door, and `full` exposes report or catalog content.
 * `peek` is accepted for compatibility and renders as an ordinary open panel.
 */
export type SheetDetent = 'closed' | 'peek' | 'half' | 'full';

/** The side rail's four doors. Ephemeral like the detent; never in the URL. */
export type SheetTab = 'brief' | 'place' | 'layers' | 'alerts';

/** Legacy values retained for consumers that import the old sheet contract. */
export const SHEET_DETENT_SIZE = {
  peekPx: 132,
  halfFraction: 0.46,
  footerPx: 56,
  fullTopGapPx: 72
} as const;

/** Transform and opacity transition settle fallback. */
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

/** Side panels do not create a bottom obstruction for camera padding. */
export function currentSheetInsetPx(): number {
  return 0;
}

/** Subscribe to detent settles (after the height transition and map.resize). */
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
  peek: 'Panel open.',
  half: 'Panel open.',
  full: 'Full panel open.'
};

function announce(text: string): void {
  if (liveRegionEl) liveRegionEl.textContent = text;
}

/**
 * Move the panel to a legacy depth. CSS maps each open depth to the same
 * anchored glass surface while keeping the existing visibility matrix.
 */
export function setSheetDetent(next: SheetDetent, opts: { announce?: boolean } = {}): void {
  if (detent === null || !appEl) return;
  if (next === detent) return;
  detent = next;
  appEl.setAttribute('data-sheet-detent', next);
  // Closing by any road clears the active side-rail door.
  if (next === 'closed') syncFooterTab(null);
  if (opts.announce !== false) announce(DETENT_ANNOUNCE[next]);
  // Full content always opens at its top.
  if (next === 'full') {
    const scroll = sidebarEl?.querySelector<HTMLElement>('.sidebar-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
  scheduleSettle();
}

function scheduleSettle(): void {
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    settle();
  }, SETTLE_FALLBACK_MS);
}

/**
 * Resize MapLibre after a panel transition and clear the retired bottom
 * padding for every state, including the first run after an old session.
 */
function settle(): void {
  if (!mapRef) return;
  mapRef.resize();
  mapRef.jumpTo({ padding: { top: 0, left: 0, right: 0, bottom: 0 } });
  for (const fn of [...settleListeners]) {
    try {
      fn(detent);
    } catch (err) {
      console.error('[mobile-sheet] settle listener threw:', err);
    }
  }
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
  sheetBriefing = briefing;
  renderAtHand();
}

/** The critical-first point-heat or current-horizon line, when available. */
function currentHeadline(briefing: ImpactBriefing): string | null {
  return selectBriefNarrativeLine(briefing);
}

function updateAtHandActions(): void {
  const hasBriefing = sheetBriefing !== null;
  document
    .getElementById('sheet-at-hand-actions')
    ?.classList.toggle('has-briefing', hasBriefing);
  const reportDoor = document.getElementById('sheet-report-door');
  if (reportDoor) reportDoor.hidden = !hasBriefing;
}

function renderAtHand(): void {
  updateAtHandActions();
  if (!atHandBodyEl) return;
  const briefing = sheetBriefing;
  const title = briefing ? briefing.landTitle : 'Pick a place';
  const kind = briefing ? briefing.landKind : '';
  const headline = briefing ? currentHeadline(briefing) : null;
  const headlineHtml = headline
    ? `<p class="sheet-at-hand-headline">${escapeHtml(headline)}</p>`
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
 * Reflect the active door on the rail buttons (and the `data-sheet-tab`
 * attribute the alerts pane's stylesheet gate reads). Null clears all four:
 * the closed sheet has no active door, and a sheet raised by something other
 * than the rail shows content without claiming a door.
 */
function syncFooterTab(tab: SheetTab | null): void {
  if (appEl) {
    if (tab) appEl.setAttribute('data-sheet-tab', tab);
    else appEl.removeAttribute('data-sheet-tab');
  }
  const footer = document.getElementById('mobile-footer-nav');
  if (!footer) return;
  footer.setAttribute('aria-label', 'Mobile panels');
  for (const btn of footer.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
    const active = btn.dataset['tab'] === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-controls', 'sidebar');
    btn.setAttribute('aria-expanded', String(active));
  }
}

/**
 * Open a side-rail door: Brief is the full report and
 * opens at full; Place (the at-hand answer with the one search), Layers
 * (the console controls), and Alerts open at half. Brief and Place ride
 * the Brief view mode, Layers rides console; the mode is real URL state
 * and moves through the existing `setViewMode` machinery. Re-tapping the
 * active door closes to the edgeless map-first state.
 */
function openFooterTab(tab: SheetTab): void {
  if (detent === null || !appEl) return;
  const current = appEl.getAttribute('data-sheet-tab');
  if (current === tab && detent !== 'closed') {
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
    void import('./sheet-alerts').then(({ openSheetAlerts }) => {
      if (mapRef) openSheetAlerts(mapRef);
    });
  }
  const target: SheetDetent = tab === 'brief' ? 'full' : 'half';
  if (detent === target) {
    // Same detent, new pane (e.g. Layers -> Alerts at half): the attribute
    // flip re-gates the content; still settle so padding stays honest.
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

/** Every ordinary side-panel door uses the compact legacy `half` depth. */
function openingDetent(): SheetDetent {
  return 'half';
}

function activate(initial?: SheetDetent): void {
  if (!appEl || detent !== null) return;
  // Panel visibility is ephemeral: even an app-stamped view=brief URL
  // reloads with the map clear. Explicit doors and place selections open it.
  detent = initial ?? 'closed';
  appEl.setAttribute('data-sheet-detent', detent);
  // Stamp the static navigation with its side-panel semantics on the first
  // mobile activation, before any door has been pressed.
  syncFooterTab(null);
  renderAtHand();
  // Mount the shared search now (never at boot): the sheet is active only on
  // a mobile, non-embed viewport, so the C1 rule holds and the chunk is free.
  mountSheetSearch();
  // Activation settles SYNCHRONOUSLY (adversarial-review finding 3):
  // the settle listeners rehost an open briefing panel, and a delayed
  // settle leaves it in the wrong host (invisible) for the delay.
  settle();
}

function deactivate(): void {
  if (!appEl || detent === null) return;
  detent = null;
  restoreDetent = null;
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
  // report-hosted action needs this mirror to stay reachable. Same eager
  // command; the label and description are re-stamped from the group config
  // so the static index.html copy cannot drift from it.
  const atHandAction = document.getElementById('tribal-nations-at-hand-action');
  if (atHandAction) {
    atHandAction.textContent = TRIBAL_NATIONS_GROUP.label;
    atHandAction.setAttribute('aria-label', `Show ${TRIBAL_NATIONS_GROUP.label} layers`);
    atHandAction.addEventListener('click', () => activateTribalNationsGroup());
    const atHandDesc = document.getElementById('tribal-nations-at-hand-action-desc');
    if (atHandDesc) atHandDesc.textContent = TRIBAL_NATIONS_GROUP.actionDescription;
    const atHandHealth = document.getElementById('tribal-nations-at-hand-health');
    if (atHandHealth) wireTribalNationsHealth(atHandHealth);
  }

  buildSheetPlaceStudioEntry();

  // The Brief half detent's one door to the standalone report (stable DOM
  // now, so it is wired once here rather than on every renderAtHand()).
  document.getElementById('sheet-report-door')?.addEventListener('click', () => {
    setSheetDetent('full');
  });

  // A mode switch while the panel is open re-seats the ordinary depth unless the
  // report is up (the impact panel's mobile host owns that transition).
  // A closed sheet stays closed: the map-first state does not pop open
  // because state changed underneath it; the rail doors own opening.
  onViewModeChange(() => {
    if (detent === null || detent === 'full' || detent === 'closed') return;
    setSheetDetent(openingDetent(), { announce: false });
  });

  wireFooterNav();

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

  // The explicit-view ask is a BOOT-ONLY raise (DEF-2): whether or not the
  // boot viewport activated the sheet (a desktop boot does not), the flag
  // is spent now. Later activations (a desktop-to-mobile crossing, the
  // embed exit) keep their map-first behavior; the app's own `view=` stamp
  // never reopens the panel.
  clearExplicitBriefBoot();
}
