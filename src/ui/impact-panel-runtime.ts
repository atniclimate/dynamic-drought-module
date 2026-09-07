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
import { hydrateBriefing } from '../impact/hydrate';
import { HAZARD_KEYS, markHorizonCells } from '../impact/matrix';
import {
  formatDistanceKm,
  formatPointHeatInterval,
  formatPointHeatTimestamp,
  formatPointHeatValue
} from '../impact/point-heat-format';
import {
  resolveLandscapeSelection
} from '../impact/landscape-resolution';
import type { LandscapeEcoregionKey } from '../impact/landscape-resolution';
import { renderClaim } from './claim-render';
import { renderLandscapeContext } from './landscape-context';
import { loadFederalResources, resourcesForIdentity } from '../impact/resource-catalog';
import { resolveLocationIdentity } from '../state/location-identity';
import { getMap } from '../state/map-store';
import { getPlaceSelection, setPlaceSelection } from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { setSheetBriefing } from './mobile-sheet';
import type {
  BoundarySelectionContext,
  HazardCell,
  HeatSynthesis,
  Horizon,
  HorizonStatus,
  ImpactBriefing,
  PointHeatBriefing,
  PointHeatMetricSeries,
  ResourceLink,
  ResourceTier
} from '../impact/types';
import type { LayerStatus } from '../types/layer';
import { escapeHtml } from '../util/escape';
import {
  closeImpactPanelShell,
  ensureImpactPanelShell,
  isImpactPanelShellOpen,
  openImpactPanelShell
} from './impact-panel';

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
/** Matrix note shown instead of unsupported impact synthesis. */
let activeImpactUnavailableNote: string | null = null;

/**
 * Supersede token. Incremented on every open and on close so an async
 * hydration started for one selection cannot render into a panel that has
 * since been closed or reopened for a different boundary.
 */
let openToken = 0;

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

// ---------------------------------------------------------------------------
// Status pill text
// ---------------------------------------------------------------------------

/**
 * Horizon pill wording follows the canonical six-state vocabulary
 * (a project invariant; the island's STATUS_PILL_TEXT is the
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

const SOURCE_PILL_TEXT: Record<LayerStatus, string> = {
  loading: 'loading...',
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
  return shared.panel;
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
  return `
    <section class="impact-hazard" data-horizon="${escapeHtml(cell.horizon)}" data-hazard="${escapeHtml(cell.hazard)}" aria-labelledby="${titleId}">
      <div class="impact-hazard-head">
        <h4 class="impact-hazard-title" id="${titleId}">${escapeHtml(cell.label)}</h4>
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
function renderHorizon(horizon: Horizon): string {
  const rows = HAZARD_KEYS.map((hazard) =>
    renderCell(horizon.cells[hazard])
  ).join('');

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
  const station =
    observation.stationUrl?.startsWith('https://')
      ? `<a href="${escapeHtml(observation.stationUrl)}" target="_blank" rel="noopener">${escapeHtml(stationName)}</a>`
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

function renderGridMetric(
  metric: PointHeatMetricSeries,
  open: boolean
): string {
  const shown = metric.values.slice(0, 8);
  return `
    <details class="point-heat-series"${open ? ' open' : ''}>
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
  const preferred =
    grid.metrics.find((metric) => metric.key === 'heatIndex')?.key ??
    grid.metrics.find((metric) => metric.key === 'apparentTemperature')?.key ??
    grid.metrics[0]?.key;
  const identity = [grid.office, grid.gridId].filter(Boolean).join(' / ');
  return `
    ${identity ? `<p class="point-heat-meta">${escapeHtml(identity)}</p>` : ''}
    ${grid.metrics
      .map((metric) => renderGridMetric(metric, metric.key === preferred))
      .join('')}
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
            const label =
              typeof read.sourceUrl === 'string' &&
              read.sourceUrl.startsWith('https://')
                ? `<a href="${escapeHtml(read.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(read.label)}</a>`
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
        <h4>Heat sources together</h4>
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
          <h3 class="impact-section-title">Heat at selected point</h3>
          <p class="point-heat-coordinate">${escapeHtml(pointLabel)}</p>
        </div>
        <span class="point-heat-pill point-heat-pill-${pointHeat.status}">${escapeHtml(SOURCE_PILL_TEXT[pointHeat.status])}</span>
      </div>
      <p class="point-heat-scope">Values describe this coordinate and nearby station, not the complete selected boundary or jurisdiction.</p>
      ${pointHeat.note ? `<p class="impact-horizon-note">${escapeHtml(pointHeat.note)}</p>` : ''}
      <div class="point-heat-grid">
        <section class="point-heat-card" aria-label="Observed nearby">
          <h4>Observed nearby</h4>
          ${renderObservation(pointHeat)}
        </section>
        <section class="point-heat-card" aria-label="NWS grid guidance">
          <h4>NWS grid guidance</h4>
          ${renderGrid(pointHeat)}
        </section>
      </div>
      ${renderHeatSynthesis(synthesis)}
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
function renderBody(
  briefing: ImpactBriefing,
  impactUnavailableNote: string | null
): string {
  const caveat = briefing.landCaveat
    ? `<p class="impact-land-caveat">${escapeHtml(briefing.landCaveat)}</p>`
    : '';
  const impact = impactUnavailableNote
    ? `
      <section class="impact-capability-unavailable" aria-label="Drought impact unavailable">
        <h3 class="impact-section-title">Drought impact unavailable</h3>
        <p class="impact-horizon-note">${escapeHtml(impactUnavailableNote)}</p>
      </section>
    `
    : // The block now holds four hazards, so it can no longer be titled
      // "Drought impact": that heading would speak for Fire, Heat and ENSO
      // as well. The wording here is the plainest one that stays true to
      // what the block contains; the briefing's names are an open question
      // (DR-013) and this does not answer it.
      `
      <section class="impact-horizons" aria-label="Impact across three horizons">
        <h3 class="impact-section-title">Impact across three horizons</h3>
        ${renderHorizon(briefing.horizons.current)}
        ${renderHorizon(briefing.horizons.nearTerm)}
        ${renderHorizon(briefing.horizons.longRange)}
      </section>
    `;
  return `
    ${caveat}
    ${renderPointHeat(briefing.pointHeat, briefing.heatSynthesis)}
    ${renderLandscapeContext(briefing.landscape)}
    ${impact}
    ${renderResources(briefing.resources)}
  `;
}

/** Write the briefing into the panel chrome. */
function paint(
  briefing: ImpactBriefing,
  impactUnavailableNote: string | null
): void {
  ensurePanel();
  if (titleEl) titleEl.textContent = briefing.landTitle;
  if (kindEl) kindEl.textContent = briefing.landKind;
  if (bodyEl) {
    bodyEl.innerHTML = renderBody(briefing, impactUnavailableNote);
  }
}

/** Put every mirrored horizon and every cell into the same explicit state. */
function markImpactSynthesisUnavailable(
  briefing: ImpactBriefing,
  note: string
): void {
  for (const horizon of [
    briefing.horizons.current,
    briefing.horizons.nearTerm,
    briefing.horizons.longRange
  ]) {
    markHorizonCells(horizon, 'unavailable', note);
    horizon.note = note;
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
  const unavailableNote = briefing.sourcePolicy.droughtImpact.enabled
    ? null
    : briefing.sourcePolicy.droughtImpact.note;
  if (unavailableNote) {
    markImpactSynthesisUnavailable(briefing, unavailableNote);
  }
  activeBriefing = briefing;
  activeImpactUnavailableNote = unavailableNote;

  // The panel takes ownership of the place selection for this briefing (see
  // the panelSelection doc comment above; the stage-5 majors 3/4 fix). The
  // fresh object deliberately differs from any popup's selection object so
  // the popup-close identity guard stands down.
  panelSelection = { label: context.title, context };
  setPlaceSelection(panelSelection);

  paint(briefing, unavailableNote);
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

  // Hydration applies the independent policy for every source. This runs even
  // when regional drought synthesis is unavailable because point heat may be
  // supported for the selected geography.
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
    // same capability evidence gates resource routing, so unsupported or
    // unknown contexts start no catalog route.
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
  bodyEl.innerHTML = renderBody(
    activeBriefing,
    activeImpactUnavailableNote
  );
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
  activeBriefing = null;
  activeImpactUnavailableNote = null;
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
  closeImpactPanelShell();
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
