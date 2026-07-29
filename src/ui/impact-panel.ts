/**
 * Eager impact-panel facade and shared panel shell.
 *
 * The public signatures stay synchronous for the frozen UI-service contract,
 * while the briefing renderer, source hydration, evidence claims, and charts
 * load on first open. The shared shell keeps successful and unavailable
 * presentations on one host, detent, dismiss, ARIA, and focus contract.
 */

import type {
  BoundarySelectionContext,
  Horizon,
  ImpactBriefing
} from '../impact/types';
import {
  getPlaceSelection,
  setPlaceSelection
} from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { getViewMode } from '../state/view-mode';
import {
  driveSheetForReport,
  getSheetDetent,
  isSheetActive,
  onSheetDetentSettle,
  restoreSheetDetent,
  setSheetBriefing,
  setSheetDetent,
  sheetAllowsAutoRaise,
  sheetReportHost
} from './mobile-sheet';
import { hideLoading, showLoading } from './overlay';
import { buildTribalNationsBriefAction } from './tribal-nations-action';

type ImpactPanelRuntime = typeof import('./impact-panel-runtime');
type RuntimeLoader = () => Promise<ImpactPanelRuntime>;

interface PendingOpen {
  readonly token: number;
  delayId: number | null;
  loadingToken: number | null;
}

export interface ImpactPanelShell {
  readonly panel: HTMLElement;
  readonly body: HTMLElement;
  readonly title: HTMLElement;
  readonly kind: HTMLElement;
}

const UNAVAILABLE_NOTE =
  'The drought impact briefing is unavailable because its application module could not load.';

const RUNTIME_LOADERS: readonly RuntimeLoader[] = [
  () => import('./impact-panel-runtime-primary'),
  () => import('./impact-panel-runtime-recovery')
];

let runtime: ImpactPanelRuntime | null = null;
let runtimePromise: Promise<ImpactPanelRuntime> | null = null;
let nextRuntimeLoader = 0;
let currentRuntimeToken: number | null = null;
let openToken = 0;
let briefingIntentSeq = 0;
let pendingOpen: PendingOpen | null = null;
let unavailableOpen = false;
let unavailableSelection: PlaceSelection | null = null;

let shell: ImpactPanelShell | null = null;
let shellOpener: HTMLElement | null = null;
let shellHardClose: (() => void) | null = null;
let hostSyncArmed = false;

/** Visible, keyboard-focusable descendants of the panel, in DOM order. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

function requestPanelDismiss(): void {
  if (
    shell?.panel.classList.contains('sheet-hosted') &&
    isSheetActive() &&
    getViewMode() === 'brief'
  ) {
    restoreSheetDetent();
    document.getElementById('sheet-report-door')?.focus();
    return;
  }
  shellHardClose?.();
}

/** Create or return the one panel shell shared by every presentation. */
export function ensureImpactPanelShell(): ImpactPanelShell {
  if (shell) return shell;

  const panel = document.createElement('aside');
  panel.id = 'impact-panel';
  panel.className = 'impact-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'impact-panel-title');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="impact-panel-header">
      <div class="impact-panel-heading">
        <p class="impact-panel-kicker">Drought impact briefing</p>
        <h2 id="impact-panel-title" class="impact-panel-title"></h2>
        <p class="impact-panel-kind"></p>
      </div>
      <button type="button" class="impact-panel-close" aria-label="Close briefing" title="Close briefing">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div class="impact-panel-body"></div>
  `;
  document.body.appendChild(panel);

  const isEmbedBoot =
    document.getElementById('app')?.classList.contains('embed') ?? false;
  if (isEmbedBoot) {
    panel
      .querySelector('.impact-panel-header')
      ?.insertAdjacentElement('afterend', buildTribalNationsBriefAction());
  }

  const body = panel.querySelector<HTMLElement>('.impact-panel-body');
  const title = panel.querySelector<HTMLElement>('.impact-panel-title');
  const kind = panel.querySelector<HTMLElement>('.impact-panel-kind');
  if (!body || !title || !kind) {
    throw new Error('impact panel shell is missing required elements');
  }
  shell = { panel, body, title, kind };

  panel
    .querySelector<HTMLButtonElement>('.impact-panel-close')
    ?.addEventListener('click', requestPanelDismiss);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shell && !shell.panel.hidden) {
      requestPanelDismiss();
    }
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || panel.hidden) return;
    if (panel.getAttribute('aria-modal') !== 'true') return;
    const focusables = getFocusable(panel);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  });

  if (!hostSyncArmed) {
    hostSyncArmed = true;
    onSheetDetentSettle(syncImpactPanelHost);
  }
  return shell;
}

/** Rehost the one panel into the active mobile sheet or document body. */
export function syncImpactPanelHost(): void {
  if (!shell) return;
  const { panel } = shell;
  const host = sheetReportHost();
  const closeBtn = panel.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (host) {
    const entering = panel.parentElement !== host;
    if (entering) host.appendChild(panel);
    panel.classList.add('sheet-hosted');
    panel.setAttribute('aria-modal', 'false');
    closeBtn?.setAttribute('aria-label', 'Close the full report');
    closeBtn?.setAttribute('title', 'Close the full report');
    if (entering && !panel.hidden && getViewMode() === 'console') {
      driveSheetForReport('full');
    }
    return;
  }

  if (panel.parentElement !== document.body) document.body.appendChild(panel);
  panel.classList.remove('sheet-hosted');
  closeBtn?.setAttribute('aria-label', 'Close briefing');
  closeBtn?.setAttribute('title', 'Close briefing');
  if (!panel.hidden) panel.setAttribute('aria-modal', 'true');
}

/**
 * Open the shared shell with the runtime or unavailable presentation as its
 * hard-close owner.
 */
export function openImpactPanelShell(
  onHardClose: () => void,
  requestedOpener?: HTMLElement | null
): ImpactPanelShell {
  const current = ensureImpactPanelShell();
  const { panel, body } = current;
  const active =
    requestedOpener !== undefined
      ? requestedOpener
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  const realOpener = active !== null && active !== document.body ? active : null;
  if (panel.hidden) {
    shellOpener = realOpener;
  } else if (
    shellOpener === null &&
    realOpener !== null &&
    !panel.contains(realOpener)
  ) {
    shellOpener = realOpener;
  }
  shellHardClose = onHardClose;

  syncImpactPanelHost();
  panel.hidden = false;
  if (panel.classList.contains('sheet-hosted')) {
    if (getViewMode() === 'console') {
      driveSheetForReport('full');
    } else if (
      getSheetDetent() === 'peek' ||
      (getSheetDetent() === 'closed' && sheetAllowsAutoRaise())
    ) {
      setSheetDetent('half');
    }
  } else {
    panel.setAttribute('aria-modal', 'true');
  }
  void panel.offsetWidth;
  panel.classList.add('open');

  const closeBtn = panel.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (
    closeBtn &&
    (!panel.classList.contains('sheet-hosted') || getSheetDetent() === 'full')
  ) {
    closeBtn.focus();
  }
  body.scrollTop = 0;
  return current;
}

/** Close the shared shell and restore its detent and opener. */
export function closeImpactPanelShell(restoreFocus = true): void {
  if (!shell) return;
  const { panel } = shell;
  if (
    panel.classList.contains('sheet-hosted') &&
    isSheetActive() &&
    !panel.hidden
  ) {
    restoreSheetDetent();
  }
  panel.classList.remove('open');
  panel.setAttribute('aria-modal', 'false');
  shellHardClose = null;

  const opener = shellOpener;
  shellOpener = null;
  if (restoreFocus && opener && document.contains(opener)) opener.focus();
  window.setTimeout(() => {
    if (shell && !shell.panel.classList.contains('open')) {
      shell.panel.hidden = true;
    }
  }, 260);
}

/** Whether the shared panel is still an active open presentation. */
export function isImpactPanelShellOpen(): boolean {
  return shell !== null && !shell.panel.hidden && shell.panel.classList.contains('open');
}

function finishPendingOpen(token?: number): void {
  if (!pendingOpen || (token !== undefined && pendingOpen.token !== token)) return;
  if (pendingOpen.delayId !== null) window.clearTimeout(pendingOpen.delayId);
  hideLoading(pendingOpen.loadingToken);
  pendingOpen = null;
}

function beginPendingOpen(token: number): void {
  finishPendingOpen();
  const pending: PendingOpen = {
    token,
    delayId: null,
    loadingToken: null
  };
  pending.delayId = window.setTimeout(() => {
    if (pendingOpen !== pending) return;
    pending.delayId = null;
    pending.loadingToken = showLoading('Loading drought impact briefing...');
  }, 120);
  pendingOpen = pending;
}

function invalidatePendingIntent(): void {
  briefingIntentSeq++;
  openToken++;
  currentRuntimeToken = null;
  finishPendingOpen();
}

function loadRuntime(): Promise<ImpactPanelRuntime> {
  if (runtime) return Promise.resolve(runtime);
  if (runtimePromise) return runtimePromise;

  const loader =
    RUNTIME_LOADERS[Math.min(nextRuntimeLoader, RUNTIME_LOADERS.length - 1)]!;
  nextRuntimeLoader++;
  runtimePromise = loader().then((loaded) => {
    runtime = loaded;
    loaded.setImpactPanelCloseHook(invalidatePendingIntent);
    return loaded;
  });
  void runtimePromise.then(
    () => undefined,
    () => {
      runtimePromise = null;
    }
  );
  return runtimePromise;
}

function unavailableHorizon(
  key: Horizon['key'],
  title: string,
  subtitle: string
): Horizon {
  return {
    key,
    title,
    subtitle,
    claims: [],
    status: 'unavailable',
    note: UNAVAILABLE_NOTE
  };
}

function unavailableBriefing(
  context: BoundarySelectionContext
): ImpactBriefing {
  return {
    context,
    sourcePolicy: {
      geography: {
        key: 'unknown',
        country: 'unknown',
        basis: 'unknown',
        note: UNAVAILABLE_NOTE
      },
      droughtImpact: { enabled: false, note: UNAVAILABLE_NOTE },
      sources: {
        pointHeat: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        nwsForecast: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        nwsAlerts: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        heatRisk: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        usdm: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        dsci: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        nifc: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        cpcExtended: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        enso: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        waterSupply: { state: 'unavailable', note: UNAVAILABLE_NOTE },
        cpcSeasonal: { state: 'unavailable', note: UNAVAILABLE_NOTE }
      }
    },
    landTitle: context.title,
    landKind: 'Boundary briefing',
    landCaveat: '',
    landscape: {
      status: 'unavailable',
      note: UNAVAILABLE_NOTE,
      facts: [],
      sources: []
    },
    pointHeat: {
      status: 'error',
      note: UNAVAILABLE_NOTE,
      point: { ...context.lngLat },
      observation: {
        status: 'error',
        note: UNAVAILABLE_NOTE,
        metrics: []
      },
      grid: {
        status: 'error',
        note: UNAVAILABLE_NOTE,
        metrics: []
      }
    },
    heatSynthesis: {
      status: 'error',
      reads: [],
      note: UNAVAILABLE_NOTE
    },
    horizons: {
      current: unavailableHorizon('current', 'Current conditions', 'now'),
      nearTerm: unavailableHorizon('nearTerm', 'Near-term outlook', 'days to weeks'),
      longRange: unavailableHorizon('longRange', 'Long-range outlook', 'months')
    },
    resources: []
  };
}

function clearUnavailableState(): void {
  unavailableOpen = false;
  setSheetBriefing(null);
  if (
    unavailableSelection !== null &&
    getPlaceSelection() === unavailableSelection
  ) {
    setPlaceSelection(null);
  }
  unavailableSelection = null;
}

function renderUnavailable(
  context: BoundarySelectionContext,
  opener: HTMLElement | null
): void {
  const current = ensureImpactPanelShell();
  current.title.textContent = context.title;
  current.kind.textContent = 'Boundary briefing';
  current.body.innerHTML = `
    <section class="impact-capability-unavailable" aria-label="Drought impact unavailable">
      <h3 class="impact-section-title">Drought impact unavailable</h3>
      <p class="impact-horizon-note">${UNAVAILABLE_NOTE}</p>
    </section>
  `;

  unavailableOpen = true;
  unavailableSelection = { label: context.title, context };
  setPlaceSelection(unavailableSelection);
  setSheetBriefing(unavailableBriefing(context));
  openImpactPanelShell(closeImpactPanel, opener);
}

/**
 * Open the impact briefing. The returned token represents this facade-level
 * open even while the lazy runtime is still loading.
 */
export function openImpactPanel(context: BoundarySelectionContext): number {
  const active =
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null;
  if (unavailableOpen) {
    clearUnavailableState();
    closeImpactPanelShell(false);
  }
  finishPendingOpen();

  const intent = ++briefingIntentSeq;
  const token = ++openToken;

  if (runtime) {
    currentRuntimeToken = runtime.openImpactPanel(context, active);
    return token;
  }

  beginPendingOpen(token);
  void loadRuntime().then(
    (loaded) => {
      finishPendingOpen(token);
      if (intent !== briefingIntentSeq || token !== openToken) return;
      currentRuntimeToken = loaded.openImpactPanel(context, active);
    },
    () => {
      finishPendingOpen(token);
      if (intent !== briefingIntentSeq || token !== openToken) return;
      currentRuntimeToken = null;
      renderUnavailable(context, active);
    }
  );
  return token;
}

/** Report an unavailable briefing when a prerequisite lazy module failed. */
export function openImpactPanelUnavailable(
  context: BoundarySelectionContext
): number {
  const active =
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null;
  if (unavailableOpen) {
    clearUnavailableState();
    closeImpactPanelShell(false);
  }
  finishPendingOpen();
  briefingIntentSeq++;
  const token = ++openToken;
  currentRuntimeToken = null;
  renderUnavailable(context, active);
  return token;
}

/** Whether `token` is still the active facade open. */
export function isCurrentBriefing(token: number): boolean {
  if (token !== openToken) return false;
  if (unavailableOpen) return isImpactPanelShellOpen();
  return (
    runtime !== null &&
    currentRuntimeToken !== null &&
    runtime.isCurrentBriefing(currentRuntimeToken)
  );
}

/**
 * Every async briefing opener declares intent before its own fetch starts.
 * Executed opens and closes use the same sequence, so the last intent wins.
 */
export function nextBriefingIntent(): number {
  finishPendingOpen();
  return ++briefingIntentSeq;
}

/** Whether `intent` is still the newest briefing declaration. */
export function isCurrentBriefingIntent(intent: number): boolean {
  return intent === briefingIntentSeq;
}

/** The briefing currently on screen, once the lazy runtime has opened it. */
export function getActiveBriefing(): ImpactBriefing | null {
  if (!runtime || currentRuntimeToken === null) return null;
  return runtime.getActiveBriefing();
}

/** Re-render the active runtime briefing when its hydration changes. */
export function refreshOpenBriefing(token: number): void {
  if (
    token !== openToken ||
    !runtime ||
    currentRuntimeToken === null
  ) {
    return;
  }
  runtime.refreshOpenBriefing(currentRuntimeToken);
}

/** Close the panel and invalidate an in-flight lazy open. */
export function closeImpactPanel(): void {
  if (unavailableOpen) {
    invalidatePendingIntent();
    clearUnavailableState();
    closeImpactPanelShell();
    return;
  }
  if (runtime) {
    runtime.closeImpactPanel();
    return;
  }
  invalidatePendingIntent();
}
