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

import type maplibregl from 'maplibre-gl';

import { createBriefingSkeleton } from '../impact/briefing';
import { hydrateBriefing } from '../impact/hydrate';
import { resourcesForIdentity } from '../impact/resource-catalog';
import { resolveLocationIdentity } from '../state/location-identity';
import { getMap } from '../state/map-store';
import { getPlaceSelection, setPlaceSelection } from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
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

// ---------------------------------------------------------------------------
// Status pill text
// ---------------------------------------------------------------------------

const HORIZON_PILL_TEXT: Record<HorizonStatus, string> = {
  loading: 'loading...',
  ready: 'live',
  partial: 'partial',
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

  panelEl = panel;
  bodyEl = panel.querySelector<HTMLElement>('.impact-panel-body');
  titleEl = panel.querySelector<HTMLElement>('.impact-panel-title');
  kindEl = panel.querySelector<HTMLElement>('.impact-panel-kind');

  const closeBtn = panel.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeImpactPanel());

  // Escape closes the panel when it is open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelEl && !panelEl.hidden) {
      closeImpactPanel();
    }
  });

  // Focus containment (critical-review #16). While the panel is open it behaves
  // as a modal task: Tab cycles within it rather than escaping behind it, so a
  // keyboard user is never dropped onto the map canvas (which has no keyboard
  // path). Focus is restored to the opener on close.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || panel.hidden) return;
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
  // original opener rather than overwriting it with the close button.
  if (!panelEl || panelEl.hidden) {
    openerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  // Supersede any prior hydration before starting a new selection.
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;

  const token = ++openToken;
  const briefing = createBriefingSkeleton(context);
  activeBriefing = briefing;

  paint(briefing);

  const panel = ensurePanel();
  panel.hidden = false;
  // While open the panel contains keyboard focus (#16), so it is modal to
  // assistive tech; the flag is cleared on close.
  panel.setAttribute('aria-modal', 'true');
  // Force a frame so the slide-in transition runs from the hidden transform.
  void panel.offsetWidth;
  panel.classList.add('open');

  const closeBtn = panel.querySelector<HTMLButtonElement>('.impact-panel-close');
  if (closeBtn) closeBtn.focus();
  if (bodyEl) bodyEl.scrollTop = 0;

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
 * Resolve the selection's location identity and swap in the state-tier
 * resources from the verified catalog (F3; D-0.6.0-009). Runs async in parallel
 * with the horizon hydration: the panel opens immediately with the base
 * resources (Tribe's-own, federal, BIA regional), then this adds the state tier
 * when the catalog answers.
 *
 * Honest degradation: if the map is not yet published, the identity does not
 * resolve, or no catalog file exists for the state, the state tier is simply
 * absent (the federal drought.gov state page in the federal tier still carries
 * state conditions, so no link is fabricated).
 */
async function rehydrateResourcesFromCatalog(
  briefing: ImpactBriefing,
  context: BoundarySelectionContext,
  signal: AbortSignal,
  token: number
): Promise<void> {
  const map = getMap();
  if (!map) return;
  let stateRows: ResourceLink[];
  try {
    const identity = await resolveLocationIdentity(map, context.lngLat, signal);
    if (signal.aborted) return;
    stateRows = await resourcesForIdentity(identity, signal);
  } catch (err) {
    if (!signal.aborted) console.warn('[impact-panel] resource rehydrate failed:', err);
    return;
  }
  if (signal.aborted || stateRows.length === 0) return;
  // The panel groups resources by tier, so array order does not matter: drop any
  // existing state rows and append the catalog's. Other tiers are untouched.
  briefing.resources = [
    ...briefing.resources.filter((r) => r.tier !== 'state'),
    ...stateRows
  ];
  refreshOpenBriefing(token);
}

/** Whether `token` is still the active open (not superseded or closed). */
export function isCurrentBriefing(token: number): boolean {
  return token === openToken && activeBriefing !== null && panelEl !== null && !panelEl.hidden;
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
}

/** Close the panel and supersede any in-flight hydration. */
export function closeImpactPanel(): void {
  openToken++;
  activeBriefing = null;
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  if (!panelEl) return;
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

/**
 * Wire a boundary popup's "Drought impact briefing" button to open the panel.
 * Call after `popup.addTo(map)`. The button markup (carrying the
 * `data-ddm-impact-trigger` attribute) is emitted by the popup factories in
 * `src/ui/popups.ts`. Clicking it opens the panel and closes the popup so the
 * panel is the focus.
 */
export function attachImpactTrigger(
  popup: maplibregl.Popup,
  context: BoundarySelectionContext
): void {
  // A selected boundary becomes the current "place" so the sidebar front-door
  // trigger can offer "See what this means" for it (F3; appendix D). Cleared on
  // popup close so no stale place lingers, BUT only if this popup's selection is
  // still current: a rapid click on another boundary sets a new place and closes
  // this popup, and the two events can arrive in either order, so the close must
  // not clobber a newer selection.
  const selection: PlaceSelection = { label: context.title, context };
  setPlaceSelection(selection);
  popup.on('close', () => {
    if (getPlaceSelection() === selection) setPlaceSelection(null);
  });

  const wire = (): void => {
    const el = popup.getElement();
    if (!el) return;
    const btn = el.querySelector<HTMLButtonElement>('[data-ddm-impact-trigger]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      openImpactPanel(context);
      popup.remove();
    });
  };
  // The popup element exists once it is on the map; if not yet, wire on open.
  if (popup.getElement()) {
    wire();
  } else {
    popup.once('open', wire);
  }
}
