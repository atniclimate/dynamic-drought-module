/**
 * Lazy drought-impact briefing panel runtime.
 *
 * The headline kernel-integration feature. A click on a boundary (ecoregion,
 * Tribal Lands feature, Treaty area, or Bureau of Indian Affairs reservation)
 * opens a lightweight identity popup with an "Impact briefing" button;
 * the button opens this slide-in panel, which composes the land identity, the
 * impact matrix (three horizon sections of four hazard rows each, DR-012 b),
 * and the public resources routed in stewardship order.
 *
 * This module is the rendering half (claims to DOM). The analysis half (data
 * to claims) lives in `src/impact/`. The panel never invents a value: it
 * renders only what the briefing model carries, and an unfilled cell reads as
 * "loading" or as a named unavailable state that says which product is
 * missing, rather than as a fabricated reading or a blank.
 *
 * Embed-safe: the panel is appended to `document.body` and positioned over the
 * map, so it does not depend on the sidebar and works under `?embed=true`.
 * Mobile: below 720 pixels it stacks as a bottom sheet (see app.css). All
 * dynamic strings pass through `escapeHtml`; only `https://` links render as
 * anchors. Respects `prefers-reduced-motion` via the stylesheet.
 *
 * Phase 2 renders the skeleton (land plus live resources, cells in their
 * loading state). Phase 3 calls `hydrateBriefing` to fill the cells from
 * verified sources, then `refreshOpenBriefing` to re-render in place.
 */

import { createBriefingSkeleton } from '../impact/briefing';
import { SHELL_HAZARD_KEY, SHELL_HORIZON_KEY } from '../impact/horizon-chrome';
import { hydrateBriefing } from '../impact/hydrate';
import { HAZARD_KEYS, HAZARD_LABELS, MATRIX_LANE_KEYS } from '../impact/matrix';
import { sourceMayRun, uncoveredSourceGroups } from '../impact/source-policy';
import {
  formatDistanceKm,
  formatPointHeatInterval,
  formatPointHeatTimestamp,
  formatPointHeatValue
} from '../impact/point-heat-format';
import {
  landscapeContextShown,
  landscapeUncoveredGroup,
  resolveLandscapeSelection
} from '../impact/landscape-resolution';
import type { LandscapeEcoregionKey } from '../impact/landscape-resolution';
import { getLayerDef } from '../config/layers';
import {
  PRIORITY_RULE_ANCHOR,
  renderFocusHead,
  renderLeadView,
  renderPriorityRule,
  renderViewSwitch
} from './briefing-lead';
import type { BriefingView } from './briefing-lead';
import { renderClaim } from './claim-render';
import { READ_STATE_WORD } from './gauges';
import { renderLandscapeContext } from './landscape-context';
import { renderMapTechnicalInformation } from './map-technical-information';
import { renderAcknowledgements } from './acknowledgements';
import { getLegendSection } from './legend-registry';
import { legendPanelUsable } from './map-key';
import { requestLayerOn } from './layer-toggle-command';
import { loadFederalResources, resourcesForIdentity } from '../impact/resource-catalog';
import { orderFederalByCondition, resourceAgencyLine, resourcesCheckedLine } from '../impact/resources';
import type { CatalogResource } from '../impact/resources';
import {
  getCommittedSnapshot,
  onCommittedSnapshotChange
} from '../state/cluster-service';
import { resolveLocationIdentity } from '../state/location-identity';
import { getMap } from '../state/map-store';
import { getPlaceSelection, setPlaceSelection } from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { setSheetBriefing } from './mobile-sheet';
import type {
  BoundarySelectionContext,
  HazardCell,
  HazardKey,
  HeatSynthesis,
  Horizon,
  ImpactBriefing,
  PointHeatBriefing,
  PointHeatMetricSeries,
  ResourceLink,
  ResourceTier
} from '../impact/types';
import type { LayerStatus } from '../types/layer';
import { checkPopupHref, escapeHtml } from '../util/escape';
import {
  closeImpactPanelShell,
  ensureImpactPanelShell,
  isImpactPanelShellOpen,
  NO_PLACE_HEADS,
  openImpactPanelShell,
  refreshBriefingActions,
  setMailActionEnabled
} from './impact-panel';
import type { NoPlaceSection } from './impact-panel';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let kindEl: HTMLElement | null = null;
let onClose: (() => void) | null = null;

/** The briefing currently shown, so Phase 3 hydration can re-render in place. */
let activeBriefing: ImpactBriefing | null = null;

/**
 * Supersede token. Incremented on every open and on close so an async
 * hydration started for one selection cannot render into a panel that has
 * since been closed or reopened for a different boundary.
 */
let openToken = 0;

/**
 * DDM-P13-T02 F3: legend-poll generation. Captured by `waitForLegendSection`
 * when a Legend click starts its poll; every Legend click and every panel
 * close bumps it, so any older poll stops at its next tick instead of
 * calling `focusLegendSection` (and stealing focus) after the user has
 * gone elsewhere.
 */
let legendPollGeneration = 0;

/**
 * Master abort controller for the active briefing's live hydration. Aborted on
 * close and on reopen so superseded fetches are cancelled and cannot render
 * into a torn-down panel (the cancellation invariant).
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

/**
 * Which presentation of the briefing is showing (owner direction 2026-11-09
 * (sprint), DR-pending): the priority view (src/ui/briefing-lead.ts) or the
 * full detail, the matrix. Null means the priority view: every open starts
 * there in every shell (owner direction 2026-11-13), and a reader's choice
 * holds only for the briefing it was made in (across hydration re-renders),
 * never across a close and a new open. Pure presentation state: it never
 * enters the URL, and the matrix is always in the document under either view.
 */
let briefingView: BriefingView | null = null;

/**
 * The one hazard whose cells the full detail is narrowed to, after a tile was
 * opened; null for all four. The cells themselves are the matrix's own nodes:
 * narrowing hides the other hazards' cells and never moves one.
 */
let focusHazard: HazardKey | null = null;

/** The control that opened the single-hazard detail, to return focus to. */
let focusOpenerKey: string | null = null;

/** The panel's polite live region for view changes; created once. */
let viewLiveEl: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Status pill text
// ---------------------------------------------------------------------------

/**
 * Horizon pill wording follows the canonical six-state vocabulary
 * (a project invariant; the island's STATUS_PILL_TEXT is the
 * layer-side table). A horizon has only four states; each maps to its
 * canonical string, never a per-surface synonym: the pre-U2 "partial"
 * drifted from "live (partial)" and was flagged by the 2026-07-10 design
 * corpus (dataviz lens; fixed with U2 per the BRIEF). The four words live in
 * one table, `READ_STATE_WORD` (src/ui/gauges.ts), which the priority view and
 * the evidence chain read too, so a cell reads the same word in every view.
 */
const HORIZON_PILL_TEXT = { ...READ_STATE_WORD, loading: 'loading' };

const SOURCE_PILL_TEXT: Record<LayerStatus, string> = {
  loading: 'loading',
  ready: 'live',
  degraded: 'live (partial)',
  error: 'unavailable',
  'no-data': 'no data',
  'zoom-in': 'zoom in to load'
};

const TIER_HEADING: Record<ResourceTier, string> = {
  'tribe-own': "The Nation's own resources",
  federal: 'Federal regional resources',
  state: 'State regional resources',
  'bia-regional': 'BIA regional resources'
};

const TIER_ORDER: readonly ResourceTier[] = ['tribe-own', 'federal', 'state', 'bia-regional'];

// ---------------------------------------------------------------------------
// Print (owner-1o, D1 M21)
// ---------------------------------------------------------------------------

/** Details the last `openAllDisclosuresForPrint` call opened, restored (and
 * only these) on `afterprint`. Reassigned on every call (`handleBeforePrint`
 * and, mid-print, `refreshOpenBriefing`'s post-render step) because a
 * hydration refresh replaces every `details` node in the body, detaching
 * whatever this held before. */
let openedForPrint: HTMLDetailsElement[] = [];

/** True between `beforeprint` and `afterprint`. Read by `refreshOpenBriefing`
 * so a refresh landing mid-print re-opens every disclosure for the printed
 * page instead of leaving a freshly rendered one in its default state. */
let printing = false;

/**
 * `preservedDisclosureKey` values that were CLOSED when print began (or at
 * the start of a later mid-print refresh): `openAllDisclosuresForPrint`
 * force-opens them for the page, but that open is print's, not the
 * reader's. Read by `refreshOpenBriefing`'s post-render step so a
 * same-key node reborn by a mid-print refresh is restored to the reader's
 * true CLOSED state rather than the live, print-forced `.open` its capture
 * (outside this step) saw. Reset at `beforeprint`, cleared at `afterprint`;
 * stable across any number of refreshes within one print pass because nothing
 * can toggle a disclosure by hand while the page is printing.
 */
let printForcedPreservedKeys = new Set<string>();

/**
 * Force every currently closed disclosure under the briefing body open for
 * print, recording which nodes (`openedForPrint`, closed back by
 * `handleAfterPrint`) and which PRESERVED keys (`printForcedPreservedKeys`)
 * were closed. Called once from `handleBeforePrint`, and again, only while
 * `printing`, from `refreshOpenBriefing`'s post-render step whenever a
 * hydration refresh replaces the body mid-print: the previous call's
 * element references are now detached, so each call re-derives the CURRENT
 * closed set from the live DOM rather than reusing stale ones.
 */
function openAllDisclosuresForPrint(): void {
  if (!bodyEl) return;
  const closed = Array.from(
    bodyEl.querySelectorAll<HTMLDetailsElement>('details:not([open])')
  );
  closed.forEach((details) => {
    details.open = true;
    if (details.matches(PRESERVED_DISCLOSURE_SELECTOR)) {
      printForcedPreservedKeys.add(preservedDisclosureKey(details));
    }
  });
  openedForPrint = closed;
}

/**
 * Every closed briefing disclosure prints open, whichever door started the
 * print: the panel's own Print control calls `window.print()` once
 * (impact-panel.ts), and the browser's own Print reaches this same
 * `beforeprint` event, so one listener covers both.
 */
function handleBeforePrint(): void {
  if (!bodyEl) return;
  printing = true;
  printForcedPreservedKeys = new Set();
  openAllDisclosuresForPrint();
}

/** Restore exactly the disclosures the last `openAllDisclosuresForPrint`
 * call opened; a reader's own open disclosure was never in that list, so it
 * is left alone. Covers a body reborn mid-print because that call always
 * re-derives `openedForPrint` from the live DOM (see its own comment). */
function handleAfterPrint(): void {
  printing = false;
  openedForPrint.forEach((details) => {
    details.open = false;
  });
  openedForPrint = [];
  printForcedPreservedKeys = new Set();
}

// ---------------------------------------------------------------------------
// Panel construction (once)
// ---------------------------------------------------------------------------

/** Bind the renderer to the facade-owned panel shell. */
function ensurePanel(): HTMLElement {
  if (panelEl) return panelEl;
  const shared = ensureImpactPanelShell();
  panelEl = shared.panel;
  bodyEl = shared.body;
  titleEl = shared.title;
  kindEl = shared.kind;
  // ONE delegated click listener on the panel root, bound once (the shell
  // itself is never re-created; `renderBody` only replaces `bodyEl`'s
  // innerHTML, so a listener on the child would be lost on every
  // hydration re-render, DDM-P13-T02 correction, clause 3).
  panelEl.addEventListener('click', handleLegendLinkClick);
  // The priority view's controls (the switch, the tiles, the doors) are
  // delegated the same way and for the same reason.
  panelEl.addEventListener('click', handleBriefingViewClick);
  viewLiveEl = document.createElement('div');
  viewLiveEl.className = 'sr-only';
  viewLiveEl.setAttribute('aria-live', 'polite');
  panelEl.appendChild(viewLiveEl);
  // DDM-P2-T07: keep the matrix's active-row emphasis in step with the
  // shell's committed hazard mode on a LIVE switch, not only on the next
  // open. Registered once, alongside every other one-time wire-up in this
  // block (the module is a page-lifetime singleton once loaded, same as
  // view-shell's own subscription to this service).
  // The Priority view follows the mode and the map's horizon (DESIGN B3, B4):
  // re-render only when either one actually changed.
  let leadShell = '';
  onCommittedSnapshotChange(() => {
    applyActiveHazardEmphasis();
    const { selectedHazard, horizon } = getCommittedSnapshot();
    if (`${selectedHazard}:${horizon}` === leadShell) return;
    leadShell = `${selectedHazard}:${horizon}`;
    refreshOpenBriefing(openToken);
  });
  // Print listeners (owner-1o): registered once, here, so they exist by the
  // time any disclosure this module renders could need opening for print.
  window.addEventListener('beforeprint', handleBeforePrint);
  window.addEventListener('afterprint', handleAfterPrint);
  return shared.panel;
}

/**
 * Mark the active hazard's cell in every horizon section (DR-092): a
 * styling hook plus `aria-current` on each matching `.impact-hazard`
 * section, plus (M20, DR-123) revealing that row's own `.impact-hazard-you`
 * marker, a small "your mode" word rendered hidden in every cell's markup
 * (`renderCell`) and shown only on the active one. The marker sits outside
 * `.impact-hazard-title` (the element the section's `aria-labelledby`
 * names), so neither the title's nor the section's accessible name gains
 * the word: a screen reader hears "your mode" once, as ordinary row text,
 * never as part of the heading or region name, and never doubled against
 * `aria-current`. `selectedHazard` (not `cluster`) is
 * the field every other hazard-named briefing surface already reads
 * (view-shell.ts's `selectedHazardTitle`): the user-facing hazard intent,
 * which stays a real cluster key even once the exact layer set has
 * drifted to 'custom'. This never reorders and never resizes a row: only
 * a class and an attribute change on elements already in the DOM.
 *
 * There is no contiguous "hazard row" anywhere in the DOM: `renderBody`
 * stacks three `<section class="impact-horizon">` blocks, and each one
 * builds its own four `.impact-hazard` cells from `HAZARD_KEYS.map(...)`
 * (`renderHorizon`). So the active hazard is matched by `data-hazard`
 * alone, once inside each of the three horizon sections, not narrowed to
 * `current`: an emphasis that vanished after Current Conditions would
 * teach a scrolling reader that the cue is unreliable rather than telling
 * them which row is theirs. `aria-current="true"` on all three is
 * correct rather than redundant, because each horizon section is its own
 * set of four hazard cells (DR-012 b) and `aria-current` marks the
 * current item within A set; three sets, three marks.
 */
function applyActiveHazardEmphasis(): void {
  if (!bodyEl) return;
  const activeHazard = SHELL_HAZARD_KEY[getCommittedSnapshot().selectedHazard];
  bodyEl.querySelectorAll<HTMLElement>('.impact-hazard').forEach((row) => {
    const isActive = row.dataset['hazard'] === activeHazard;
    row.classList.toggle('impact-hazard-active', isActive);
    if (isActive) {
      row.setAttribute('aria-current', 'true');
    } else {
      row.removeAttribute('aria-current');
    }
    // M20 (DR-123): the "your mode" word rides the same class/attribute
    // toggle, never a re-render; `hidden` keeps it out of layout and out
    // of every accessible-name computation on every other row.
    const youMarker = row.querySelector<HTMLElement>('.impact-hazard-you');
    if (youMarker) youMarker.hidden = !isActive;
  });
}

// ---------------------------------------------------------------------------
// The priority view and the full detail (owner direction 2026-11-09 (sprint),
// DR-pending)
// ---------------------------------------------------------------------------

/** The two headings that can hold focus without being controls. */
const LEAD_FOCUS_IDS: readonly string[] = ['briefing-focus-title', 'briefing-lead-title'];

/** The reader's choice for this briefing, or the priority view. */
function currentBriefingView(): BriefingView {
  return briefingView ?? 'lead';
}

/**
 * Show the current view on the nodes the last render produced. Only
 * `hidden`, `aria-pressed` and one heading's text change: no node is created,
 * moved or reordered, so the matrix under the priority view is the same
 * matrix, in the same order, as under the full detail. A body with no switch
 * (no matrix source covers the place, or a no-place presentation) is left as it
 * was rendered.
 */
function applyBriefingView(): void {
  if (!bodyEl) return;
  const switchEl = bodyEl.querySelector<HTMLElement>(':scope > .briefing-view-switch');
  const lead = bodyEl.querySelector<HTMLElement>(':scope > .briefing-lead');
  if (!switchEl || !lead) {
    delete bodyEl.dataset['briefingView'];
    return;
  }
  const view = currentBriefingView();
  const focus = view === 'matrix' ? focusHazard : null;
  bodyEl.dataset['briefingView'] = focus !== null ? 'hazard' : view;
  lead.hidden = view !== 'lead';
  switchEl.hidden = focus !== null;
  switchEl.querySelectorAll<HTMLElement>('[data-briefing-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset['briefingView'] === view));
  });
  const landscape = bodyEl.querySelector<HTMLElement>(':scope > .impact-landscape');
  if (landscape) landscape.hidden = view === 'lead' || focus !== null;
  const horizons = bodyEl.querySelector<HTMLElement>(':scope > .impact-horizons');
  if (horizons) horizons.hidden = view === 'lead';
  bodyEl.querySelectorAll<HTMLElement>('.impact-horizons .impact-hazard').forEach((cell) => {
    cell.hidden = focus !== null && cell.dataset['hazard'] !== focus;
  });
  // Point heat sits in the heat row of Current Conditions, so it shows with
  // the heat cells and with all four.
  const pointHeat = bodyEl.querySelector<HTMLElement>('.impact-horizons .point-heat');
  if (pointHeat) pointHeat.hidden = focus !== null && focus !== 'heat';
  const head = bodyEl.querySelector<HTMLElement>(':scope > .briefing-focus');
  if (head) {
    head.hidden = focus === null;
    const title = head.querySelector<HTMLElement>('.briefing-focus-title');
    if (title) title.textContent = focus !== null ? `${HAZARD_LABELS[focus]} detail` : '';
  }
}

/** Say a view change once, politely; the words are the view's own name. */
function announceBriefingView(words: string): void {
  if (viewLiveEl) viewLiveEl.textContent = words;
}

/** Move focus to a node of the current view and bring it into the scroller. */
function focusInView(target: HTMLElement | null, block: ScrollLogicalPosition): void {
  if (!target) return;
  target.scrollIntoView({ block });
  target.focus({ preventScroll: true });
}

/** Narrow the full detail to one hazard's own cells, from a tile or a row. */
function openHazardDetail(hazard: HazardKey, openerKey: string | null): void {
  if (!bodyEl) return;
  briefingView = 'matrix';
  focusHazard = hazard;
  focusOpenerKey = openerKey;
  applyBriefingView();
  announceBriefingView(`${HAZARD_LABELS[hazard]} detail.`);
  // The head comes into view whole (the way back sits above the title);
  // focus lands on the title, so a screen reader hears what opened.
  bodyEl.querySelector<HTMLElement>(':scope > .briefing-focus')?.scrollIntoView({ block: 'start' });
  bodyEl.querySelector<HTMLElement>('.briefing-focus-title')?.focus({ preventScroll: true });
}

/** Open one of the body's own disclosures and land on a node inside it. */
function openBriefingDisclosure(selector: string, landOn: string): void {
  const details = bodyEl?.querySelector<HTMLDetailsElement>(selector);
  if (!details) return;
  details.open = true;
  focusInView(details.querySelector<HTMLElement>(landOn) ?? details.querySelector('summary'), 'start');
}

/**
 * The one delegated listener for the switch, the tiles, the rows, the chain
 * links and the doors. Every control it serves is a real button carrying its
 * intent as data, so the keyboard path is the browser's own.
 */
function handleBriefingViewClick(event: MouseEvent): void {
  if (!bodyEl || !(event.target instanceof Element)) return;
  const control = event.target.closest<HTMLElement>(
    '[data-briefing-view], [data-lead-action], [data-chain-action]'
  );
  if (!control || !bodyEl.contains(control)) return;
  const key = control.dataset['leadKey'] ?? null;

  const chosen = control.dataset['briefingView'];
  if (chosen === 'lead' || chosen === 'matrix') {
    briefingView = chosen;
    focusHazard = null;
    applyBriefingView();
    announceBriefingView(chosen === 'lead' ? 'Priority view.' : 'Full detail: every hazard at three horizons.');
    return;
  }

  const chain = control.dataset['chainAction'];
  if (chain !== undefined) {
    const hazard = chain.startsWith('detail:') ? chain.slice('detail:'.length) : '';
    if ((HAZARD_KEYS as readonly string[]).includes(hazard)) {
      openHazardDetail(hazard as HazardKey, null);
    }
    return;
  }

  switch (control.dataset['leadAction']) {
    case 'detail': {
      const hazard = control.dataset['leadHazard'] ?? '';
      if ((HAZARD_KEYS as readonly string[]).includes(hazard)) {
        openHazardDetail(hazard as HazardKey, key);
      }
      return;
    }
    case 'lead': {
      const opener = focusOpenerKey;
      briefingView = 'lead';
      focusHazard = null;
      focusOpenerKey = null;
      applyBriefingView();
      announceBriefingView('Priority view.');
      // Back to where the reader was: the tile that opened the detail.
      const tile = opener !== null ? bodyEl.querySelector<HTMLElement>(`[data-lead-key="${opener}"]`) : null;
      if (tile) focusInView(tile, 'nearest');
      else focusInView(bodyEl.querySelector<HTMLElement>('#briefing-lead-title'), 'start');
      return;
    }
    case 'matrix':
      briefingView = 'matrix';
      focusHazard = null;
      applyBriefingView();
      announceBriefingView('Full detail: every hazard at three horizons.');
      focusInView(bodyEl.querySelector<HTMLElement>('[data-briefing-view="matrix"]'), 'start');
      return;
    case 'rule':
      openBriefingDisclosure('.impact-technical-information', `#${PRIORITY_RULE_ANCHOR}`);
      return;
    case 'technical':
      openBriefingDisclosure('.impact-technical-information', 'summary');
      return;
    case 'acknowledgements':
      openBriefingDisclosure('.impact-acknowledgements', 'summary');
      return;
    default:
  }
}

// ---------------------------------------------------------------------------
// Legend reachability (DDM-P13-T02 correction, clause 3)
// ---------------------------------------------------------------------------

/**
 * Move focus and scroll to an already-built legend section. `tabindex="-1"`
 * is added only if the section does not already carry a focus target, so a
 * screen-reader user lands somewhere sensible without the section becoming
 * a permanent tab stop.
 */
function focusLegendSection(section: HTMLElement): void {
  section.scrollIntoView({ block: 'nearest' });
  if (!section.hasAttribute('tabindex')) {
    section.setAttribute('tabindex', '-1');
  }
  section.focus();
}

/**
 * Poll for a legend section that a just-requested layer activation is
 * building. The registry (`src/state/registry.ts`) has no per-key "legend
 * built" event; `getLegendSection` reading the live DOM is the honest
 * signal. Gives up silently after 10 seconds (an unavailable or failed
 * layer already tells its own story through the sidebar pill).
 *
 * DDM-P13-T02 F3: captures `legendPollGeneration` at the moment the poll
 * starts and checks it on every tick. A later Legend click or a panel close
 * bumps the counter, and a poll whose generation has moved on stops without
 * calling `onFound`, so it can never call `section.focus()` (through
 * `focusLegendSection`) and steal focus from wherever the user has since
 * gone.
 */
function waitForLegendSection(
  key: string,
  onFound: (section: HTMLElement) => void,
  find: () => HTMLElement | null = () => getLegendSection(key)
): void {
  const generation = legendPollGeneration;
  const deadlineMs = Date.now() + 10_000;
  const poll = (): void => {
    if (generation !== legendPollGeneration) return;
    const section = find();
    if (section) {
      onFound(section);
      return;
    }
    if (Date.now() >= deadlineMs) return;
    setTimeout(poll, 250);
  };
  setTimeout(poll, 250);
}

/**
 * DDM-P13-T02 F4: disclose what a Legend click actually does, once the
 * claims naming a legend are in the DOM. `requestLayerOn`
 * (`src/ui/layer-toggle-command.ts`) turns a layer on through the
 * controller's surface exclusivity: for a `role: 'surface'` layer
 * (`src/config/layers.ts`), turning it on when it is off replaces whatever
 * surface layer is showing now, drought included. `claim-render.ts` stays
 * pure and sets the plain pre-hydration default title; this hydrates the
 * honest, layer-specific title from the catalog so a surface layer's Legend
 * link says what it will do BEFORE it is clicked.
 */
function discloseLegendAnchorTitles(root: ParentNode): void {
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[data-legend-key]');
  anchors.forEach((anchor) => {
    const key = anchor.dataset['legendKey'];
    if (!key) return;
    const def = getLayerDef(key);
    if (!def) return;
    anchor.title =
      def.role === 'surface'
        ? `Legend; turns the ${def.name} layer on if it is off, replacing the surface layer showing now`
        : `Legend; turns the ${def.name} layer on if it is off`;
  });
}

/**
 * Where the legend reads when the Legend panel cannot be used (`legendPanelUsable`, shared with the Key's
 * 'Also on the map'): the section 'Also on the map' carries, else the Key's own title for the product.
 */
function keyLegendTarget(key: string): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(`#map-key [data-legend-also="${CSS.escape(key)}"]`) ??
    document.querySelector<HTMLElement>('#map-key-legend .map-key-label')
  );
}

/**
 * Delegated handler for every `a[data-legend-key]` a rendered claim carries
 * (`src/ui/claim-render.ts`). The href stays `#legend-panel` as the
 * no-script fallback; where that panel is not displayed the link opens the
 * on-map Key instead. Otherwise this makes the link reach the SECTION, whether the
 * product's map layer is already on (the section exists now) or off (the
 * layer is turned on first, through the same intent-first door every other
 * UI caller uses, `requestLayerOn`).
 */
function handleLegendLinkClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest<HTMLAnchorElement>('a[data-legend-key]');
  if (!anchor) return;
  const key = anchor.dataset['legendKey'];
  if (!key) return;
  event.preventDefault();
  // DDM-P13-T02 F3: every click bumps the generation before either branch
  // runs, so a poll from an earlier click (still in flight because its
  // layer is still activating) stops on its next tick even when this click
  // resolves synchronously below and never starts a poll of its own.
  legendPollGeneration++;

  const existing = getLegendSection(key);
  // Where the column's legend panel cannot be used (desktop Brief, a collapsed sidebar, an embed, the
  // phone sheet) the on-map Key is the legend: opened through its own toggle event, never closed by this
  // link, and focus moves into its legend content so a keyboard reader lands where the legend reads.
  if (!legendPanelUsable()) {
    if (document.getElementById('map-key')?.dataset['keyDetailsOpen'] !== 'true') {
      window.dispatchEvent(new Event('ddm:toggle-map-key-details'));
    }
    // A section the Key carries live (a control inside) has left the panel, so the Key's slot counts too.
    const shown = (): boolean =>
      Boolean(getLegendSection(key) || document.querySelector(`#map-key [data-legend-also="${CSS.escape(key)}"]`));
    if (shown()) {
      const target = keyLegendTarget(key);
      if (target) focusLegendSection(target);
      return;
    }
    requestLayerOn(key);
    waitForLegendSection(key, focusLegendSection, () => (shown() ? keyLegendTarget(key) : null));
    return;
  }
  if (existing) {
    focusLegendSection(existing);
    return;
  }
  // The product's map layer builds its own legend section on activation
  // (src/layers/usdm.ts, src/layers/heatrisk.ts); this only asks it to turn
  // on, through the shared UI-level door (never touches the layer module).
  requestLayerOn(key);
  waitForLegendSection(key, focusLegendSection);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// renderClaim lives in src/ui/claim-render.ts (pure, DOM-free) so the
// evidence-contract spec can import it without pulling this module's
// application state; every claim below renders through it.

/**
 * Render one hazard cell: its row label, its own status pill, and either its
 * sourced claims or the named state that says which product is missing.
 *
 * The cell prints no issuer and no date of its own. Every issuer and every
 * validity date rides the claim that owns it (`renderClaim`), so a hazard row
 * can never wear the issuer or the clock of the hazard above it.
 */
function renderCell(cell: HazardCell): string {
  let inner: string;
  if (cell.status === 'loading') {
    inner = `<div class="impact-horizon-loading"><span class="impact-spinner" aria-hidden="true"></span> Reading sources...</div>`;
  } else if (cell.claims.length > 0) {
    inner = cell.claims.map(renderClaim).join('');
    if (cell.note) {
      inner += `<p class="impact-horizon-note">${escapeHtml(cell.note)}</p>`;
    }
  } else {
    // Never a blank cell: `fillCell` guarantees a note whenever a settled
    // cell has no claim, and this fallback keeps that promise if one is ever
    // constructed by hand without one.
    const note =
      cell.note ??
      'No source answered for this hazard at this horizon. Open the resources below for current information.';
    inner = `<p class="impact-horizon-note">${escapeHtml(note)}</p>`;
  }

  const titleId = `impact-hazard-title-${cell.horizon}-${cell.hazard}`;
  // The "your mode" marker (M20, DR-123) always renders, hidden; only
  // `applyActiveHazardEmphasis` shows it, on the one cell whose hazard
  // matches the committed mode. It sits outside the `<h4>` so the section's
  // `aria-labelledby="${titleId}"` name never grows the word: see that
  // function's own comment for how a screen reader hears it.
  return `
    <section class="impact-hazard" data-horizon="${escapeHtml(cell.horizon)}" data-hazard="${escapeHtml(cell.hazard)}" aria-labelledby="${titleId}">
      <div class="impact-hazard-head">
        <div class="impact-hazard-title-wrap">
          <h4 class="impact-hazard-title" id="${titleId}">${escapeHtml(cell.label)}</h4>
          <span class="impact-hazard-you" hidden>your mode</span>
        </div>
        <span class="impact-hazard-pill impact-hazard-pill-${cell.status}">${escapeHtml(HORIZON_PILL_TEXT[cell.status])}</span>
      </div>
      <div class="impact-hazard-claims">${inner}</div>
    </section>
  `;
}

/**
 * Render one horizon section: heading, summary pill, and the four hazard rows
 * of that horizon (DR-012 b).
 *
 * The horizon pill summarizes its four cells and carries no issuer and no
 * date; a reader who needs either reads the cell.
 */
function renderHorizon(horizon: Horizon, afterHeatCell?: string): string {
  // `afterHeatCell` carries the point-heat section into the current horizon,
  // in the heat position: after the heat hazard cell and before the ENSO
  // cell (owner ruling, B/C: point heat sits in the heat row, below Fire and
  // above ENSO, and the briefing now leads with Current Conditions instead
  // of a floating point-heat block above every horizon). Only the current
  // horizon receives it; nearTerm and longRange call this with one argument.
  const rows = HAZARD_KEYS.map((hazard) => {
    const cell = renderCell(horizon.cells[hazard]);
    return hazard === 'heat' && afterHeatCell ? cell + afterHeatCell : cell;
  }).join('');

  // The section is named by its own visible heading text rather than by a
  // duplicate aria-label (IB-17). The id wraps the title only, so the
  // accessible name stays exactly the horizon title and the subtitle keeps
  // its supporting role.
  const titleId = `impact-horizon-title-${horizon.key}`;
  return `
    <section class="impact-horizon" aria-labelledby="${titleId}">
      <div class="impact-horizon-head">
        <h3 class="impact-horizon-title"><span id="${titleId}">${escapeHtml(horizon.title)}</span> <span class="impact-horizon-sub">${escapeHtml(horizon.subtitle)}</span></h3>
        <span class="impact-horizon-pill impact-horizon-pill-${horizon.status}">${escapeHtml(HORIZON_PILL_TEXT[horizon.status])}</span>
      </div>
      <div class="impact-horizon-claims">${rows}</div>
    </section>
  `;
}

function renderMetricValue(metric: PointHeatMetricSeries): string {
  const value = metric.values[0];
  if (!value) return '';
  return `<span title="Issuer value ${escapeHtml(String(value.value))} ${escapeHtml(value.unitCode)}">${escapeHtml(formatPointHeatValue(value.value, value.unitCode))}</span>`;
}

function renderObservation(pointHeat: PointHeatBriefing): string {
  const observation = pointHeat.observation;
  if (observation.status === 'loading') {
    return '<p class="point-heat-state">Reading the nearest NWS station...</p>';
  }
  if (observation.status !== 'ready') {
    return `<p class="point-heat-state">${escapeHtml(
      observation.note ?? SOURCE_PILL_TEXT[observation.status]
    )}</p>`;
  }
  const stationName =
    observation.stationName ?? observation.stationId ?? 'Nearest NWS station';
  const stationHref = checkPopupHref(observation.stationUrl);
  const station =
    stationHref !== null
      ? `<a href="${escapeHtml(stationHref)}" target="_blank" rel="noopener">${escapeHtml(stationName)}</a>`
      : escapeHtml(stationName);
  const distance =
    observation.distanceKm === undefined
      ? ''
      : `<span>${escapeHtml(formatDistanceKm(observation.distanceKm))} from the selected point</span>`;
  const timestamp = observation.timestamp
    ? `<time datetime="${escapeHtml(observation.timestamp)}">${escapeHtml(formatPointHeatTimestamp(observation.timestamp))}</time>`
    : '';
  return `
    <p class="point-heat-station">${station}</p>
    <p class="point-heat-meta">${distance}${timestamp}</p>
    <dl class="point-heat-observation-values">
      ${observation.metrics
        .map(
          (metric) =>
            `<div><dt>${escapeHtml(metric.label)}</dt><dd>${renderMetricValue(metric)}</dd></div>`
        )
        .join('')}
    </dl>
  `;
}

function renderGridMetric(metric: PointHeatMetricSeries): string {
  const shown = metric.values.slice(0, 8);
  return `
    <details class="point-heat-series" data-metric-key="${escapeHtml(metric.key)}">
      <summary>${escapeHtml(metric.label)}</summary>
      <table>
        <thead><tr><th scope="col">Issuer value</th><th scope="col">Valid interval</th></tr></thead>
        <tbody>
          ${shown
            .map(
              (value) => `
                <tr>
                  <td title="Issuer value ${escapeHtml(String(value.value))} ${escapeHtml(value.unitCode)}">${escapeHtml(formatPointHeatValue(value.value, value.unitCode))}</td>
                  <td><time datetime="${escapeHtml(value.startTime)}" title="${escapeHtml(value.validTime)}">${escapeHtml(formatPointHeatInterval(value.startTime, value.endTime))}</time></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
      ${
        metric.availableValueCount > shown.length
          ? `<p class="point-heat-series-count">Showing ${shown.length} of ${metric.availableValueCount} populated current or future intervals.</p>`
          : ''
      }
    </details>
  `;
}

function renderGrid(pointHeat: PointHeatBriefing): string {
  const grid = pointHeat.grid;
  if (grid.status === 'loading') {
    return '<p class="point-heat-state">Reading NWS grid guidance...</p>';
  }
  if (grid.status !== 'ready') {
    return `<p class="point-heat-state">${escapeHtml(
      grid.note ?? SOURCE_PILL_TEXT[grid.status]
    )}</p>`;
  }
  // Every NWS grid guidance disclosure starts closed (found-023, DDM-P7-T10
  // M19): no metric is opened by a "preferred" guess, in any
  // HAZARD_CLUSTER_KEYS mode. A reader's own open or closed choice still
  // survives a later refresh; see refreshOpenBriefing's disclosure-state
  // preservation below.
  // The grid names its cell as the points response gives it (gridX,
  // gridY), and its office id only when that differs from the forecast
  // office; the id alone repeats the office ('PDT / PDT', found-023).
  const gridOffice =
    grid.gridId && grid.gridId !== grid.office ? grid.gridId : null;
  const gridCell =
    grid.gridX !== undefined && grid.gridY !== undefined
      ? `${grid.gridX},${grid.gridY}`
      : null;
  const gridWords = [gridOffice, gridCell].filter(
    (part): part is string => part !== null
  );
  const identityParts = [
    grid.office ? `NWS office ${grid.office}` : null,
    gridWords.length > 0 ? `grid ${gridWords.join(' ')}` : null
  ].filter((part): part is string => part !== null);
  const identity = identityParts.join(', ');
  return `
    ${identity ? `<p class="point-heat-meta">${escapeHtml(identity)}</p>` : ''}
    ${grid.metrics.map((metric) => renderGridMetric(metric)).join('')}
  `;
}

function renderHeatSynthesis(synthesis: HeatSynthesis): string {
  // Every horizon claim carries "Source: <link>" from claim-render; the
  // section that most explicitly compares issuers carries the same path
  // (IB-12). The https guard mirrors renderClaim.
  const reads =
    synthesis.reads.length > 0
      ? `<ul>${synthesis.reads
          .map((read) => {
            const href = checkPopupHref(read.sourceUrl);
            const label =
              href !== null
                ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(read.label)}</a>`
                : escapeHtml(read.label);
            return `<li><strong>${label}</strong><p>${escapeHtml(read.text)}</p></li>`;
          })
          .join('')}</ul>`
      : '';
  const note = synthesis.note
    ? `<p class="point-heat-synthesis-note">${escapeHtml(synthesis.note)}</p>`
    : '';
  return `
    <section class="point-heat-synthesis" aria-label="Heat sources together">
      <div class="impact-horizon-head">
        <h5>Heat sources together</h5>
        <span class="point-heat-pill point-heat-pill-${synthesis.status}">${escapeHtml(SOURCE_PILL_TEXT[synthesis.status])}</span>
      </div>
      ${reads}
      ${note}
    </section>
  `;
}

function renderPointHeat(
  pointHeat: PointHeatBriefing,
  synthesis: HeatSynthesis
): string {
  const pointLabel =
    `${pointHeat.point.lat.toFixed(4)}, ${pointHeat.point.lng.toFixed(4)}`;
  return `
    <section class="point-heat" aria-label="Heat at selected point">
      <div class="impact-horizon-head">
        <div>
          <h4 class="impact-section-title">Heat at selected point</h4>
          <p class="point-heat-coordinate">${escapeHtml(pointLabel)}</p>
        </div>
        <span class="point-heat-pill point-heat-pill-${pointHeat.status}">${escapeHtml(SOURCE_PILL_TEXT[pointHeat.status])}</span>
      </div>
      <p class="point-heat-scope">Values describe this coordinate and nearby station, not the complete selected boundary or jurisdiction.</p>
      <div class="point-heat-grid">
        <section class="point-heat-card" aria-label="Observed nearby">
          <h5>Observed nearby</h5>
          ${renderObservation(pointHeat)}
        </section>
        <section class="point-heat-card" aria-label="NWS grid guidance">
          <h5>NWS grid guidance</h5>
          ${renderGrid(pointHeat)}
        </section>
      </div>
      ${renderHeatSynthesis(synthesis)}
    </section>
  `;
}

/** Render one resource link. */
function renderResource(resource: CatalogResource): string {
  const href = checkPopupHref(resource.url);
  const hasLink = href !== null;
  const desc = resource.description
    ? `<p class="impact-resource-desc">${escapeHtml(resource.description)}</p>`
    : '';
  const labelHtml = hasLink
    ? `<a class="impact-resource-label impact-resource-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(resource.label)}</a>`
    : `<p class="impact-resource-label">${escapeHtml(resource.label)}</p>`;
  return `
    <div class="impact-resource">
      ${labelHtml}
      ${desc}
      <p class="impact-resource-agency">${escapeHtml(resourceAgencyLine(resource))}</p>
    </div>
  `;
}

/**
 * Render the resources, grouped by tier in stewardship order; nothing at all
 * when there are none (D4: no empty heading over zero links where routing is
 * off). The Nation's-own slot ships empty, and an empty slot draws nothing,
 * its heading included (visual uniformity D10): a "populate this" note is a
 * deployer's instruction, not a reader's resource.
 * shortcut: the slot has no link in any build today, so no place draws it; when
 * a deployer can fill it, show it only for a place that is a Tribal Nation.
 */
function renderResources(all: readonly ResourceLink[]): string {
  const resources = all.filter((r) => r.tier !== 'tribe-own' || checkPopupHref(r.url) !== null);
  if (resources.length === 0) return '';
  const ordered = orderFederalByCondition(resources, getCommittedSnapshot().selectedHazard);
  const groups = TIER_ORDER.map((tier) => {
    const items = ordered.filter((r) => r.tier === tier);
    if (items.length === 0) return '';
    return `
      <div class="impact-resource-group">
        <h4 class="impact-resource-group-title">${escapeHtml(TIER_HEADING[tier])}</h4>
        ${items.map(renderResource).join('')}
      </div>
    `;
  }).join('');

  const checked = resourcesCheckedLine(resources);
  return `
    <section class="impact-resources" aria-label="Resources">
      <h3 class="impact-section-title">Resources to route</h3>
      <p class="impact-resources-framing">Tribal sovereignty is primary; external resources are supplementary. Each link below is plainly attributed to its agency as regional context, never as governing a Tribal Nation.</p>
      ${groups}
      ${checked ? `<p class="impact-resources-framing">${escapeHtml(checked)}</p>` : ''}
    </section>
  `;
}

/** Render the whole briefing body (everything below the static header). */
function renderBody(briefing: ImpactBriefing): string {
  return `${renderBriefingSections(briefing)}
    ${acknowledgementsHtml()}
  `;
}

/**
 * The sources that do not cover this place, named once under one heading in
 * Technical information, each with its own capability note (DR-256, B2).
 * Nothing when every source covers the place.
 */
function renderUncoveredSources(briefing: ImpactBriefing): string {
  const landscape = landscapeUncoveredGroup(briefing.context, briefing.sourcePolicy.geography);
  const groups = [...uncoveredSourceGroups(briefing.sourcePolicy), ...(landscape ? [landscape] : [])];
  if (groups.length === 0) return '';
  return `<h4>Sources that do not cover this place</h4>${groups
    .map(({ labels, note }) => `<p><strong>${escapeHtml(labels.join(', '))}.</strong> ${escapeHtml(note)}</p>`)
    .join('')}`;
}

/**
 * Every section of the briefing body above the acknowledgements, the part a
 * hydration refresh re-renders (`refreshOpenBriefing`).
 */
function renderBriefingSections(briefing: ImpactBriefing): string {
  const caveat = briefing.landCaveat
    ? `<p class="impact-land-caveat">${escapeHtml(briefing.landCaveat)}</p>`
    : '';
  const pointHeatSection = renderPointHeat(briefing.pointHeat, briefing.heatSynthesis);
  // The block holds four hazards, so it is not titled "Drought impact"; the
  // briefing's names are an open question (DR-013) and this does not answer
  // it. Point heat renders inside Current Conditions, after the heat cell and
  // before the ENSO cell (owner ruling B/C). DR-256: the matrix renders cell
  // by cell everywhere; a source that does not cover the place leaves its
  // cells and is named in Technical information.
  const impact = `
      <section class="impact-horizons" aria-label="Impact across three horizons">
        <h3 class="impact-section-title">Impact across three horizons</h3>
        ${renderHorizon(briefing.horizons.current, pointHeatSection)}
        ${renderHorizon(briefing.horizons.nearTerm)}
        ${renderHorizon(briefing.horizons.longRange)}
      </section>
    `;
  // The priority view and its switch show wherever any cell can read (DR-256,
  // B1); a place no matrix source covers keeps only the matrix's own states.
  // Both views are always rendered; `applyBriefingView` shows one, so a switch
  // never re-renders and the matrix is never out of the document.
  const anyCellReads = MATRIX_LANE_KEYS.some((key) => sourceMayRun(briefing.sourcePolicy, key));
  const shell = getCommittedSnapshot();
  const lead = anyCellReads
    ? `${renderViewSwitch(currentBriefingView())}${renderFocusHead()}${renderLeadView(briefing, Date.now(), {
        hazard: SHELL_HAZARD_KEY[shell.selectedHazard],
        horizon: SHELL_HORIZON_KEY[shell.horizon],
        pointHeat: pointHeatSection
      })}`
    : '';
  return `
    ${caveat}
    ${lead}
    ${landscapeContextShown(briefing.context) ? renderLandscapeContext(briefing.landscape) : ''}
    ${impact}
    ${renderResources(briefing.resources)}
    ${renderMapTechnicalInformation(false, renderPriorityRule() + renderUncoveredSources(briefing))}
  `;
}

/**
 * The acknowledgements section (S30D D1 M22, DDM-P7-T11): the last child
 * of every briefing body, closed by default. Its rows never depend on
 * hydration, so the markup is rendered once per runtime and reused, and a
 * refresh keeps the rendered node itself (`refreshOpenBriefing`).
 */
let acknowledgementsMemo: string | null = null;
function acknowledgementsHtml(): string {
  acknowledgementsMemo ??= renderAcknowledgements();
  return acknowledgementsMemo;
}

/**
 * The briefing body's acknowledgements section, the very markup `renderBody`
 * appends, for the eager facade's unavailable fallback (found-108; D1 M22,
 * DR-159, DR-161 to DR-166: every Impact Briefing ends in this section). The
 * facade reads it from this runtime once the runtime has loaded, so the
 * credits table never enters the eager entry.
 */
export function briefingAcknowledgementsHtml(): string {
  return acknowledgementsHtml();
}

/** Write the briefing into the panel chrome. */
function paint(briefing: ImpactBriefing): void {
  ensurePanel();
  if (titleEl) titleEl.textContent = briefing.landTitle;
  if (kindEl) kindEl.textContent = briefing.landKind;
  setMailActionEnabled(true);
  refreshBriefingActions(briefing.landTitle, briefing.context);
  if (bodyEl) {
    bodyEl.innerHTML = renderBody(briefing);
    discloseLegendAnchorTitles(bodyEl);
    applyActiveHazardEmphasis();
    applyBriefingView();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the briefing panel for a boundary selection. Builds the skeleton
 * (land plus live resources, horizons loading), renders it, and reveals the
 * panel. Phase 3 starts the live hydration here.
 */
export function openImpactPanel(
  context: BoundarySelectionContext,
  opener?: HTMLElement | null
): number {
  // Supersede any prior hydration before starting a new selection.
  // The eager facade owns the intent sequence so it can also reject a
  // superseded dynamic-import completion before this runtime executes.
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;

  const token = ++openToken;
  const briefing = createBriefingSkeleton(context);
  const landscapeResolution = resolveLandscapeSelection(context);
  if (!landscapeResolution.ok) {
    briefing.landscape = {
      status: 'unavailable',
      note: landscapeResolution.note,
      facts: [],
      sources: []
    };
  }
  activeBriefing = briefing;
  // A new open starts on the whole view, never on the last place's one hazard,
  // and on the priority view in every shell, never on the last open's choice.
  focusHazard = null;
  focusOpenerKey = null;
  briefingView = null;

  // The panel takes ownership of the place selection for this briefing (see
  // the panelSelection doc comment above; the stage-5 majors 3/4 fix). The
  // fresh object deliberately differs from any popup's selection object so
  // the popup-close identity guard stands down.
  panelSelection = { label: context.title, context };
  setPlaceSelection(panelSelection);

  paint(briefing);
  openImpactPanelShell(closeImpactPanel, opener);

  // Mirror the briefing into the sheet's at-hand block (the half
  // detent's Brief content; an invisible no-op everywhere else).
  setSheetBriefing(briefing);

  // The 531 kB landscape artifact and its consumer stay out of every
  // unsupported briefing. Exact ecoregion selections activate the lazy
  // consumer in parallel with the temporal sources.
  if (landscapeResolution.ok) {
    void rehydrateLandscapeContext(
      briefing,
      landscapeResolution.key,
      signal,
      token
    );
  }

  // Hydration applies the independent policy for every source (DR-256).
  void hydrateBriefing(
    briefing,
    signal,
    () => refreshOpenBriefing(token)
  ).catch((err: unknown) => {
    if (!signal.aborted) {
      console.warn('[impact-panel] hydration failed:', err);
    }
  });

  if (briefing.sourcePolicy.droughtImpact.enabled) {
    // In parallel, resolve the selection's location identity and swap in the
    // state-tier resources from the verified catalog (F3; D-0.6.0-009). The
    // Northwest-curated resources keep their data limit (DR-256), so a place
    // outside it starts no catalog route.
    void rehydrateResourcesFromCatalog(briefing, context, signal, token);
  }

  return token;
}

async function rehydrateLandscapeContext(
  briefing: ImpactBriefing,
  key: LandscapeEcoregionKey,
  signal: AbortSignal,
  token: number
): Promise<void> {
  try {
    const { resolveLandscapeContext } = await import(
      '../impact/landscape-consumer'
    );
    const landscape = await resolveLandscapeContext(key, { signal });
    if (signal.aborted) return;
    briefing.landscape = landscape;
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[impact-panel] landscape context failed:', err);
    briefing.landscape = {
      status: 'unavailable',
      note:
        'The baked landscape context could not be opened for this ecoregion.',
      facts: [],
      sources: []
    };
  }
  refreshOpenBriefing(token);
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
  return token === openToken && activeBriefing !== null && isImpactPanelShellOpen();
}

/** The briefing currently on screen, for in-place hydration (Phase 3). */
export function getActiveBriefing(): ImpactBriefing | null {
  return activeBriefing;
}

/**
 * The `<details>` disclosures whose reader-chosen open or closed state
 * `refreshOpenBriefing` carries across its own re-render (M19, generalizing
 * the Technical information-only list): `.impact-technical-information` is a
 * singleton, and each NWS grid metric disclosure carries its own stable
 * `data-metric-key` (renderGridMetric). M22 appended the acknowledgements
 * section, also a singleton; a refresh keeps its node, so the carry only
 * matters for print's forced opens (the post-render step below).
 */
const PRESERVED_DISCLOSURE_SELECTOR =
  '.impact-technical-information, .impact-acknowledgements, .point-heat-series[data-metric-key]';

/** A stable identity for one preserved disclosure, survives the re-render
 * that replaces the DOM node itself. */
function preservedDisclosureKey(details: HTMLDetailsElement): string {
  if (details.classList.contains('impact-technical-information')) return 'technical-information';
  if (details.classList.contains('impact-acknowledgements')) return 'acknowledgements';
  // Point heat renders twice in Extreme Heat mode (the lead and the matrix).
  return `${details.closest('.briefing-lead') ? 'lead:' : ''}point-heat-series:${details.dataset['metricKey'] ?? ''}`;
}

/** The open acknowledgements section's top, relative to the scrolling
 * body's top, or null when it is closed or absent (M22: a lane settling
 * above an open section must not push it away mid-read). */
function openAcknowledgementsOffset(body: HTMLElement): number | null {
  const section = body.querySelector<HTMLDetailsElement>('.impact-acknowledgements');
  if (!section?.open) return null;
  return section.getBoundingClientRect().top - body.getBoundingClientRect().top;
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
  refreshBriefingActions(activeBriefing.landTitle, activeBriefing.context);
  const hadFocusInBody = bodyEl.contains(document.activeElement);
  // The priority view's controls are reborn by this render. Each carries a
  // stable key, so focus returns to the same control instead of falling back
  // to the close button every time a lane settles.
  const focused = hadFocusInBody && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const leadFocusKey = focused?.closest<HTMLElement>('[data-lead-key]')?.dataset['leadKey'] ?? null;
  const leadFocusId = focused && LEAD_FOCUS_IDS.includes(focused.id) ? focused.id : null;
  const preservedOpen = new Map<string, boolean>();
  let focusedDisclosureKey: string | null = null;
  bodyEl
    .querySelectorAll<HTMLDetailsElement>(PRESERVED_DISCLOSURE_SELECTOR)
    .forEach((details) => {
      const key = preservedDisclosureKey(details);
      preservedOpen.set(key, details.open);
      if (details.contains(document.activeElement)) focusedDisclosureKey = key;
    });
  const acknowledgementsOffset = openAcknowledgementsOffset(bodyEl);
  // The acknowledgements section keeps its node (M22): its rows never depend
  // on hydration, so only the sections above it are re-rendered, and the
  // reader's open state and focus in it survive by construction (the node is
  // never detached, so focus never leaves it).
  const keptAcknowledgements = bodyEl.querySelector<HTMLDetailsElement>(
    ':scope > .impact-acknowledgements'
  );
  if (keptAcknowledgements) {
    while (bodyEl.firstChild && bodyEl.firstChild !== keptAcknowledgements) {
      bodyEl.firstChild.remove();
    }
    keptAcknowledgements.insertAdjacentHTML(
      'beforebegin',
      renderBriefingSections(activeBriefing)
    );
  } else {
    bodyEl.innerHTML = renderBody(activeBriefing);
  }
  bodyEl
    .querySelectorAll<HTMLDetailsElement>(PRESERVED_DISCLOSURE_SELECTOR)
    .forEach((details) => {
      const key = preservedDisclosureKey(details);
      const captured = preservedOpen.get(key);
      // A refresh mid-print must not let print's own forced opens pass as
      // the reader's choice: `captured` was read from the live DOM, which
      // while printing can hold `.open` that `openAllDisclosuresForPrint`
      // set, not the reader's. Correct it here, in this post-render step,
      // from the closed keys that call recorded before this render started.
      const wasOpen =
        printing && printForcedPreservedKeys.has(key) ? false : captured;
      if (wasOpen !== undefined) details.open = wasOpen;
      // Focus stays where the reader left it (found-107): a disclosure whose
      // node survived the render (the acknowledgements section) still holds
      // the focused element, a licence link say, so moving focus to its
      // summary would turn the reader's next Enter into a collapse. Only a
      // disclosure whose node was replaced lost its focus, and that one
      // takes it back on its summary.
      if (key === focusedDisclosureKey && !details.contains(document.activeElement)) {
        details.querySelector('summary')?.focus({ preventScroll: true });
      }
    });
  // Keep an open acknowledgements section where the reader left it: move
  // the body's scroll by however far the re-render shifted the section.
  if (acknowledgementsOffset !== null) {
    const after = openAcknowledgementsOffset(bodyEl);
    if (after !== null) bodyEl.scrollTop += after - acknowledgementsOffset;
  }
  // A refresh landing between beforeprint and afterprint must still show
  // every disclosure open for print. Re-derive the closed set from the
  // just-rendered DOM: the previous `openedForPrint` references are now
  // detached, and any preserved disclosure the loop above just restored to
  // its true closed state needs re-opening for the page, same as a plain
  // keyless one born closed by this render.
  if (printing) openAllDisclosuresForPrint();
  discloseLegendAnchorTitles(bodyEl);
  applyActiveHazardEmphasis();
  applyBriefingView();
  if (leadFocusKey !== null || leadFocusId !== null) {
    const reborn =
      leadFocusKey !== null
        ? bodyEl.querySelector<HTMLElement>(`[data-lead-key="${leadFocusKey}"]`)
        : document.getElementById(leadFocusId ?? '');
    if (reborn && reborn.offsetParent !== null) reborn.focus({ preventScroll: true });
  }
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
  onClose?.();
  openToken++;
  // DDM-P13-T02 F3: a close ends any legend poll still in flight so it
  // cannot focus a section after the user has left the panel.
  legendPollGeneration++;
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
  setMailActionEnabled(true);
  closeImpactPanelShell();
}

/**
 * Open the acknowledgements section from the map-information pointer
 * (S30D D1 M22; design record acknowledgements-table.md section 1.4, R-E
 * a): the shared shell opens in the acknowledgements-only presentation, no
 * place, no matrix, no hydration and no request, so `getActiveBriefing()`
 * stays null; close returns focus to `opener`. One path only: with a
 * briefing open the pointer is unreachable (on the desktop the briefing is
 * a modal over the Help button; on the phone Help is hidden at the half
 * detent), and that briefing's own Acknowledgements section, at the end of
 * its body, opens from its summary.
 *
 * The same no-place presentation opens at Technical information (the
 * owner's call 1) from the door of a popup with nothing to brief and from
 * the map key's link: the notes alone, expanded, with focus on their
 * summary. The key link is reachable with a briefing open on the phone
 * sheet; the notes then replace that briefing, as above.
 */
export function openNoPlacePanel(section: NoPlaceSection, opener: HTMLElement | null): void {
  // Supersede whatever this runtime showed before, the same way a new
  // place open does, then render the list alone.
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  openToken++;
  legendPollGeneration++;
  activeBriefing = null;
  if (panelSelection !== null && getPlaceSelection() === panelSelection) {
    setPlaceSelection(null);
  }
  panelSelection = null;
  setSheetBriefing(null);
  ensurePanel();
  if (titleEl) titleEl.textContent = NO_PLACE_HEADS[section].title;
  if (kindEl) kindEl.textContent = NO_PLACE_HEADS[section].kind;
  if (bodyEl) bodyEl.innerHTML = section === 'technical' ? renderMapTechnicalInformation(true, renderPriorityRule()) : renderAcknowledgements({ open: true });
  applyBriefingView();
  setMailActionEnabled(false);
  openImpactPanelShell(closeImpactPanel, opener);
  // The shell focused its close button; the expanded notes' summary takes that focus (never grabbed when the shell did not).
  if (section === 'technical' && panelEl?.contains(document.activeElement)) bodyEl?.querySelector<HTMLElement>('.impact-technical-information > summary')?.focus();
}

/** Register the eager facade's close hook before the first panel opens. */
export function setImpactPanelCloseHook(hook: () => void): void {
  onClose = hook;
}

// The former `attachImpactTrigger(popup, context)` facade was retired by
// the InteractionCoordinator unit (D-0.7.0-058 ruling 5): the coordinator
// (src/map/interaction-coordinator.ts) now owns the one click response,
// so it sets the place selection, routes the active mobile Brief sheet,
// wires the `[data-ddm-impact-trigger]` button, and clears the selection
// on response close (only if still current). The removal was recorded as
// a deliberate facade-freeze decision (the ADR 0001 note).
