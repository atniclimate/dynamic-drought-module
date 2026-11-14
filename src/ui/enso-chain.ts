/**
 * The ENSO mode's chain: its host and its presses (owner direction
 * 2026-11-09 (sprint), DR-pending).
 *
 * WHAT IT IS. While the sea surface temperature surface is on the map, one
 * panel lays five separate claims side by side, from the tropical Pacific to
 * a place: the observed index, the ocean surface the map draws, the
 * jet-level wind as model guidance, the published seasonal outlook at the
 * chosen place, and what is observed there now. It is drawn by the shared
 * link component the priority briefing also feeds (src/ui/evidence-chain.ts)
 * from data built in src/ui/enso-chain-model.ts, with an overview strip over
 * it and the nested truth (odds, not outcomes) one tap under its caption.
 *
 * THE CHAIN IS THE MODE'S TABLE OF CONTENTS. Pressing a link takes the map
 * to that link's view through the doors the rest of the interface already
 * uses, so the link is in the address bar and Back, reload and a shared link
 * keep working. This module holds no view state of its own:
 *   index     the ocean door (`requestOcean('pacific')`, cluster=enso and
 *             ocean=pacific) at the Current horizon, then the map key's own
 *             door to the Nino 3.4 box, whose popup lists the index and its
 *             companions, each with its own date;
 *   pattern   the same ocean view with the model overlay off (`flow=off`),
 *             so the analyzed surface stands alone;
 *   jet       the flow overlay's one door (`flow=jet`);
 *   tendency  the mode at its seasonal horizon (`horizon=season-ahead`),
 *             framed on the chosen place. What that horizon adds to the map
 *             is the mode's own recipe (src/config/clusters.ts); when it is
 *             not the layer of the outlook the link reads, the link and the
 *             announcement name the layer the map draws, so a precipitation
 *             map is never read as the temperature outlook the link states;
 *   here      the mode at Current, framed on the chosen place, and that
 *             place's briefing;
 *   place     the Place studio (`studio=place`), when no place is chosen.
 *
 * WHERE IT SITS. On the desktop shell it is a panel of the sidebar, above
 * the ocean and atmosphere controls. On the phone shell it is the content of
 * the sheet behind its own door, Guide, which this module seats in the
 * right-edge column's panel group for as long as the chain exists
 * (src/ui/edge-column.ts `seatEdgeControl`). The sheet stays closed until
 * that door is pressed: a boot or a hazard press stays map first. While the
 * guide is open #app carries `data-enso-guide="open"` and
 * `data-sheet-name`, which the stylesheet (src/styles/enso-chain.css) and
 * the sheet's header (src/ui/sheet-motion.ts) read; any real door, or the
 * sheet closing, ends it. That attribute is presentation, like the sheet's
 * own stop, and never enters the URL.
 *
 * READS. The index claims come from src/impact/enso.ts (the bundled
 * snapshot, through the page's one shared transport). The surface's state is
 * the layer registry's, the jet's is the flow overlay's own snapshot. The
 * two place reads are the briefing's own source functions, gated by the
 * briefing's own source policy, for the place selection in force; each is
 * cancelled when the selection changes and when the chain leaves. They are
 * made only while some of the panel is on screen (or holds focus): a place
 * chosen with the phone guide closed, or with the panel out of view in the
 * sidebar, asks no source anything until the chain is looked at, so a map
 * click in this mode costs no request the reader did not ask for. The
 * source functions are a further dynamic import, made only once a place is
 * chosen, the panel is on screen and the policy lets a source run. The
 * policy is a static import on purpose: asked for dynamically it became a
 * chunk of its own, and three small modules the entry shares with it left
 * the entry chunk for the boot's preload list (measured with
 * scripts/check-bundle-size.mjs).
 *
 * NOTHING MOVES. There is no animation here, so reduced motion has no twin
 * to keep in step, and no emphasis is carried by motion.
 */

import '../styles/briefing-lead.css';
import '../styles/enso-chain.css';

import type * as maplibregl from 'maplibre-gl';

import { HAZARD_CLUSTERS } from '../config/clusters';
import { getLayerDef } from '../config/layers';
import { PRODUCTS } from '../config/products';
import { readEnsoClaims } from '../impact/enso';
import { briefingSourcePolicy, sourceMayRun } from '../impact/source-policy';
import type { BoundarySelectionContext } from '../impact/types';
import { requestEnsoFlowKind } from '../layers/enso-flow';
import { fitOcean } from '../map/camera-fit';
import { requestCluster, requestHorizon, requestOcean } from '../state/cluster-service';
import { clearOceanFraming } from '../state/cluster-store';
import { getPlaceSelection, onPlaceSelectionChange } from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { registry } from '../state/registry';
import { enterPlaceStudio } from '../state/studio-route';
import { createChunkLoader } from '../util/chunk-retry';
import { requireStylesheetMark } from '../util/chunk-stylesheets';
import { prefersReducedMotion } from '../util/motion';
import { edgeColumnInset, seatEdgeControl } from './edge-column';
import {
  ENSO_CHAIN_CAPTION,
  ENSO_CHAIN_HEADING,
  buildEnsoChain,
  deviceDay,
  ensoStripSvg,
  renderEnsoClocks,
  renderEnsoTruth
} from './enso-chain-model';
import type { EnsoChainAction, EnsoRead, JetRead, PlaceRead } from './enso-chain-model';
import { renderEvidenceChain } from './evidence-chain';
import { openImpactPanel, openTechnicalInformation } from './impact-panel';
import {
  getSheetDetent,
  isSheetActive,
  onSheetDetentSettle,
  setSheetDetent,
  sheetCameraInset,
  sheetCameraSideInset
} from './mobile-sheet';

const SURFACE_KEY = 'sst-anomaly';
/** Mirrors src/layers/enso-flow.ts: the overlay's snapshot and its replay request. */
const FLOW_SNAPSHOT_EVENT = 'ddm:enso-flow-snapshot';
const FLOW_SNAPSHOT_REQUEST_EVENT = 'ddm:enso-flow-snapshot-request';
/** Mirrors src/layers/sst-anomaly.ts: the map key's door to the Nino 3.4 box. */
const FEATURE_DOOR_EVENT = 'ddm:feature-door';

/** The phone sheet's presentation flag and the name its header shows. */
const GUIDE_FLAG = 'data-enso-guide';
const SHEET_NAME = 'data-sheet-name';
const GUIDE_NAME = 'ENSO guide';
/**
 * The place links' reader, a chunk of its own. After a failed load the next
 * showing of the panel asks again under a new URL: Chromium replays a failed
 * import of the same URL without a request, so a plain second import() never
 * recovers (src/util/chunk-retry.ts; review finding R2-3).
 */
const loadSources = createChunkLoader(() => import('../impact/sources'), import.meta.url);

const DOOR_GLYPH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="4" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><rect x="17.8" y="9.8" width="4.4" height="4.4" rx="0.5"/><path d="M6.2 12h3.6M14.2 12h3.6"/></svg>';

const IDLE_JET: JetRead = { kind: null, status: 'inactive', label: '', line: '', notes: [] };

/**
 * What the mode's seasonal horizon adds to the map: its recipe there, less
 * its recipe at Current (src/config/clusters.ts), each layer under its own
 * catalog name. Read from the tables, so the words follow the recipe.
 */
const SEASON_ADDS: readonly { readonly key: string; readonly name: string }[] = HAZARD_CLUSTERS.enso.recipes[
  'season-ahead'
]
  .filter((key) => !HAZARD_CLUSTERS.enso.recipes.current.includes(key))
  .map((key) => ({ key, name: getLayerDef(key)?.name ?? key }));

/**
 * The layers the seasonal press shows, by name, unless one of them is the
 * layer of the outlook the link reads (then the map draws what the link
 * states, and nothing needs saying).
 */
function seasonDraws(outlook: PlaceRead): readonly string[] {
  const own = outlook.status === 'ready' ? PRODUCTS[outlook.claim.product].layerKey : null;
  return SEASON_ADDS.some((layer) => layer.key === own) ? [] : SEASON_ADDS.map((layer) => layer.name);
}

interface Held {
  readonly map: maplibregl.Map;
  readonly app: HTMLElement;
  readonly panel: HTMLElement;
  readonly body: HTMLElement;
  readonly live: HTMLElement;
  readonly door: HTMLButtonElement;
  readonly offs: Array<() => void>;
  readonly ensoController: AbortController;
  placeController: AbortController | null;
  enso: EnsoRead;
  frameDate: string | null;
  jet: JetRead;
  place: { readonly label: string; readonly context: BoundarySelectionContext } | null;
  outlook: PlaceRead;
  here: PlaceRead;
  /** Whether any of the panel is on screen. The two place links read only then. */
  onScreen: boolean;
  /** The place in force has not been read yet: the panel was not on screen when it was chosen. */
  placeUnread: boolean;
  truthOpen: boolean;
  clocksOpen: boolean;
  guideOpen: boolean;
  painted: string;
}

let held: Held | null = null;

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function paint(): void {
  const state = held;
  if (!state) return;
  const view = buildEnsoChain({
    enso: state.enso,
    surface: { status: registry.getStatus(SURFACE_KEY) ?? null, date: state.frameDate },
    jet: state.jet,
    place: state.place
      ? {
          label: state.place.label,
          inside: state.place.context.pointInsidePlace === true,
          ...(state.place.context.readAt ? { readAt: state.place.context.readAt } : {})
        }
      : null,
    outlook: state.outlook,
    here: state.here,
    seasonDraws: seasonDraws(state.outlook)
  });
  const chain = renderEvidenceChain(view.links, {
    id: 'enso',
    heading: ENSO_CHAIN_HEADING,
    caption: ENSO_CHAIN_CAPTION
  });
  const strip = ensoStripSvg(view.strip);
  const truth = renderEnsoTruth(state.enso);
  // The reading device's own calendar day: the clock line's one reference.
  const clocks = renderEnsoClocks(view.clocks, deviceDay(new Date()));
  const next = `${chain}\u0000${strip}\u0000${truth}\u0000${clocks}`;
  if (next === state.painted) return;
  state.painted = next;

  // The links are reborn by this render. Each press control carries its
  // link's key, so focus returns to the same control, as the briefing does.
  const active = document.activeElement;
  const inBody = active instanceof HTMLElement && state.body.contains(active) ? active : null;
  const focusKey = inBody?.closest<HTMLElement>('[data-chain-link]')?.dataset['chainLink'] ?? null;
  const focusTruth: 'summary' | 'door' | null =
    inBody === null || inBody.closest('.enso-truth') === null
      ? null
      : inBody.tagName === 'SUMMARY'
        ? 'summary'
        : inBody.hasAttribute('data-enso-door')
          ? 'door'
          : null;
  const focusClocks = inBody !== null && inBody.closest('.enso-clocks-summary') !== null;

  state.body.innerHTML = chain;
  state.body
    .querySelector('.evidence-chain-title')
    ?.insertAdjacentHTML('afterend', `<div class="enso-strip-figure">${strip}</div>`);
  // The denial first, then the clocks: both are closed until asked for.
  state.body.querySelector('.evidence-chain-caption')?.insertAdjacentHTML('afterend', truth + clocks);
  const details = state.body.querySelector<HTMLDetailsElement>('.enso-truth');
  if (details) details.open = state.truthOpen;
  const clockDetails = state.body.querySelector<HTMLDetailsElement>('.enso-clocks');
  if (clockDetails) clockDetails.open = state.clocksOpen;

  if (focusKey !== null) {
    state.body
      .querySelector<HTMLElement>(`[data-chain-link="${focusKey}"] [data-chain-action]`)
      ?.focus({ preventScroll: true });
  } else if (focusTruth !== null) {
    state.body
      .querySelector<HTMLElement>(focusTruth === 'summary' ? '.enso-truth > summary' : '.enso-truth [data-enso-door]')
      ?.focus({ preventScroll: true });
  } else if (focusClocks) {
    state.body.querySelector<HTMLElement>('.enso-clocks > summary')?.focus({ preventScroll: true });
  }
}

/**
 * Announce a press through the polite live region. The words name what was
 * asked for ("Showing ...", "Drawing ..."), never a result: when a press is
 * announced no layer has answered yet, and the link itself says what was read.
 */
function say(text: string): void {
  if (held) held.live.textContent = text;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readIndex(state: Held): void {
  const signal = state.ensoController.signal;
  void readEnsoClaims(signal).then(
    (result) => {
      if (signal.aborted || held !== state) return;
      state.enso = result.ok
        ? { status: 'ready', claims: result.claims }
        : { status: 'unavailable', note: result.note ?? 'The ENSO index snapshot was unavailable.' };
      paint();
    },
    () => {
      if (signal.aborted || held !== state) return;
      state.enso = { status: 'unavailable', note: 'The ENSO index snapshot was unavailable.' };
      paint();
    }
  );
}

/**
 * Take the selection in force for the two place links. A new selection, a
 * cleared one and an unmount each abort what was in flight. The reads start
 * at once when the panel is on screen, and otherwise wait until it is
 * (`readPlace`); until then the links say they are loading, and no one can
 * see them.
 */
function setPlace(state: Held, selection: PlaceSelection | null): void {
  state.placeController?.abort();
  state.placeController = null;
  state.placeUnread = false;
  if (selection === null) {
    state.place = null;
    state.outlook = { status: 'none' };
    state.here = { status: 'none' };
    paint();
    return;
  }
  state.place = { label: selection.label, context: selection.context };
  state.outlook = { status: 'loading' };
  state.here = { status: 'loading' };
  state.placeUnread = true;
  paint();
  if (state.onScreen) readPlace(state);
}

/**
 * Read the two place links for the place in force, once, through the
 * briefing's own source functions and its own source policy, so the chain
 * and the briefing state the same claims.
 */
function readPlace(state: Held): void {
  if (!state.place || !state.placeUnread) return;
  state.placeUnread = false;
  const context = state.place.context;
  const controller = new AbortController();
  state.placeController = controller;
  const signal = controller.signal;
  const current = (): boolean => !signal.aborted && held === state;
  const failed: PlaceRead = { status: 'unavailable', note: 'This source did not respond.' };
  const settle = (slot: 'outlook' | 'here', read: PlaceRead): void => {
    if (!current()) return;
    state[slot] = read;
    paint();
  };
  const policy = briefingSourcePolicy(context);
  const reads = [
    { slot: 'outlook', key: 'cpcSeasonalTemp', kind: 'cpc-tercile' },
    { slot: 'here', key: 'usdm', kind: 'usdm-category' }
  ] as const;
  // A source the policy gates off for this place says so in the policy's own sentence.
  for (const read of reads) {
    if (!sourceMayRun(policy, read.key)) settle(read.slot, { status: 'unavailable', note: policy.sources[read.key].note });
  }
  const open = reads.filter((read) => sourceMayRun(policy, read.key));
  if (open.length === 0) return;
  void loadSources().then(
    (sources) => {
      if (!current()) return;
      const fetchers = { cpcSeasonalTemp: sources.fetchCpcSeasonalTempClaims, usdm: sources.fetchUsdmClaims };
      for (const read of open) {
        // The chain's "here" link states a point read (wherePhrase); the place's outline is the Drought tile's area read.
        void fetchers[read.key]({ ...context, placeGeometry: null }, signal).then(
          (result) => {
            const claim =
              result.claims.find((candidate) => candidate.reading?.kind === read.kind) ?? result.claims[0];
            settle(
              read.slot,
              result.ok && claim
                ? { status: 'ready', claim }
                : { status: 'unavailable', note: result.note ?? failed.note }
            );
          },
          () => settle(read.slot, failed)
        );
      }
    },
    () => {
      // The reader itself did not load (a dropped connection). No source was
      // asked, so the link must not say one failed to answer; and the place
      // is marked unread again, so the next time the panel is shown it is
      // read.
      const notLoaded: PlaceRead = {
        status: 'unavailable',
        note: 'The reader for this link did not load, so its source was not asked. It is tried again when this panel is next shown.'
      };
      for (const read of open) settle(read.slot, notLoaded);
      if (current()) state.placeUnread = true;
    }
  );
}

function onFlowSnapshot(event: Event): void {
  const state = held;
  if (!state) return;
  const detail = (event as CustomEvent<Partial<JetRead> | null>).detail;
  if (!detail || typeof detail.status !== 'string') return;
  state.jet = {
    kind: typeof detail.kind === 'string' ? detail.kind : null,
    status: detail.status,
    label: typeof detail.label === 'string' ? detail.label : '',
    line: typeof detail.line === 'string' ? detail.line : '',
    notes: Array.isArray(detail.notes) ? detail.notes.filter((note): note is string => typeof note === 'string') : [],
    ...(typeof detail.cycle === 'number' ? { cycle: detail.cycle } : {}),
    ...(typeof detail.valid === 'number' ? { valid: detail.valid } : {})
  };
  paint();
}

// ---------------------------------------------------------------------------
// Presses: every one goes through an existing door
// ---------------------------------------------------------------------------

/** Run `then` once the camera rests (at once when it is not moving). */
function afterMove(map: maplibregl.Map, then: () => void): void {
  if (map.isMoving()) map.once('moveend', then);
  else then();
}

/** Frame the chosen place, clear of the phone sheet and the right-edge column. */
function framePlace(map: maplibregl.Map, context: BoundarySelectionContext): void {
  const animate = !prefersReducedMotion();
  const box = context.bboxCrossesAntimeridian ? undefined : context.bbox;
  if (box) {
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]]
      ],
      {
        padding: {
          top: 60,
          right: 40 + edgeColumnInset(),
          bottom: 40 + sheetCameraInset(),
          left: 40 + sheetCameraSideInset()
        },
        maxZoom: 9,
        animate
      }
    );
    return;
  }
  const view = { center: [context.lngLat.lng, context.lngLat.lat] as [number, number], zoom: Math.max(map.getZoom(), 5) };
  if (animate) map.easeTo(view);
  else map.jumpTo(view);
}

function press(action: EnsoChainAction): void {
  const state = held;
  if (!state) return;
  const { map } = state;
  const place = state.place;
  switch (action) {
    case 'index':
    case 'pattern':
      // The ocean door: the mode, the Pacific camera claim and the fit, as the
      // region menu's ocean views do it (src/ui/sidebar.ts).
      requestOcean('pacific');
      requestHorizon('current');
      fitOcean(map, 'pacific');
      if (action === 'pattern') {
        requestEnsoFlowKind('off');
        say('Showing the sea surface temperature surface alone, framed on the Pacific.');
      } else {
        // The index region's own popup, through the map key's door, once the camera rests.
        afterMove(map, () => {
          if (held === state) window.dispatchEvent(new CustomEvent(FEATURE_DOOR_EVENT, { detail: 'nino34' }));
        });
        say('Framing the map on the Pacific. The boxed region is the Nino 3.4 region the index is computed from.');
      }
      return;
    case 'jet':
      requestEnsoFlowKind('jet');
      say('Drawing NOAA GFS 250 hPa wind on the map as model guidance.');
      return;
    case 'tendency':
    case 'here':
      if (!place) return;
      // The camera leaves the ocean fit, so the link stops claiming it.
      requestCluster('enso');
      clearOceanFraming();
      requestHorizon(action === 'tendency' ? 'season-ahead' : 'current');
      framePlace(map, place.context);
      if (action === 'tendency') {
        const draws = seasonDraws(state.outlook);
        say(
          draws.length > 0
            ? `Showing the ${draws.join(' and ')}, framed on ${place.label}.`
            : `Showing the seasonal outlook, framed on ${place.label}.`
        );
        return;
      }
      say(`Showing current conditions, framed on ${place.label}, and opening its briefing.`);
      // The briefing takes the phone sheet, so the guide stands down first.
      standDown(() => openImpactPanel(place.context), 'sheet-report-door');
      return;
    case 'place':
      standDown(enterPlaceStudio);
      return;
  }
}

function onPanelClick(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest<HTMLElement>('[data-chain-action], [data-enso-door]') ?? null;
  if (!control || !held?.panel.contains(control)) return;
  if (control.dataset['ensoDoor'] === 'technical') {
    // On a phone the pressed control leaves with the guide, so the Guide
    // door is the opener that focus returns to when the section closes.
    const opener = held.guideOpen ? held.door : control;
    standDown(() => openTechnicalInformation(opener));
    return;
  }
  const action = control.dataset['chainAction'];
  if (action !== undefined) press(action as EnsoChainAction);
}

// ---------------------------------------------------------------------------
// The phone door and the sheet
// ---------------------------------------------------------------------------

/**
 * Hand the phone sheet to another surface: the guide closes, `then` opens
 * what replaces it, and focus that was on a control of the guide moves to
 * `focusId` when that control is on screen, else to the Guide door, so it
 * never falls to the page body with the hidden panel. `then` may take focus
 * itself (a studio, a report at full); that is left alone. Outside the phone
 * shell the panel stays where it is and only `then` runs.
 */
function standDown(then: () => void, focusId?: string): void {
  const state = held;
  if (!state) return;
  const inGuide = state.guideOpen && state.panel.contains(document.activeElement);
  closeGuide(false);
  then();
  if (!inGuide || held !== state) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.isConnected && active.offsetParent !== null) return;
  const next = focusId ? document.getElementById(focusId) : null;
  (next && !next.hidden && next.offsetParent !== null ? next : state.door).focus({ preventScroll: true });
}

let offGuideFocus: (() => void) | null = null;

/**
 * Move focus from the pressed Guide door into the guide it opened (WCAG
 * 2.4.3), as the four footer doors do (mobile-sheet.ts focusShownView): the
 * sheet title, else the first control that does not raise the keyboard, at
 * settle and only while focus is still on the door or nowhere. A sheet that
 * will not move has no settle to wait for, so it takes focus at once.
 */
function focusGuide(state: Held, settleExpected: boolean): void {
  offGuideFocus?.();
  const take = (): void => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== state.door) return;
    const shown = (el: HTMLElement): boolean =>
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const title = document.getElementById('sheet-title');
    const target =
      title && shown(title)
        ? title
        : [
            ...state.panel.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], select:not(:disabled), [tabindex]:not([tabindex="-1"])'
            )
          ].find(shown);
    if (!target) return;
    if (!target.hasAttribute('tabindex') && target === title) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };
  if (!settleExpected) {
    take();
    return;
  }
  const off = onSheetDetentSettle((detent) => {
    if (held !== state || !state.guideOpen) {
      off();
      return;
    }
    // A settle at the closed stop is the hand-off from a door, not the guide's own.
    if (detent === null || detent === 'closed') return;
    off();
    offGuideFocus = null;
    take();
  });
  offGuideFocus = off;
}

function closeGuide(returnFocus: boolean): void {
  const state = held;
  if (!state || !state.guideOpen) return;
  offGuideFocus?.();
  offGuideFocus = null;
  state.guideOpen = false;
  state.app.removeAttribute(GUIDE_FLAG);
  state.app.removeAttribute(SHEET_NAME);
  state.door.setAttribute('aria-expanded', 'false');
  // The guide is long. Whatever takes an open sheet after it starts at its
  // own top, never at the offset the guide was scrolled to.
  const scroll = state.panel.closest<HTMLElement>('.sidebar-scroll');
  if (scroll && isSheetActive()) scroll.scrollTop = 0;
  // The sheet hands focus to the map when no door claimed it; this door did.
  if (returnFocus && document.activeElement?.classList.contains('maplibregl-canvas')) {
    state.door.focus({ preventScroll: true });
  }
}

function openGuide(): void {
  const state = held;
  if (!state || !isSheetActive()) return;
  state.guideOpen = true;
  state.app.setAttribute(GUIDE_FLAG, 'open');
  state.app.setAttribute(SHEET_NAME, GUIDE_NAME);
  state.door.setAttribute('aria-expanded', 'true');
  focusGuide(state, getSheetDetent() === 'closed' || state.app.hasAttribute('data-sheet-tab'));
  // A door that holds the sheet lets go first; the sheet is then raised by
  // no door, which is what the stylesheet reads as the guide's turn.
  if (state.app.hasAttribute('data-sheet-tab') && getSheetDetent() !== 'closed') {
    setSheetDetent('closed', { announce: false });
  }
  if (getSheetDetent() === 'closed') setSheetDetent('half');
  const scroll = state.panel.closest<HTMLElement>('.sidebar-scroll');
  if (scroll) scroll.scrollTop = 0;
}

/** A real door took the sheet, or the sheet closed or went away: the guide ends. */
function syncGuide(): void {
  const state = held;
  if (!state || !state.guideOpen) return;
  const detent = state.app.getAttribute('data-sheet-detent');
  if (detent === null || detent === 'closed' || state.app.hasAttribute('data-sheet-tab')) {
    closeGuide(detent === 'closed');
  }
}

function buildDoor(): HTMLButtonElement {
  const door = document.createElement('button');
  door.type = 'button';
  door.id = 'enso-guide-door';
  door.className = 'enso-guide-door';
  // The name leads with the word the cell shows (WCAG 2.5.3), as the hazard cells do.
  door.setAttribute('aria-label', 'Guide. ENSO, from the ocean to the weather here');
  door.setAttribute('aria-controls', 'sidebar');
  door.setAttribute('aria-expanded', 'false');
  door.innerHTML = `${DOOR_GLYPH}<span>Guide</span>`;
  door.addEventListener('click', () => {
    if (!held) return;
    if (held.guideOpen) setSheetDetent('closed');
    else openGuide();
  });
  door.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !held?.guideOpen) return;
    event.preventDefault();
    setSheetDetent('closed');
  });
  return door;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/** The loader hands over the frame date the layer announced (no replay exists for it). */
export function setEnsoChainFrameDate(date: string | null): void {
  if (!held || held.frameDate === date) return;
  held.frameDate = date;
  paint();
}

/** Mount the chain for the map. Idempotent: a second call refreshes the frame date only. */
export function mountEnsoChain(map: maplibregl.Map, frameDate: string | null): void {
  if (held) {
    if (held.map === map) {
      setEnsoChainFrameDate(frameDate);
      return;
    }
    unmountEnsoChain();
  }
  const app = document.getElementById('app');
  const scroll = document.querySelector<HTMLElement>('#sidebar .sidebar-scroll');
  if (!app || !scroll) return;
  // No stylesheet, no guide: the loader says its failure line instead.
  requireStylesheetMark(app, '--ddm-enso-chain-css', 'enso-chain');

  const panel = document.createElement('section');
  panel.className = 'panel enso-chain-panel';
  panel.id = 'enso-chain-panel';
  panel.setAttribute('aria-label', 'ENSO, from the ocean to the weather here');
  const body = document.createElement('div');
  body.className = 'enso-chain';
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  panel.append(body, live);
  // Above the ocean and atmosphere controls, which follow this seat in the page.
  const anchor = document.getElementById('brief-display');
  if (anchor?.parentElement === scroll) anchor.after(panel);
  else scroll.append(panel);

  const door = buildDoor();
  const state: Held = {
    map,
    app,
    panel,
    body,
    live,
    door,
    offs: [],
    ensoController: new AbortController(),
    placeController: null,
    enso: { status: 'loading' },
    frameDate,
    jet: IDLE_JET,
    place: null,
    outlook: { status: 'none' },
    here: { status: 'none' },
    onScreen: false,
    placeUnread: false,
    truthOpen: false,
    clocksOpen: false,
    guideOpen: false,
    painted: ''
  };
  held = state;

  panel.addEventListener('click', onPanelClick);
  // `toggle` does not bubble: caught on the way down, so a repaint keeps the reader's choice.
  panel.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (target.classList.contains('enso-truth')) state.truthOpen = target.open;
      else if (target.classList.contains('enso-clocks')) state.clocksOpen = target.open;
    },
    true
  );
  window.addEventListener(FLOW_SNAPSHOT_EVENT, onFlowSnapshot);
  state.offs.push(() => window.removeEventListener(FLOW_SNAPSHOT_EVENT, onFlowSnapshot));
  state.offs.push(
    registry.on('status-change', (key) => {
      if (key === SURFACE_KEY) paint();
    })
  );
  state.offs.push(onPlaceSelectionChange((selection) => setPlace(state, selection)));
  // The two place links read only while some of the panel is on screen: the
  // phone guide open, or the sidebar showing this panel. Focus inside it
  // counts as well. Where the browser cannot say, the panel counts as on
  // screen, which is the chain reading as soon as a place is chosen.
  if (typeof IntersectionObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (held !== state || !last) return;
      state.onScreen = last.isIntersecting;
      if (state.onScreen) readPlace(state);
    });
    seen.observe(panel);
    state.offs.push(() => seen.disconnect());
  } else {
    state.onScreen = true;
  }
  panel.addEventListener('focusin', () => {
    if (held === state) readPlace(state);
  });
  const shell = new MutationObserver(syncGuide);
  shell.observe(app, { attributes: true, attributeFilter: ['data-sheet-detent', 'data-sheet-tab'] });
  state.offs.push(() => shell.disconnect());
  // The door rides the column's panel group, under the four doors, on phones only.
  state.offs.push(seatEdgeControl(door, { group: 'panels', order: 20 }));

  paint();
  readIndex(state);
  setPlace(state, getPlaceSelection());
  // The overlay answers with what it is drawing now.
  window.dispatchEvent(new Event(FLOW_SNAPSHOT_REQUEST_EVENT));
}

/** Remove the chain: every read is aborted, the door leaves the column, an open guide closes. */
export function unmountEnsoChain(): void {
  const state = held;
  if (!state) return;
  const showing = state.guideOpen;
  closeGuide(false);
  held = null;
  state.ensoController.abort();
  state.placeController?.abort();
  for (const off of state.offs) off();
  state.door.remove();
  state.panel.remove();
  // The sheet was showing the guide and nothing else: it goes with it.
  if (showing && isSheetActive() && getSheetDetent() !== 'closed') setSheetDetent('closed');
}
