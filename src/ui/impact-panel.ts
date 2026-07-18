/**
 * Drought-impact briefing panel.
 *
 * The headline kernel-integration feature. A click on a boundary (ecoregion,
 * Tribal Lands feature, Treaty area, or Bureau of Indian Affairs reservation)
 * opens a lightweight identity popup with a "Drought impact briefing" button;
 * the button opens this slide-in panel, which composes the land identity, the
 * drought impacts across three temporal horizons (wildfire and extreme heat
 * foregrounded), and the public resources routed in stewardship order.
 *
 * This module is the rendering half (claims to DOM). The analysis half (data
 * to claims) lives in `src/impact/`. The panel never invents a value: it
 * renders only what the briefing model carries, and an unfilled horizon reads
 * as "loading" or, honestly, "unavailable" rather than as a fabricated reading.
 *
 * Embed-safe: the panel is appended to `document.body` and positioned over the
 * map, so it does not depend on the sidebar and works under `?embed=true`.
 * Mobile: below 720 pixels it stacks as a bottom sheet (see app.css). All
 * dynamic strings pass through `escapeHtml`; only `https://` links render as
 * anchors. Respects `prefers-reduced-motion` via the stylesheet.
 *
 * Phase 2 renders the skeleton (land plus live resources, horizons in their
 * loading state). Phase 3 calls `hydrateBriefing` to fill the horizons from
 * verified sources, then `refreshOpenBriefing` to re-render in place.
 */

import { createBriefingSkeleton } from '../impact/briefing';
import { hydrateBriefing } from '../impact/hydrate';
import { loadFederalResources, resourcesForIdentity } from '../impact/resource-catalog';
import { resolveLocationIdentity } from '../state/location-identity';
import { getMap } from '../state/map-store';
import { getPlaceSelection, setPlaceSelection } from '../state/place-selection';
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
import type {
  BoundarySelectionContext,
  Horizon,
  HorizonStatus,
  ImpactBriefing,
  ResourceLink,
  ResourceTier,
  SourcedClaim
} from '../impact/types';
import { escapeHtml } from '../util/escape';
import { buildTribalNationsBriefAction } from './tribal-nations-action';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let kindEl: HTMLElement | null = null;

/**
 * The element focused at the moment the panel opened (the trigger), so focus
 * can be restored to it on close instead of being dropped to the body
 * (critical-review #16, WCAG 2.4.3). Null when opened from a deep link (no
 * focused opener), in which case close leaves focus where it is.
 */
let openerEl: HTMLElement | null = null;

/** The briefing currently shown, so Phase 3 hydration can re-render in place. */
let activeBriefing: ImpactBriefing | null = null;

/**
 * Supersede token. Incremented on every open and on close so an async
 * hydration started for one selection cannot render into a panel that has
 * since been closed or reopened for a different boundary.
 */
let openToken = 0;

/**
 * Master abort controller for the active briefing's live hydration. Aborted on
 * close and on reopen so superseded fetches are cancelled and cannot render
 * into a torn-down panel (CLAUDE.md section 6 invariant 5).
 */
let activeController: AbortController | null = null;

/**
 * The place selection this panel owns while a briefing is open (the U3
 * stage-5 majors 3/4 fix). An open REPLACES the store's selection with a
 * fresh object for the briefing's context, and a close clears the store only
 * if this panel's selection is still current. Two consequences, both
 * deliberate: (a) the popup whose close handler guards on ITS selection
 * object no longer clears the store when the impact trigger removes that
 * popup, so the feature-state emphasis stays lit for the whole life of the
 * briefing on desktop; (b) selection-driven surfaces (the located-boundary
 * highlight, the emphasis, the sheet's at-hand subject) see EVERY subject
 * change, including search-locate opens that never had a popup, and see the
 * close even on the mobile Brief path that never registers a popup close
 * handler.
 */
let panelSelection: PlaceSelection | null = null;

// ---------------------------------------------------------------------------
// Status pill text
// ---------------------------------------------------------------------------

/**
 * Horizon pill wording follows the canonical six-state vocabulary
 * (CLAUDE.md section 6 invariant 3; the island's STATUS_PILL_TEXT is the
 * layer-side table). A horizon has only four states; each maps to its
 * canonical string, never a per-surface synonym: the pre-U2 "partial"
 * drifted from "live (partial)" and was flagged by the 2026-07-10 design
 * corpus (dataviz lens; fixed with U2 per the BRIEF).
 */
const HORIZON_PILL_TEXT: Record<HorizonStatus, string> = {
  loading: 'loading...',
  ready: 'live',
  partial: 'live (partial)',
  unavailable: 'unavailable'
};

const TIER_HEADING: Record<ResourceTier, string> = {
  'tribe-own': "The Nation's own resources",
  federal: 'Federal regional resources',
  state: 'State regional resources',
  'bia-regional': 'BIA regional resources'
};

const TIER_ORDER: readonly ResourceTier[] = ['tribe-own', 'federal', 'state', 'bia-regional'];

// ---------------------------------------------------------------------------
// Panel construction (once)
// ---------------------------------------------------------------------------

/**
 * Create the panel container and its static chrome (header, close button,
 * empty body) once, append it to the document body, and wire the close button
 * and the Escape-to-close handler. Subsequent opens reuse it.
 */
function ensurePanel(): HTMLElement {
  if (panelEl) return panelEl;

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

  // The compact Tribal Nations action (umbrella build Unit F) rides the
  // panel's static chrome ONLY in embed mode, where the sidebar (and so
  // the Brief head, the non-embed host since the S2/E1 integration under
  // D-0.7.0-041) is collapsed. One instance ever; the id is unique.
  // Eager wiring only; the brief embed's C1 boundary (no island chunk)
  // is untouched. An exited embed keeps this panel-hosted instance (the
  // umbrella's original placement) rather than remounting mid-session.
  const isEmbedBoot = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (isEmbedBoot) {
    panel
      .querySelector('.impact-panel-header')
      ?.insertAdjacentElement('afterend', buildTribalNationsBriefAction());
  }

  panelEl = panel;
  bodyEl = panel.querySelector<HTMLElement>('.impact-panel-body');
  titleEl = panel.querySelector<HTMLElement>('.impact-panel-title');
  kindEl = panel.querySelector<HTMLElement>('.impact-panel-kind');

  const closeBtn = panel.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (closeBtn) closeBtn.addEventListener('click', () => requestPanelDismiss());

  // Escape dismisses the panel when it is open (same routing as the
  // close button: in Brief-on-the-sheet it returns to the answer).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelEl && !panelEl.hidden) {
      requestPanelDismiss();
    }
  });

  // Focus containment (critical-review #16). While the panel is open it behaves
  // as a modal task: Tab cycles within it rather than escaping behind it, so a
  // keyboard user is never dropped onto the map canvas (which has no keyboard
  // path). Focus is restored to the opener on close.
  //
  // U2 (the facade merge): containment is keyed off aria-modal, so the
  // sheet-hosted report (page content inside the one sheet, aria-modal
  // false per the ratified detent model) lets Tab reach the grabber and
  // the rest of the sheet instead of trapping against them.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || panel.hidden) return;
    if (panel.getAttribute('aria-modal') !== 'true') return;
    const focusables = getFocusable(panel);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  });

  return panel;
}

/**
 * The mobile host (U2, the facade merge; ratified detent model,
 * D-0.7.0-017): below 720px the panel element rehosts INTO the sheet's
 * report region, so exactly one bottom sheet ever exists on mobile and
 * the report is page content inside it (aria-modal drops; the
 * close-button focus discipline stays). Everywhere else (desktop, embed,
 * the no-JavaScript fallback) the panel stays a `document.body` overlay,
 * byte for byte the pre-U2 behavior. The briefing model and hydration
 * are untouched: only the host moves. Idempotent; also runs on every
 * sheet settle so a viewport crossing rehosts an open panel both ways.
 */
function syncPanelHost(): void {
  if (!panelEl) return;
  const host = sheetReportHost();
  const closeBtn = panelEl.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (host) {
    const entering = panelEl.parentElement !== host;
    if (entering) host.appendChild(panelEl);
    panelEl.classList.add('sheet-hosted');
    panelEl.setAttribute('aria-modal', 'false');
    // Hosted, the button dismisses the FULL REPORT view (in Brief it
    // returns to the half-detent answer; in console it closes outright).
    closeBtn?.setAttribute('aria-label', 'Close the full report');
    closeBtn?.setAttribute('title', 'Close the full report');
    // An OPEN panel entering the sheet in CONSOLE mode (a viewport
    // crossing mid-briefing) drives to full, as its open would have
    // (adversarial-review finding 2): without this, the crossing parks
    // the open report in a region the console peek never displays. In
    // BRIEF no drive is needed or wanted: a crossing seats the half
    // detent by the opening rule, and the ratified embed-exit reveals
    // at peek with the briefing legitimately resting below.
    if (entering && !panelEl.hidden && getViewMode() === 'console') {
      driveSheetForReport('full');
    }
  } else {
    if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);
    panelEl.classList.remove('sheet-hosted');
    closeBtn?.setAttribute('aria-label', 'Close briefing');
    closeBtn?.setAttribute('title', 'Close briefing');
    if (!panelEl.hidden) panelEl.setAttribute('aria-modal', 'true');
  }
}

let hostSyncArmed = false;

/** Arm the settle-driven rehost once the panel exists. */
function armHostSync(): void {
  if (hostSyncArmed) return;
  hostSyncArmed = true;
  onSheetDetentSettle(() => {
    syncPanelHost();
  });
}

/** Whether the panel is currently hosted inside the sheet's report region. */
function isSheetHosted(): boolean {
  return panelEl?.classList.contains('sheet-hosted') ?? false;
}

/**
 * The user-facing dismiss (the close button, Escape). In Brief mode with
 * the sheet hosting the report, the briefing IS the mode's answer
 * surface: dismissing returns the sheet to the half detent with the
 * briefing still open, so the at-hand block keeps answering and the
 * report door reopens the full view (adversarial-review finding 4: a
 * hard close emptied the half detent to a bare picker, violating the
 * Brief-never-empty contract). Everywhere else (console, desktop,
 * embed) dismiss closes the briefing outright, exactly as before.
 */
function requestPanelDismiss(): void {
  if (isSheetHosted() && isSheetActive() && getViewMode() === 'brief') {
    restoreSheetDetent();
    // Focus follows the surface: the close button just left the visible
    // region, so it lands on the at-hand door (the dismiss's inverse).
    document.getElementById('sheet-report-door')?.focus();
    return;
  }
  closeImpactPanel();
}

/** Visible, keyboard-focusable descendants of the panel, in DOM order. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a single sourced claim. Outlooks are visually distinct from observations. */
function renderClaim(claim: SourcedClaim): string {
  const kindClass = claim.kind === 'outlook' ? 'outlook' : 'observation';
  const kindLabel = claim.kind === 'outlook' ? 'Outlook' : 'Observed';
  const sourceHtml =
    typeof claim.sourceUrl === 'string' && claim.sourceUrl.startsWith('https://')
      ? `<a href="${escapeHtml(claim.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(claim.source)}</a>`
      : escapeHtml(claim.source);
  // chartSvg is trusted, self-generated markup from src/ui/charts.ts (never
  // user-supplied), so it is injected as-is beneath the claim text.
  const chart = claim.chartSvg ? `<div class="impact-claim-chart">${claim.chartSvg}</div>` : '';
  return `
    <div class="impact-claim impact-claim-${kindClass}">
      <span class="impact-claim-badge">${escapeHtml(kindLabel)}</span>
      <p class="impact-claim-text">${escapeHtml(claim.text)}</p>
      ${chart}
      <p class="impact-claim-source">Source: ${sourceHtml}</p>
    </div>
  `;
}

/** Render one horizon section: heading, status pill, claims or honest state. */
function renderHorizon(horizon: Horizon): string {
  let inner: string;
  if (horizon.status === 'loading') {
    inner = `<div class="impact-horizon-loading"><span class="impact-spinner" aria-hidden="true"></span> Reading sources...</div>`;
  } else if (horizon.claims.length > 0) {
    inner = horizon.claims.map(renderClaim).join('');
    if (horizon.note) {
      inner += `<p class="impact-horizon-note">${escapeHtml(horizon.note)}</p>`;
    }
  } else {
    const note =
      horizon.note ??
      'No source answered for this horizon. Open the resources below for current information.';
    inner = `<p class="impact-horizon-note">${escapeHtml(note)}</p>`;
  }

  return `
    <section class="impact-horizon" aria-label="${escapeHtml(horizon.title)}">
      <div class="impact-horizon-head">
        <h3 class="impact-horizon-title">${escapeHtml(horizon.title)} <span class="impact-horizon-sub">${escapeHtml(horizon.subtitle)}</span></h3>
        <span class="impact-horizon-pill impact-horizon-pill-${horizon.status}">${escapeHtml(HORIZON_PILL_TEXT[horizon.status])}</span>
      </div>
      <div class="impact-horizon-claims">${inner}</div>
    </section>
  `;
}

/** Render one resource link, or the empty-by-default Tribe's-own affordance. */
function renderResource(resource: ResourceLink): string {
  const hasLink = typeof resource.url === 'string' && resource.url.startsWith('https://');
  const desc = resource.description
    ? `<p class="impact-resource-desc">${escapeHtml(resource.description)}</p>`
    : '';
  if (resource.tier === 'tribe-own' && !hasLink) {
    // Empty-by-default deployer slot: a "populate" affordance, never a broken link.
    return `
      <div class="impact-resource impact-resource-empty">
        <p class="impact-resource-label">${escapeHtml(resource.label)}</p>
        ${desc}
        <p class="impact-resource-agency">${escapeHtml(resource.agency)}</p>
      </div>
    `;
  }
  const labelHtml = hasLink
    ? `<a class="impact-resource-label impact-resource-link" href="${escapeHtml(resource.url as string)}" target="_blank" rel="noopener">${escapeHtml(resource.label)}</a>`
    : `<p class="impact-resource-label">${escapeHtml(resource.label)}</p>`;
  return `
    <div class="impact-resource">
      ${labelHtml}
      ${desc}
      <p class="impact-resource-agency">${escapeHtml(resource.agency)}</p>
    </div>
  `;
}

/** Render the resources, grouped by tier in stewardship order. */
function renderResources(resources: readonly ResourceLink[]): string {
  const groups = TIER_ORDER.map((tier) => {
    const items = resources.filter((r) => r.tier === tier);
    if (items.length === 0) return '';
    return `
      <div class="impact-resource-group">
        <h4 class="impact-resource-group-title">${escapeHtml(TIER_HEADING[tier])}</h4>
        ${items.map(renderResource).join('')}
      </div>
    `;
  }).join('');

  return `
    <section class="impact-resources" aria-label="Resources">
      <h3 class="impact-section-title">Resources to route</h3>
      <p class="impact-resources-framing">Tribal sovereignty is primary; external resources are supplementary. Each link below is plainly attributed to its agency as regional context, never as governing a Tribal Nation.</p>
      ${groups}
    </section>
  `;
}

/** Render the whole briefing body (everything below the static header). */
function renderBody(briefing: ImpactBriefing): string {
  const caveat = briefing.landCaveat
    ? `<p class="impact-land-caveat">${escapeHtml(briefing.landCaveat)}</p>`
    : '';
  return `
    ${caveat}
    <section class="impact-horizons" aria-label="Drought impact across three horizons">
      <h3 class="impact-section-title">Drought impact</h3>
      ${renderHorizon(briefing.horizons.current)}
      ${renderHorizon(briefing.horizons.nearTerm)}
      ${renderHorizon(briefing.horizons.longRange)}
    </section>
    ${renderResources(briefing.resources)}
  `;
}

/** Write the briefing into the panel chrome. */
function paint(briefing: ImpactBriefing): void {
  ensurePanel();
  if (titleEl) titleEl.textContent = briefing.landTitle;
  if (kindEl) kindEl.textContent = briefing.landKind;
  if (bodyEl) bodyEl.innerHTML = renderBody(briefing);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the briefing panel for a boundary selection. Builds the skeleton
 * (land plus live resources, horizons loading), renders it, and reveals the
 * panel. Phase 3 starts the live hydration here.
 */
export function openImpactPanel(context: BoundarySelectionContext): number {
  // Remember the trigger so focus can return to it on close (#16). Captured
  // before we move focus to the close button below. A reopen keeps the
  // original opener rather than overwriting it with the close button. Two
  // refinements since an open can arrive with no focused opener (today
  // the select= deep link; formerly the U1 answer-first boot, retired by
  // S2 D-0.7.0-041): the document body is never recorded as an opener (a
  // close must not "restore" focus to the body), and a user-initiated open
  // while an openerless panel is showing ADOPTS its real opener, so the
  // keyboard trigger's focus restore works after a deep-link open.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const realOpener = active !== null && active !== document.body ? active : null;
  if (!panelEl || panelEl.hidden) {
    openerEl = realOpener;
  } else if (openerEl === null && realOpener !== null && !panelEl.contains(realOpener)) {
    openerEl = realOpener;
  }

  // Supersede any prior hydration before starting a new selection, and
  // bump the intent sequence: an executed open outranks any async opener
  // still waiting on its boundary fetch.
  briefingIntentSeq++;
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;

  const token = ++openToken;
  const briefing = createBriefingSkeleton(context);
  activeBriefing = briefing;

  // The panel takes ownership of the place selection for this briefing (see
  // the panelSelection doc comment above; the stage-5 majors 3/4 fix). The
  // fresh object deliberately differs from any popup's selection object so
  // the popup-close identity guard stands down.
  panelSelection = { label: context.title, context };
  setPlaceSelection(panelSelection);

  paint(briefing);

  const panel = ensurePanel();
  armHostSync();
  syncPanelHost();
  panel.hidden = false;
  if (isSheetHosted()) {
    // Sheet-hosted (U2): the report is page content inside the one sheet;
    // aria-modal stays false and containment stays off. The detent is
    // mode-keyed: in console every open is an explicit briefing request
    // (the popup trigger button, the keyboard region trigger), so the
    // report drives the sheet to full and close restores the prior
    // detent; in Brief the sheet answers at half (the ratified opening
    // detent) with the at-hand block mirroring this briefing, and only
    // the Read-the-full-report door goes to full. An already-fuller
    // sheet stays put.
    if (getViewMode() === 'console') {
      driveSheetForReport('full');
    } else if (
      getSheetDetent() === 'peek' ||
      (getSheetDetent() === 'closed' && sheetAllowsAutoRaise())
    ) {
      // From the map-first closed state (mobile shell) a USER-initiated
      // Brief briefing open (a boundary tap, a search select, a deep
      // link) raises the at-hand answer, the mockup's map-tap popup
      // equivalent. Since S2 (D-0.7.0-041) those explicit paths are the
      // only briefing openers, so the gate is now belt-and-braces: the
      // boot stays map-first because nothing opens unsolicited.
      setSheetDetent('half');
    }
  } else {
    // While open the overlay panel contains keyboard focus (#16), so it
    // is modal to assistive tech; the flag is cleared on close.
    panel.setAttribute('aria-modal', 'true');
  }
  // Force a frame so the slide-in transition runs from the hidden transform.
  void panel.offsetWidth;
  panel.classList.add('open');

  // Focus moves to the close button only when the report surface itself
  // is visible (the overlay panel, or the sheet at full); at the half
  // detent the at-hand block is the visible surface and focus must not
  // jump into a display:none region.
  const closeBtn = panel.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (closeBtn && (!isSheetHosted() || getSheetDetent() === 'full')) closeBtn.focus();
  if (bodyEl) bodyEl.scrollTop = 0;

  // Mirror the briefing into the sheet's at-hand block (the half
  // detent's Brief content; an invisible no-op everywhere else).
  setSheetBriefing(briefing);

  // Fill the horizons from live sources, re-rendering as each settles. The
  // master signal cancels in-flight fetches on close or reopen.
  void hydrateBriefing(briefing, signal, () => refreshOpenBriefing(token)).catch(
    (err: unknown) => {
      if (!signal.aborted) console.warn('[impact-panel] hydration failed:', err);
    }
  );

  // In parallel, resolve the selection's location identity and swap in the
  // state-tier resources from the verified catalog (F3; D-0.6.0-009). Same
  // supersede signal and token as the horizon hydration.
  void rehydrateResourcesFromCatalog(briefing, context, signal, token);

  return token;
}

/**
 * Resolve the selection's location identity and swap in the catalog-supplied
 * resources (F3; D-0.6.0-009 + D-0.6.0-012). Runs async in parallel with the
 * horizon hydration: the panel opens immediately with the base resources
 * (Tribe's-own, the in-code federal info anchors, BIA regional), then this
 * adds the STATE tier for the resolved state and the FEDERAL program set
 * (federal.json) when the catalog answers.
 *
 * The federal set is national and deliberately independent of identity
 * resolution: a missing map or an unresolved state still gets the federal
 * programs. Honest degradation everywhere else: no resolved state or no state
 * file means the state tier is simply absent (the state-aware drought.gov
 * anchor still carries state conditions, so no link is fabricated).
 */
async function rehydrateResourcesFromCatalog(
  briefing: ImpactBriefing,
  context: BoundarySelectionContext,
  signal: AbortSignal,
  token: number
): Promise<void> {
  // The catalog loads are shared/cached and deliberately not tied to this
  // caller's signal (see the cancellation note in resource-catalog.ts); the
  // aborted checks below drop a superseded RESULT instead.
  const federalPromise = loadFederalResources();
  let stateRows: ResourceLink[] = [];
  const map = getMap();
  if (map) {
    try {
      const identity = await resolveLocationIdentity(map, context.lngLat, signal);
      if (!signal.aborted) stateRows = await resourcesForIdentity(identity);
    } catch (err) {
      if (!signal.aborted) console.warn('[impact-panel] state-resource rehydrate failed:', err);
    }
  }
  const federalRows = await federalPromise;
  if (signal.aborted || (stateRows.length === 0 && federalRows.length === 0)) return;
  // The panel groups resources by tier, so array order within the list only
  // matters within a tier: drop any existing state rows, append the state
  // tier, then append the federal program set AFTER the in-code federal info
  // anchors (which stay first in their group).
  briefing.resources = [
    ...briefing.resources.filter((r) => r.tier !== 'state'),
    ...stateRows,
    ...federalRows
  ];
  refreshOpenBriefing(token);
}

/** Whether `token` is still the active open (not superseded or closed). */
export function isCurrentBriefing(token: number): boolean {
  return token === openToken && activeBriefing !== null && panelEl !== null && !panelEl.hidden;
}

/**
 * Briefing INTENT sequence (U1; hardened after the U1 adversarial
 * review). Every declaration of "I want a briefing" takes a number:
 * async openers (the place picker, the region trigger, the select=
 * deep link) declare intent at user-action time
 * and check, at their fetch's resolve, that no NEWER intent or panel
 * interaction has happened since; executed opens and closes bump the
 * sequence too, so they supersede anything declared before them. This
 * makes the LAST intent win regardless of fetch resolve order (the
 * interaction-count guard it replaces let whichever fetch resolved
 * first win a two-pick race).
 */
let briefingIntentSeq = 0;

/** Declare a briefing intent; returns its sequence number. */
export function nextBriefingIntent(): number {
  return ++briefingIntentSeq;
}

/** Whether `intent` is still the newest declaration. */
export function isCurrentBriefingIntent(intent: number): boolean {
  return intent === briefingIntentSeq;
}

/** The briefing currently on screen, for in-place hydration (Phase 3). */
export function getActiveBriefing(): ImpactBriefing | null {
  return activeBriefing;
}

/**
 * Re-render the active briefing in place after its horizons or resources were
 * mutated (async hydration and the F3 resource rehydrate both call this).
 *
 * Focus-safe: the re-render replaces every focusable element in the body, so if
 * a keyboard user had focus there (a resource link, a source link) it would be
 * destroyed and focus would fall to the document body, escaping the dialog
 * (WCAG 2.1.2). When that happens while the panel is open, pull focus back to
 * the close button so the user stays trapped in the dialog rather than landing
 * on the keyboard-inaccessible map canvas. The header (and its close button) is
 * never re-rendered, so focus there is unaffected.
 */
export function refreshOpenBriefing(token: number): void {
  if (!isCurrentBriefing(token) || !activeBriefing || !bodyEl) return;
  const hadFocusInBody = bodyEl.contains(document.activeElement);
  bodyEl.innerHTML = renderBody(activeBriefing);
  if (hadFocusInBody && panelEl && !panelEl.contains(document.activeElement)) {
    panelEl.querySelector<HTMLButtonElement>('.impact-panel-close')?.focus();
  }
  // Hydration just landed new horizon content; the sheet's at-hand block
  // mirrors the same model (its headline is the current-horizon read).
  setSheetBriefing(activeBriefing);
}

/** Close the panel and supersede any in-flight hydration. */
export function closeImpactPanel(): void {
  // A deliberate close outranks any async opener still in flight: the
  // user said "no panel", so a late-resolving boundary fetch must yield.
  briefingIntentSeq++;
  openToken++;
  activeBriefing = null;
  setSheetBriefing(null);
  // Panel-owned selection clear (the stage-5 majors 3/4 fix): closing the
  // briefing ends the selection, which drops the feature-state emphasis and
  // the located-boundary highlight through their store seams; this also
  // covers the mobile Brief path, which never registers a popup close
  // handler. A NEWER selection (a popup opened after this briefing) is not
  // clobbered: the identity guard stands down in that case.
  if (panelSelection !== null && getPlaceSelection() === panelSelection) {
    setPlaceSelection(null);
  }
  panelSelection = null;
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  if (!panelEl) return;
  // Sheet-hosted close restores the pre-report detent (ratified).
  if (isSheetHosted() && isSheetActive() && !panelEl.hidden) {
    restoreSheetDetent();
  }
  panelEl.classList.remove('open');
  panelEl.setAttribute('aria-modal', 'false');
  // Restore focus to the opener immediately (not after the slide-out) so a
  // keyboard user lands back where they were instead of on the body (#16).
  const toRestore = openerEl;
  openerEl = null;
  if (toRestore && document.contains(toRestore)) {
    toRestore.focus();
  }
  // Hide after the transition so the slide-out is visible; a reduced-motion
  // user has no transition, so hide immediately on the next tick.
  window.setTimeout(() => {
    if (panelEl && !panelEl.classList.contains('open')) panelEl.hidden = true;
  }, 260);
}

// The former `attachImpactTrigger(popup, context)` facade was retired by
// the InteractionCoordinator unit (D-0.7.0-058 ruling 5): the coordinator
// (src/map/interaction-coordinator.ts) now owns the one click response,
// so it sets the place selection, routes the active mobile Brief sheet,
// wires the `[data-ddm-impact-trigger]` button, and clears the selection
// on response close (only if still current). The facade-freeze record of
// the removal is docs/facade-freeze.md with the ADR 0001 note.
