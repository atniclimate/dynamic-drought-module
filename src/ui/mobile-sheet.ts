/**
 * The mobile bottom sheet (0.7.0 U2; ratified detent model D-0.7.0-017).
 *
 * Below 720 pixels the sidebar element becomes ONE bottom sheet over a
 * full-viewport map, with three detents that are information depths, not
 * arbitrary heights: peek (the conditions strip and the date register),
 * half (the at-hand answer in Brief; the compact controls in console),
 * and full (the standalone report in Brief; the whole catalog stack in
 * console). Which sections show at which detent is stylesheet work keyed
 * off `#app[data-sheet-detent]` plus the existing `view-brief` and
 * `view-console` mode classes; this module owns the detent itself.
 *
 * Contract points, all from the ratified detent model:
 *
 * - The detent is EPHEMERAL presentation state: never written to the URL,
 *   never a second state machine. The only persisted flags remain `embed`,
 *   `view`, and the layer/region/temporal params through the existing
 *   `pushUrl()` machinery (headroom R3).
 * - The sheet moves ONLY via the grabber (drag with pointer capture, tap
 *   to cycle, Enter/Space cycles, arrow keys step) and explicit buttons.
 *   Content regions scroll internally only at full (guardrail 1:
 *   grabber-owned movement; WCAG 2.2 dragging-movements).
 * - In `?embed=true` the sheet does not exist (today's hidden-chrome
 *   semantics byte for byte); the existing expand control exits embed and
 *   reveals the sheet at peek (`revealSheetAtPeek`, called by the
 *   sidebar's expand handler).
 * - Brief opens at half (the answer over the map); console opens at peek
 *   (map-first). A mode switch while the sheet is active re-seats the
 *   detent the same way.
 * - Every detent settle calls `map.resize()` (the map-resize
 *   invariant) and reports through `onSheetDetentSettle` so the camera
 *   padding path can react without this module importing camera code.
 *
 * The at-hand block (the half detent's Brief content) renders from the
 * active briefing PUSHED here by the impact panel's internals
 * (`setSheetBriefing`); this module never reaches into the briefing
 * lifecycle, so the frozen `openImpactPanel` facade stays the one owner
 * of hydration. The place picker is the ONE shared search (U3), mounted
 * lazily on first sheet activation via `search-controller`; keeping that
 * import lazy (and off the boot path) is what keeps this module free of
 * static `deep-link`/`impact-panel` imports (no import cycle) and honors
 * the C1 rule (an embed, which never activates the sheet, never downloads
 * the search chunk).
 *
 * Stewardship: the at-hand block renders only what the briefing model
 * carries (title, kind, the current-horizon claim text); nothing is
 * invented, and an unhydrated briefing reads as an honest invitation to
 * open the full report, never a fabricated reading.
 */

import type maplibregl from 'maplibre-gl';

import type { ImpactBriefing } from '../impact/types';
import { selectBriefNarrativeLine } from '../impact/brief-narrative-selector';
import {
  getViewMode,
  onViewModeChange,
  setViewMode,
  isExplicitBriefBoot,
  clearExplicitBriefBoot
} from '../state/view-mode';
import { escapeHtml } from '../util/escape';
import { prefersReducedMotion } from '../util/motion';
import { TRIBAL_NATIONS_GROUP } from '../config/layer-groups';
import { enterPlaceStudio } from '../state/studio-route';
import { activateTribalNationsGroup, wireTribalNationsHealth } from './tribal-nations-action';

// ---------------------------------------------------------------------------
// Types and module state
// ---------------------------------------------------------------------------

/**
 * The four detents (mobile shell, 2026-07-14, from the ratified 2026-07-11
 * mockup): `closed` is the edgeless map-first state (no sheet edge, no
 * grabber; the footer nav is the only chrome), and the three information
 * depths above it are unchanged from D-0.7.0-017. `closed` is an ACTIVE
 * shell state: null still means desktop or embed (no shell at all).
 */
export type SheetDetent = 'closed' | 'peek' | 'half' | 'full';

/** The footer nav's four doors. Ephemeral like the detent; never in the URL. */
export type SheetTab = 'brief' | 'place' | 'layers' | 'alerts';

/**
 * Nominal detent heights. The peek height and the half fraction are the
 * ONE shared lookup (cartography lens): the stylesheet's
 * `--sheet-height` values are written from this table at activation, and
 * the camera-padding path reads the LIVE rendered height via
 * `currentSheetInsetPx()`, so the two surfaces cannot drift apart.
 */
export const SHEET_DETENT_SIZE = {
  /** Peek: the grabber, the compacted conditions strip, the date register.
   * 132 clears the three tiles with their sublabels (124 clipped the tile
   * feet by ~10px; screenshot-matrix finding, 2026-07-10). */
  peekPx: 132,
  /** Half: fraction of the dynamic viewport (the mockup's 46 percent). */
  halfFraction: 0.46,
  /** The footer nav's bar height (safe-area inset rides on top in CSS). */
  footerPx: 56,
  /** Full leaves this gap at the top so the key bar and a map edge stay
   * visible (the mockup's context strip). */
  fullTopGapPx: 72
} as const;

const HINT_STORAGE_KEY = 'ddm-sheet-hint-dismissed';
/** A pointer move beyond this many pixels is a drag, not a tap. */
const DRAG_THRESHOLD_PX = 6;
/** The sheet may not be dragged shorter than this (the grabber stays reachable). */
const MIN_DRAG_HEIGHT_PX = 72;
/** Height-transition settle fallback when `transitionend` never fires. */
const SETTLE_FALLBACK_MS = 320;
const PLACE_STUDIO_OPENER_EVENT = 'ddm:place-studio-opener';

let mapRef: maplibregl.Map | null = null;

let appEl: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;
let grabberEl: HTMLButtonElement | null = null;
/** The dynamic read region rebuilt on every briefing push (the search and
 * the report door are stable siblings, so an innerHTML rebuild never wipes
 * the mounted Preact search). */
let atHandBodyEl: HTMLElement | null = null;
/** Guard so the shared search mounts at most once (idempotent activation). */
let searchMounted = false;
let liveRegionEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;

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

/** Whether the bottom sheet currently exists (mobile viewport, not embed). */
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
 * The LIVE bottom obstruction in pixels, for camera padding: the sheet's
 * measured rect PLUS the footer nav's (the sheet rides above the footer in
 * the mobile shell, so the map's covered strip is their sum), never a
 * parallel constant (the shared-lookup rule). Zero when the shell is
 * inactive. At full the map is covered and no camera call should fire;
 * callers check `getSheetDetent()` first.
 */
export function currentSheetInsetPx(): number {
  if (detent === null || !sidebarEl) return 0;
  const sheet = detent === 'closed' ? 0 : Math.round(sidebarEl.getBoundingClientRect().height);
  return sheet + footerInsetPx();
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

/** The footer nav's LIVE rendered height (bar plus safe-area inset). */
function footerInsetPx(): number {
  const footer = document.getElementById('mobile-footer-nav');
  if (!footer || detent === null) return 0;
  return Math.round(footer.getBoundingClientRect().height);
}

/** Pixel height a detent resolves to against the current viewport. */
function detentHeightPx(d: SheetDetent): number {
  const vh = window.innerHeight;
  if (d === 'closed') return 0;
  if (d === 'peek') return Math.min(SHEET_DETENT_SIZE.peekPx, vh);
  if (d === 'half') return Math.round(vh * SHEET_DETENT_SIZE.halfFraction);
  return Math.max(0, vh - SHEET_DETENT_SIZE.footerPx - SHEET_DETENT_SIZE.fullTopGapPx);
}

const DETENT_ANNOUNCE: Record<SheetDetent, string> = {
  closed: 'Sheet closed: the map leads. The footer buttons reopen it.',
  peek: 'Sheet at peek: conditions in view.',
  half: 'Sheet at half: the at-hand answer.',
  full: 'Sheet at full height.'
};

function announce(text: string): void {
  if (liveRegionEl) liveRegionEl.textContent = text;
}

function updateGrabberState(): void {
  if (!grabberEl || detent === null) return;
  grabberEl.setAttribute(
    'aria-label',
    `Resize the briefing sheet (now at ${detent}). Enter cycles; arrow keys step.`
  );
}

/**
 * Move the sheet to a detent. The stylesheet owns the height values
 * (keyed off the attribute this sets); this module owns the settle:
 * after the height transition, `map.resize()` runs (invariant 7) and
 * the settle listeners fire so camera padding can follow.
 */
export function setSheetDetent(next: SheetDetent, opts: { announce?: boolean } = {}): void {
  if (detent === null || !appEl) return;
  dismissHint();
  if (next === detent) return;
  detent = next;
  appEl.setAttribute('data-sheet-detent', next);
  // Closing by ANY road (a footer re-tap, a grabber drag to the bottom, a
  // hazard-rail quick select) clears the footer door: the closed state has
  // no active tab, exactly as the mockup's closeSheet ruled.
  if (next === 'closed') syncFooterTab(null);
  updateGrabberState();
  if (opts.announce !== false) announce(DETENT_ANNOUNCE[next]);
  // Full opens at its top (the report's place title and caveat, or the
  // catalog's first group), never wherever the half detent left off
  // (product lens).
  if (next === 'full') {
    const scroll = sidebarEl?.querySelector<HTMLElement>('.sidebar-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
  scheduleSettle();
}

function scheduleSettle(): void {
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  const delay = prefersReducedMotion() ? 0 : SETTLE_FALLBACK_MS;
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    settle();
  }, delay);
}

/**
 * Detent settle: `map.resize()` (invariant 7), then the persistent-padding
 * write. The transform padding is the ONE camera authority for the sheet
 * inset (MapLibre's `cameraForBounds` composes it with any per-fit option
 * padding, verified in the installed v5 source), so the briefing fit path
 * passes only its aesthetic margins and can never double-count the sheet.
 * At full the map has receded: no camera call fires (cartography lens),
 * and the last peek/half padding simply persists until the sheet returns.
 */
function settle(): void {
  if (!mapRef) return;
  mapRef.resize();
  if (detent === null) {
    // Shell gone (desktop crossing, embed): the inset authority resets.
    mapRef.jumpTo({ padding: { top: 0, left: 0, right: 0, bottom: 0 } });
  } else if (detent !== 'full') {
    // Closed, peek, and half all pad by the live obstruction (sheet rect
    // plus the footer bar); at closed that is just the footer.
    mapRef.easeTo({
      padding: { top: 0, left: 0, right: 0, bottom: currentSheetInsetPx() },
      duration: prefersReducedMotion() ? 0 : 220
    });
  }
  for (const fn of [...settleListeners]) {
    try {
      fn(detent);
    } catch (err) {
      console.error('[mobile-sheet] settle listener threw:', err);
    }
  }
}

/** The detent whose height is nearest to a dragged pixel height. */
function nearestDetent(heightPx: number): SheetDetent {
  const candidates: SheetDetent[] = ['closed', 'peek', 'half', 'full'];
  let best: SheetDetent = 'peek';
  let bestDist = Infinity;
  for (const d of candidates) {
    const dist = Math.abs(detentHeightPx(d) - heightPx);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

function stepDetent(direction: 1 | -1): void {
  if (detent === null) return;
  const order: SheetDetent[] = ['closed', 'peek', 'half', 'full'];
  const idx = order.indexOf(detent);
  const next = order[Math.min(order.length - 1, Math.max(0, idx + direction))];
  if (next && next !== detent) setSheetDetent(next);
}

function cycleDetent(): void {
  if (detent === null) return;
  // The cycle covers the OPEN depths; closed is reachable by stepping or
  // dragging down (the grabber is invisible at closed, so a cycle that
  // landed there would strand keyboard users with nothing focusable).
  const order: SheetDetent[] = ['peek', 'half', 'full'];
  const idx = order.indexOf(detent);
  const next = order[(idx + 1) % order.length]!;
  setSheetDetent(next);
}

// ---------------------------------------------------------------------------
// Grabber wiring (drag, tap, keyboard)
// ---------------------------------------------------------------------------

function wireGrabber(): void {
  if (!grabberEl) return;
  const grabber = grabberEl;

  let dragging = false;
  let moved = false;
  let startY = 0;
  let startHeight = 0;

  grabber.addEventListener('pointerdown', (e) => {
    if (detent === null || !sidebarEl || !appEl) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startHeight = sidebarEl.getBoundingClientRect().height;
    grabber.setPointerCapture(e.pointerId);
    appEl.classList.add('sheet-dragging');
  });

  grabber.addEventListener('pointermove', (e) => {
    if (!dragging || !appEl) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > DRAG_THRESHOLD_PX) moved = true;
    const h = Math.max(
      MIN_DRAG_HEIGHT_PX,
      Math.min(window.innerHeight, Math.round(startHeight + dy))
    );
    appEl.style.setProperty('--sheet-height', `${h}px`);
  });

  const endDrag = (e: PointerEvent): void => {
    if (!dragging || !appEl) return;
    dragging = false;
    if (grabber.hasPointerCapture(e.pointerId)) grabber.releasePointerCapture(e.pointerId);
    appEl.classList.remove('sheet-dragging');
    const inline = appEl.style.getPropertyValue('--sheet-height');
    appEl.style.removeProperty('--sheet-height');
    if (moved && inline) {
      const target = nearestDetent(parseFloat(inline));
      if (target === detent) {
        // Same detent: the CSS height snaps back; still settle (resize).
        scheduleSettle();
      } else {
        setSheetDetent(target);
      }
    }
  };
  grabber.addEventListener('pointerup', endDrag);
  grabber.addEventListener('pointercancel', endDrag);

  grabber.addEventListener('click', () => {
    // A click that concluded a real drag is not a tap; the drag chose.
    if (moved) {
      moved = false;
      return;
    }
    cycleDetent();
  });

  grabber.addEventListener('keydown', (e) => {
    if (detent === null) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepDetent(1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepDetent(-1);
    }
    // Enter and Space fall through to the native button click (cycle).
  });
}

// ---------------------------------------------------------------------------
// First-use hint (product lens: one-time, dismissible, localStorage-gated)
// ---------------------------------------------------------------------------

function hintDismissed(): boolean {
  try {
    return window.localStorage.getItem(HINT_STORAGE_KEY) === '1';
  } catch {
    // Storage unavailable (privacy mode): show at most once per session.
    return sessionHintShown;
  }
}

let sessionHintShown = false;

function markHintDismissed(): void {
  sessionHintShown = true;
  try {
    window.localStorage.setItem(HINT_STORAGE_KEY, '1');
  } catch {
    // Honest no-op: the session flag above still prevents repeats.
  }
}

function showHintOnce(): void {
  if (hintDismissed() || hintEl || !grabberEl?.parentElement) return;
  sessionHintShown = true;
  const hint = document.createElement('div');
  hint.className = 'sheet-hint';
  hint.innerHTML = `
    <span>Drag up for the full briefing</span>
    <button type="button" class="sheet-hint-dismiss" aria-label="Dismiss hint">&times;</button>
  `;
  hint.querySelector('button')?.addEventListener('click', () => {
    markHintDismissed();
    dismissHint();
  });
  grabberEl.parentElement.appendChild(hint);
  hintEl = hint;
}

function dismissHint(): void {
  if (!hintEl) return;
  markHintDismissed();
  hintEl.remove();
  hintEl = null;
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
  void import('./search-controller').then(({ mountSearchInto }) => {
    mountSearchInto(map, container);
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
  placeButton.title = 'Open the PLACE studio: choose a place for the briefing';
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
  const target = restoreDetent ?? (getViewMode() === 'brief' ? 'half' : 'peek');
  restoreDetent = null;
  setSheetDetent(target);
}

// ---------------------------------------------------------------------------
// The footer nav (mobile shell, 2026-07-14; the mockup's four doors)
// ---------------------------------------------------------------------------

/**
 * Reflect the active door on the footer buttons (and the `data-sheet-tab`
 * attribute the alerts pane's stylesheet gate reads). Null clears all four:
 * the closed sheet has no active door, and a sheet raised by something other
 * than the footer (a briefing open, the embed-exit reveal) shows content
 * without claiming a door, exactly as the mockup's map popup did.
 */
function syncFooterTab(tab: SheetTab | null): void {
  if (appEl) {
    if (tab) appEl.setAttribute('data-sheet-tab', tab);
    else appEl.removeAttribute('data-sheet-tab');
  }
  const footer = document.getElementById('mobile-footer-nav');
  if (!footer) return;
  for (const btn of footer.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
    const active = btn.dataset['tab'] === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-expanded', String(active));
  }
}

/**
 * Open a footer door (the mockup's openTab): Brief IS the full report and
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

/** The mode's opening detent when a surface is explicitly requested
 * (Brief at half, console at peek); the BOOT is map-first at closed. */
function openingDetent(): SheetDetent {
  return getViewMode() === 'brief' ? 'half' : 'peek';
}

function activate(initial?: SheetDetent): void {
  if (!appEl || detent !== null) return;
  // Map-first boot (mobile shell, from the ratified mockup): the shell
  // activates CLOSED, an edgeless map with the footer nav. Content raises
  // the sheet only on an explicit ask: a footer door, a briefing open
  // (the impact panel's mobile host), or the embed-exit reveal at peek.
  // The ONE boot-time exception (U-UX-FIX-1 DEF-2, the same family as the
  // `?select=` deep link): an INBOUND URL that literally carried
  // `view=brief` is itself the ask, so the boot activation opens the
  // Brief surface at its half detent; the URL-as-state invariant means a
  // shared or reloaded link reproduces what the sender saw. Only the raw
  // parse-time flag qualifies (the app stamps `view=` onto every URL
  // after the first sync, so the current mode alone can never earn the
  // raise); initMobileSheet clears it after the boot evaluation.
  detent =
    initial ??
    (isExplicitBriefBoot() && getViewMode() === 'brief' ? 'half' : 'closed');
  appEl.setAttribute('data-sheet-detent', detent);
  updateGrabberState();
  renderAtHand();
  // Mount the shared search now (never at boot): the sheet is active only on
  // a mobile, non-embed viewport, so the C1 rule holds and the chunk is free.
  mountSheetSearch();
  if (detent === 'peek') showHintOnce();
  // Seed the padding authority immediately from the detent table (the
  // rect is mid-transition here; the settle refines with the measured
  // value) so a boot-time briefing fit composes the sheet inset instead
  // of racing the settle timer.
  if (detent !== 'full') {
    mapRef?.jumpTo({
      padding: {
        top: 0,
        left: 0,
        right: 0,
        // The footer bar is part of the obstruction; the settle refines
        // with the measured rects (including the safe-area inset).
        bottom: detentHeightPx(detent) + SHEET_DETENT_SIZE.footerPx
      }
    });
  }
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
  appEl.style.removeProperty('--sheet-height');
  appEl.classList.remove('sheet-dragging');
  dismissHint();
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
 * The embed-exit path (ratified): the expand control exits embed and
 * reveals the sheet at peek. Called by the sidebar's expand handler after
 * it removes the `embed` class; a desktop expand is a no-op here.
 */
export function revealSheetAtPeek(): void {
  if (!shouldBeActive()) return;
  if (detent === null) {
    activate('peek');
  } else {
    setSheetDetent('peek');
  }
  showHintOnce();
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
  grabberEl = document.getElementById('sheet-grabber') as HTMLButtonElement | null;
  atHandBodyEl = document.getElementById('sheet-at-hand-body');
  if (!appEl || !sidebarEl || !grabberEl) return;

  // Publish the shared detent sizes to the stylesheet (the one lookup:
  // this table is also what the drag-snap math reads, and the camera
  // padding path measures the live rect, so no surface can drift).
  appEl.style.setProperty('--sheet-peek', `${SHEET_DETENT_SIZE.peekPx}px`);
  appEl.style.setProperty('--sheet-half', String(SHEET_DETENT_SIZE.halfFraction));
  appEl.style.setProperty('--sheet-footer', `${SHEET_DETENT_SIZE.footerPx}px`);
  appEl.style.setProperty('--sheet-full-gap', `${SHEET_DETENT_SIZE.fullTopGapPx}px`);

  // Module-local polite live region for detent announcements.
  const region = document.createElement('div');
  region.className = 'sr-only';
  region.setAttribute('aria-live', 'polite');
  document.body.appendChild(region);
  liveRegionEl = region;

  wireGrabber();

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

  // A mode switch while the sheet is OPEN re-seats the detent the way
  // the mode would have opened (Brief: half; console: peek), unless the
  // report is up (the impact panel's mobile host owns that transition).
  // A closed sheet stays closed: the map-first state does not pop open
  // because state changed underneath it; the footer doors own opening.
  onViewModeChange(() => {
    if (detent === null || detent === 'full' || detent === 'closed') return;
    setSheetDetent(openingDetent(), { announce: false });
  });

  wireFooterNav();

  mql?.addEventListener('change', evaluate);

  // Mobile browser chrome (the address bar, the keyboard) changes the
  // visual viewport without a layout-intent event; the half detent's
  // dvh-derived height moves with it while the camera padding was measured
  // against the old height. A debounced re-settle keeps map.resize() and
  // the padding authority honest (invariant 7; Codex design pass,
  // 2026-07-14). Guarded to the active sheet: on desktop and in embed the
  // detent is null and MapLibre's own container observer already resizes.
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
  // embed-exit reveal at peek) keep their ratified map-first or peek
  // behavior; the app's own `view=` stamp never re-raises the sheet.
  clearExplicitBriefBoot();
}
