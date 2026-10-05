/**
 * The InteractionCoordinator (D-0.7.0-058 ruling 5; the ratified design
 * review's one-interaction-model section; the S1 precedence table in
 * src/config/interaction-ranks.ts).
 *
 * One map click resolves exactly ONE primary target and renders exactly
 * ONE response. The per-layer `map.on('click', layerId)` handlers this
 * replaces each opened their own popup, so a click where several layers
 * overlap stacked popups, and the shared place selection and emphasis
 * were last-writer-wins in listener-registration order (which followed
 * network completion order at boot). Here every click-bearing layer
 * REGISTERS its target instead, and arbitration is semantic and
 * deterministic: rank by the precedence table, never by paint order,
 * network completion, or registration order. Lower-priority hits are
 * reachable through the "Other map features here (n)" disclosure inside
 * the one response; choosing one replaces the response in place.
 *
 * Response sinks (pre-S4): the active mobile Brief sheet keeps its
 * shipped route (a place-bearing tap raises the briefing at the half
 * detent; no popup paints); every other surface (desktop both modes,
 * embed) gets the one coordinator-owned MapLibre popup. S4's single
 * shell can rehost the response at the foot of the left panel by
 * swapping the sink; the arbitration above it does not change.
 *
 * While a studio route owns the screen the coordinator is inert: a
 * studio selection is an explicit catalog act, and no popup may paint
 * over a studio.
 */

import * as maplibregl from 'maplibre-gl';

import { interactionRank } from '../config/interaction-ranks';
import type { InteractionTargetKind } from '../config/interaction-ranks';
import type { BoundaryKind, BoundarySelectionContext, ContainingPlaces } from '../impact/types';
import { isStateCode } from '../config/state-codes';
import { getEmphasisTargets, emphasizePlaces } from '../state/place-emphasis';
import type { EmphasisTarget } from '../state/place-emphasis';
import { getPlaceSelection, setPlaceSelection } from '../state/place-selection';
import type { PlaceSelection } from '../state/place-selection';
import { getStudioRoute, onStudioRouteChange } from '../state/studio-route';
import { getViewMode, onViewModeChange } from '../state/view-mode';
import type { LocationIdentity } from '../state/location-identity';
import { openImpactPanel } from '../ui/impact-panel';
import { isSheetActive } from '../ui/mobile-sheet';
// Types only (zero bytes): the frame itself is loaded by the one dynamic
// import below (S30D P1-FRAME), never statically, since this module sits in
// the entry graph.
import type { PopupModel, serializePopupFrame } from '../ui/popup-frame';
import { createChunkLoader } from '../util/chunk-retry';

/** The click location a response builder receives. */
export interface CoordinatorClick {
  readonly lngLat: maplibregl.LngLat;
  readonly point: maplibregl.Point;
}

/**
 * What a committed target renders and establishes: EXACTLY ONE of `model`
 * or `content` (S30D P1-FRAME, 2026-10-04).
 *
 * `model` is the popup frame's typed model (src/ui/popup-frame.ts); the
 * coordinator is the frame's one caller and serializes it, so a layer module
 * imports only the frame's types. `content` is the legacy answer (an HTML
 * string or a prebuilt DOM element) that unmigrated builders still give
 * until M26 retires the path; a framed string there still renders framed.
 * An answer carrying both or neither is a builder bug the type forbids; at
 * runtime it is declined like a null answer (the next hit answers), never
 * a dead click.
 */
export type CoordinatedResponse =
  | (ResponseCommon & {
      /** Popup content: an HTML string or a prebuilt DOM element. */
      readonly content: string | HTMLElement;
      readonly model?: never;
    })
  | (ResponseCommon & {
      /** The frame's model; the coordinator renders `serializePopupFrame(model)`. */
      readonly model: PopupModel;
      readonly content?: never;
    });

/** What every response carries beside its popup content. */
interface ResponseCommon {
  /**
   * Popup chrome options. `closeOnClick` is always forced off: the
   * coordinator owns dismissal (the next click either replaces the
   * response or, hitting nothing, closes it), and two dismissal
   * mechanisms racing on the same click is the defect class this
   * module exists to end.
   */
  readonly popupOptions?: maplibregl.PopupOptions;
  /**
   * Place-bearing responses carry the briefing context; committing one
   * sets the shared place selection, wires the briefing trigger inside
   * the content, and clears the selection when the response closes
   * (only if still current, so a rapid follow-up selection is never
   * clobbered by a late close event).
   */
  readonly selection?: BoundarySelectionContext;
  /** Feature-state emphasis to light on commit (boundary layers). */
  readonly emphasis?: readonly EmphasisTarget[];
}

/** One layer module's registered click target. */
export interface ClickTargetSpec {
  readonly kind: InteractionTargetKind;
  /** The clickable layer ids this target answers for. */
  readonly layerIds: readonly string[];
  /**
   * Short display label for the disclosure list. Returning null marks
   * the hit as offering nothing (an unnamed place label); it is
   * skipped in arbitration entirely.
   */
  label(feature: maplibregl.MapGeoJSONFeature): string | null;
  /**
   * Build the response for a committed hit. Returning null declines
   * the commit (arbitration falls through to the next hit).
   */
  respond(
    feature: maplibregl.MapGeoJSONFeature,
    click: CoordinatorClick,
    map: maplibregl.Map
  ): CoordinatedResponse | null;
  /**
   * A GROUP-CAPABLE target (D2 supplies one; D1 computes no group,
   * grouping-contract.md 12.1). The coordinator hands `respond` EVERY
   * labelled feature of this target's layers under the click, in rendered
   * order, taken before the first-feature collapse. The target owes the
   * rest, inside its own lazy chunk: it assembles those features into
   * sections and dedupes them by resolved group key through
   * `assembleSections` (src/map/response-sections.ts), so two hits in one
   * group make ONE section and sections are ordered by key, and it answers
   * ONE response whose sections sit inside the one popup. A null answer
   * falls back to `respond` above for the first feature, then to the next
   * hit.
   */
  readonly group?: {
    respond(
      features: readonly maplibregl.MapGeoJSONFeature[],
      click: CoordinatorClick,
      map: maplibregl.Map
    ): CoordinatedResponse | null;
  };
}

/** One arbitration candidate: a registered spec's first rendered hit. */
interface Hit {
  readonly spec: ClickTargetSpec;
  readonly feature: maplibregl.MapGeoJSONFeature;
  readonly label: string;
  /** The effective kind after the selected-place promotion. */
  readonly kind: InteractionTargetKind;
  /** Rendered order (topmost first): the deterministic same-rank tiebreak. */
  readonly order: number;
  /** A group-capable target's every labelled feature under the click, in rendered order; null otherwise. */
  readonly features: maplibregl.MapGeoJSONFeature[] | null;
}

const specs: ClickTargetSpec[] = [];
const specByLayerId = new Map<string, ClickTargetSpec>();
let currentPopup: maplibregl.Popup | null = null;
let initialized = false;

// ---------------------------------------------------------------------------
// The popup frame's one caller (S30D P1-FRAME, 2026-10-04; a Tier 2 change to
// the D1 M23 contract). Builders answer a MODEL and the coordinator turns it
// into the frame's markup, so the 5 kB frame rides no layer's chunk. It is
// loaded by ONE dynamic import, WARMED when a click target registers, so a
// click normally finds it loaded and commits synchronously exactly as a
// legacy answer does. The import goes through createChunkLoader, the layer
// loader's own recovery (src/config/layers.ts): a failed import() is cached
// in the module map, so after a failure every later demand (the next
// registration, the next click) imports the chunk under a new retry URL.
// Demands while a load is in flight share it (one module record, one
// request).
//
// THE ONE AWAIT: a commit carrying a model that lands before the chunk has
// resolved records itself as `pendingCommit` and waits. After the wait it
// does nothing unless it is STILL that record. Every route that supersedes
// it clears or replaces the record: a later commit (cleared on entry to
// `commit`, before its builder runs), a dismissal (`dismissResponse`: an
// empty click, Escape on an open response, a studio route, entering Brief
// with the mobile sheet active, a station popup adopting the slot, the
// briefing door), Escape during the wait itself (a handler that lives as long
// as the wait), the current response closed by its close button (`closed`,
// the adopted station popup's included), the map's removal, the test reset,
// and the mobile Brief sheet ACTIVATING with no view-mode change (a resize
// below the phone breakpoint, an embed transition): activation settles
// synchronously and resizes the map, and on that resize a commit the sheet
// would then take is retired, so a sheet that deactivates again before the
// wait ends cannot hand it back. Nothing is written before the wait: no selection, no emphasis, no
// dismissal of the response on screen, no sink call.
// ---------------------------------------------------------------------------

const loadFrameChunk = createChunkLoader(() => import('../ui/popup-frame'), import.meta.url);
let serializeFrame: typeof serializePopupFrame | null = null;
/** The waiting commit; `sheetRoute` says whether the mobile Brief sheet would now take it. */
let pendingCommit: { readonly sheetRoute: () => boolean } | null = null;

function loadFrame(): Promise<void> {
  return loadFrameChunk().then((frame) => {
    serializeFrame = frame.serializePopupFrame;
  });
}

// ---------------------------------------------------------------------------
// The swappable response sink (S4c). The sanctioning authority is the S4
// design record section 3, S4c bullet: "the NEW structured coordinator
// response sink + the active-cluster-aware response". This file's own
// pre-existing header (the design-intent comment above) anticipated the
// same shape: a single shell rehosting the response by swapping the sink
// while the arbitration above it does not change; that sentence is this
// module's, not the design record's.
// ---------------------------------------------------------------------------

/**
 * The structured response handed to a swappable sink. The element is the
 * SAME assembled response the popup path renders: a frozen
 * `.coordinated-response-head` (title, briefing door, the "Other map
 * features here" disclosure) followed by a scrolling
 * `.coordinated-response-body` (agency line, meta, the full
 * representation caveat; D-0.7.0-072). Handing the assembled element
 * over keeps the two surfaces byte-identical in content.
 */
export interface StructuredResponse {
  readonly element: HTMLElement;
  /** The response title text, when the content carried one. */
  readonly title: string | null;
  /** True when the response established a place selection. */
  readonly placeBearing: boolean;
}

export interface ResponseSink {
  /**
   * Present the response, replacing any prior one in place. Return
   * false to DECLINE (the sink surface is not usable right now: a
   * collapsed sidebar, a narrow viewport); the coordinator then falls
   * back to its own popup, so a response is never silently dropped.
   */
  present(response: StructuredResponse): boolean;
  /** Retire the currently presented response. Idempotent. */
  dismiss(): void;
}

let sink: ResponseSink | null = null;
let sinkPresented = false;
let sinkSelection: PlaceSelection | null = null;

/**
 * Install (or, with null, remove) the one alternate response sink. Only
 * PLACE-BEARING responses route to the sink, mirroring the shipped
 * mobile-sheet precedent: the map is the instrument for fire, smoke,
 * and condition responses, so those keep the map-anchored popup.
 * Installing over a presented response retires it first, so no response
 * is stranded on a surface the coordinator no longer tracks.
 */
export function setResponseSink(next: ResponseSink | null): void {
  if (sink === next) return;
  if (sinkPresented) dismissResponse();
  sink = next;
}

/**
 * Register a click target. Called from each layer module's `bindPopups`
 * (the layer-controller invokes that once, on first activation, so a
 * target registers together with its lazy chunk). Idempotent per layer
 * id so a test-driven double bind never doubles a hit.
 */
export function registerClickTarget(spec: ClickTargetSpec): void {
  if (spec.layerIds.every((id) => specByLayerId.has(id))) return;
  specs.push(spec);
  for (const id of spec.layerIds) specByLayerId.set(id, spec);
  // The identify-paths census (M23, tests/identify-paths.spec.ts): each
  // registered target appended as `kind:layerId,layerId`, space-separated,
  // DOM only, never read here.
  const census = document.getElementById('map-container');
  if (census) {
    census.setAttribute(
      'data-ddm-click-targets',
      `${census.getAttribute('data-ddm-click-targets') ?? ''} ${spec.kind}:${spec.layerIds.join(',')}`.trim()
    );
  }
  // Warm the frame chunk with the first registration (later ones share the
  // same load; after a failed warm-up a later registration tries again). A
  // warm-up failure is silent: the click that needs the frame reports it.
  if (!serializeFrame) loadFrame().catch(() => {});
}

/**
 * Bind the one map click handler and the response-sink transitions.
 * Called once at boot; registrations may arrive before or after
 * (layers register lazily as they first activate).
 */
export function initInteractionCoordinator(map: maplibregl.Map): void {
  if (initialized) return;
  initialized = true;
  map.on('click', (e) => {
    handleClick(map, e);
  });
  // A studio owns the screen: entering one dismisses any open response
  // (the PLACE studio is a left-side route on desktop, so a lingering
  // popup would stay visibly painted on the exposed map and reappear
  // stale on return; adversarial finding 5, 2026-07-17 review).
  onStudioRouteChange((route) => {
    if (route !== null) dismissResponse();
  });
  // Entering Brief with the mobile sheet active: the sheet's at-hand
  // block is the response surface there, so a popup carried over from
  // console mode would be a second response beside it.
  onViewModeChange((mode) => {
    if (mode === 'brief' && isSheetActive()) dismissResponse();
  });
  // The mobile Brief sheet activating with no view-mode change (a resize, an
  // embed transition, revealSheetAtPeek) settles synchronously, and its
  // settle resizes this map before anything else (src/ui/mobile-sheet.ts,
  // settle; MapLibre fires 'resize' from inside the call): a commit waiting
  // for the frame that the sheet would now take is retired then and there,
  // so activation wins and is remembered even if the sheet deactivates again
  // before the wait ends. Any other resize re-checks the same predicate.
  map.on('resize', () => {
    if (pendingCommit?.sheetRoute()) pendingCommit = null;
  });
  // The map's removal retires a commit still waiting for the frame: a popup
  // on the map retires one through its own close, but a first cold click
  // has no popup yet.
  map.on('remove', () => {
    pendingCommit = null;
  });
}

/**
 * Adopt a popup the coordinator did not create as THE current response.
 *
 * The one shipped popup producer outside the registration path is the
 * telemetry station marker: markers are DOM elements in the canvas
 * container, their popups open through MapLibre's own marker click
 * observer (or Enter/Space on the marker element), and their features
 * are invisible to queryRenderedFeatures, so they can never arbitrate
 * as rendered hits. A station is the table's top 'point-event', so the
 * station popup WINS the click: adopting it dismisses any coordinator
 * response (including one committed earlier in the same click's event
 * dispatch, since the boot-bound coordinator listener runs before the
 * marker's later-registered one), and the adopted popup then occupies
 * the single response slot so the next commit or empty click retires
 * it like any other response.
 */
export function adoptExternalResponse(popup: maplibregl.Popup): void {
  dismissResponse();
  // Positive provenance for the identify-paths observer (M23): an adopted
  // popup is marked here, never inferred from a missing coordinator stamp.
  // On a first open MapLibre builds the element only when the opener sets
  // the content, after this 'open' call, so the mark follows in a microtask.
  queueMicrotask(() => popup.getElement()?.setAttribute('data-ddm-external-response', ''));
  popup.once('close', () => closed(popup));
  currentPopup = popup;
}

/**
 * The current response's popup closed by a route other than
 * `dismissResponse` (its close button): the slot empties, and a commit still
 * waiting for the frame is retired with it (a dismissal wins).
 */
function closed(popup: maplibregl.Popup): void {
  if (currentPopup !== popup) return;
  currentPopup = null;
  pendingCommit = null;
}

/** TEST SEAM: reset module state between jsdom-style unit runs. */
export function resetInteractionCoordinatorForTest(): void {
  specs.length = 0;
  specByLayerId.clear();
  currentPopup = null;
  initialized = false;
  sink = null;
  sinkPresented = false;
  sinkSelection = null;
  // A waiting commit never outlives a reset, and the frame is forgotten so
  // the next registration warms it again (a test can then commit cold).
  pendingCommit = null;
  serializeFrame = null;
  // The census stamp follows the registry, so a re-registration after a
  // reset never appends a stale or duplicate token.
  document.getElementById('map-container')?.removeAttribute('data-ddm-click-targets');
}

function handleClick(map: maplibregl.Map, e: maplibregl.MapMouseEvent): void {
  if (getStudioRoute() !== null) return;
  const hits = collectHits(map, e.point);
  const click: CoordinatorClick = { lngLat: e.lngLat, point: e.point };
  if (hits.length === 0) {
    dismissResponse();
    return;
  }
  commit(map, hits, hits[0]!, click);
}

/**
 * Pointer-sized click tolerance (EF-7). A bare-point
 * `queryRenderedFeatures` demands sub-pixel accuracy, which makes a thin
 * hydrography line, a small island, or a narrow boundary sliver effectively
 * unclickable, and a finger lands further from what it aims at than a mouse
 * does. The click therefore queries a small box around the point, mirroring
 * the hover inspector (src/ui/hover-inspector.ts, BOX = 3). Arbitration is
 * untouched: candidates are still ranked by the precedence table and then
 * rendered order, so a direct hit still wins and everything else stays
 * reachable through the one response's other-features disclosure.
 */
const CLICK_BOX_FINE_PX = 6;
const CLICK_BOX_COARSE_PX = 12;

function clickBoxRadius(): number {
  return window.matchMedia?.('(pointer: coarse)').matches === true
    ? CLICK_BOX_COARSE_PX
    : CLICK_BOX_FINE_PX;
}

/**
 * Collect and rank the candidates under the click point: one query over
 * every present registered layer, the first rendered feature per
 * registration, ranked by the precedence table with the selected-place
 * promotion (a hit that IS the currently emphasized place outranks its
 * own class; re-clicking inside a selected boundary re-affirms it
 * rather than switching subjects). Same-rank ties break by rendered
 * order, which is deterministic under the E1 z-order.
 */
function collectHits(map: maplibregl.Map, point: maplibregl.Point): Hit[] {
  const present = [...specByLayerId.keys()].filter((id) => map.getLayer(id));
  if (present.length === 0) return [];

  const radius = clickBoxRadius();
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - radius, point.y - radius],
    [point.x + radius, point.y + radius]
  ];
  const features = map.queryRenderedFeatures(box, { layers: present });
  const hits: Hit[] = [];
  const taken = new Map<ClickTargetSpec, Hit>();

  // The first-feature collapse per registration. The collection seam sits
  // before it (tests/interaction-coordinator-collect.test.mjs): a
  // group-capable target's hit keeps every later labelled feature too.
  for (const [order, feature] of features.entries()) {
    const spec = specByLayerId.get(feature.layer.id);
    if (!spec) continue;
    const prior = taken.get(spec);
    if (prior && !prior.features) continue;
    const label = spec.label(feature);
    if (label === null) continue;
    if (prior) {
      prior.features?.push(feature);
      continue;
    }
    const hit: Hit = {
      spec,
      feature,
      label,
      kind: isSelectedPlace(feature, label) ? 'selected-place' : spec.kind,
      order,
      features: spec.group ? [feature] : null
    };
    taken.set(spec, hit);
    hits.push(hit);
  }

  hits.sort(
    (a, b) => interactionRank(a.kind) - interactionRank(b.kind) || a.order - b.order
  );
  return hits;
}

/**
 * Whether this hit IS the currently selected place, by either identity
 * the application carries: the feature-state emphasis (boundary clicks,
 * the search's multi-representation emphasis, studio restores), or,
 * where a selection exists without an emphasis identity (the
 * summary-first state search, an ecoregion selection), an exact label
 * match against the place-selection store. The label comparison is
 * deliberately exact-string: where a source's display name diverges
 * from the stored selection label, the promotion honestly does not
 * apply rather than fuzzy-matching a sovereign boundary.
 */
function isSelectedPlace(feature: maplibregl.MapGeoJSONFeature, label: string): boolean {
  if (feature.id !== undefined && feature.id !== null) {
    const source = feature.source;
    const sourceLayer = feature.sourceLayer ?? undefined;
    const emphasized = getEmphasisTargets().some(
      (t) => t.source === source && t.id === feature.id && t.sourceLayer === sourceLayer
    );
    if (emphasized) return true;
  }
  const selection = getPlaceSelection();
  return selection !== null && selection.label === label;
}

/**
 * Commit one hit as the primary response. The full hit list rides along
 * so the disclosure can offer every other candidate, and choosing one
 * re-commits it in place (the former primary joins the disclosure). A
 * group-capable target answers for every feature under the click first
 * (ClickTargetSpec.group); its null falls back to its single response for
 * the first feature, and a hit that declines both drops out and the next
 * one is tried.
 *
 * A MODEL answer needs the frame (S30D P1-FRAME). Normally it is already
 * loaded and the commit finishes synchronously, as a legacy answer does.
 * If not, the commit waits (THE ONE AWAIT, the block comment at
 * `loadFrameChunk`), writing nothing first, and finishes only if it is
 * still the pending commit (Escape meanwhile, or the mobile Brief sheet
 * activating to take it, retires it). A load that fails, if still pending,
 * is reported once and dismisses (a click that yields no response
 * dismisses, as an empty click does); the next click tries the chunk again.
 * The mobile Brief sheet route paints no popup, so it never waits. A model
 * the frame refuses throws its PopupFrameError before any selection or
 * emphasis is written: on a warm commit to the caller, exactly as a
 * builder's own serializer call did (a caller bug, never a data condition;
 * M23); after a wait, where no caller can see it, it is reported and
 * dismissed like a failed load. Only that refusal is caught after a wait: a
 * failure in the rendering that follows propagates, as it does warm.
 */
function commit(
  map: maplibregl.Map,
  hits: readonly Hit[],
  primary: Hit,
  click: CoordinatorClick
): void {
  // A later commit retires a waiting one before it asks its builder, so even
  // a builder that throws cannot leave the earlier commit to paint later.
  pendingCommit = null;
  const response =
    answer(primary.features && primary.spec.group?.respond(primary.features, click, map)) ??
    answer(primary.spec.respond(primary.feature, click, map));
  if (!response) {
    const rest = hits.filter((h) => h !== primary);
    if (rest.length > 0) commit(map, rest, rest[0]!, click);
    else dismissResponse();
    return;
  }

  // The active mobile Brief sheet is its own response surface: a
  // place-bearing tap answers at the half detent (the at-hand block),
  // and no popup paints (the shipped U2 route, moved here from
  // attachImpactTrigger). Non-place responses keep their popups: the
  // map is the instrument for those. Decided before the selection writes
  // below, which it once followed: nothing those writes notify changes
  // the view mode or the sheet detent, so it is the same decision.
  const sheetRoute = (): boolean => !!response.selection && isSheetActive() && getViewMode() === 'brief';
  const sheet = sheetRoute();
  // The markup, always taken before `finish` writes anything, so a refused
  // model throws before any write.
  const markup = (): string | HTMLElement | undefined =>
    sheet || response.model === undefined ? response.content : serializeFrame!(response.model);

  const finish = (content: string | HTMLElement | undefined): void => {
    // Selection FIRST, so the outgoing response's close (which clears the
    // selection only if still current) can never clobber the new subject.
    // A place-bearing commit OWNS the emphasis state: it lights what the
    // response supplies and clears a prior subject's emphasis when it
    // supplies none (an ecoregion response replacing a reservation must
    // not leave the reservation lit; adversarial finding 3). A non-place
    // commit deliberately leaves selection and emphasis alone: a selected
    // briefing place is cleared only by its own explicit control
    // (D-0.7.0-041; src/ui/view-shell.ts reopenSelectedPlace), so a fire
    // or condition click beside it never silently drops the subject.
    let selection: PlaceSelection | null = null;
    if (response.selection) {
      selection = { label: response.selection.title, context: response.selection };
      setPlaceSelection(selection);
      emphasizePlaces(map, response.emphasis ?? []);
    }

    if (sheet && response.selection) {
      dismissResponse();
      openImpactPanel(response.selection);
      return;
    }

    renderPopup(map, response, content!, selection, hits, primary, click);
  };

  if (response.model === undefined || sheet || serializeFrame) {
    finish(markup());
    return;
  }
  const record = { sheetRoute };
  pendingCommit = record;
  // Escape during the wait retires the commit: nothing is on screen yet, so
  // no popup's own Escape handler exists. This one lives exactly as long as
  // the wait, however it ends, acts only while this commit is still the
  // waiting one, and swallows nothing.
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && pendingCommit === record) dismissResponse();
  };
  document.addEventListener('keydown', onEscape);
  loadFrame().finally(() => document.removeEventListener('keydown', onEscape)).then(
    () => {
      if (pendingCommit !== record) return;
      // After the wait no caller sees a throw: a model the frame refuses is
      // reported and dismissed like a failed load, never left as an
      // unhandled rejection. The catch covers the serialization only, before
      // any write; the writes and the rendering after it (sink callbacks
      // included) stay outside it, so their failure can never dismiss a
      // newer response.
      let content: string | HTMLElement | undefined;
      try {
        content = markup();
      } catch (err) {
        frameFailed(err);
        return;
      }
      finish(content);
    },
    (err: unknown) => {
      if (pendingCommit === record) frameFailed(err);
    }
  );
}

/**
 * A model commit that cannot paint after its wait (the chunk failed to
 * load, or the frame refused the model): reported once for a developer,
 * then dismissed, as a click that yields no response is. No new wording.
 */
function frameFailed(err: unknown): void {
  console.error('[coordinator] the popup frame could not paint this response:', err);
  dismissResponse();
}

/**
 * A target's answer when it carries exactly one of `model` or `content`,
 * else null: both or neither is a builder bug the type forbids, declined
 * like a null answer (fail soft: the next hit answers, never a dead click).
 */
function answer(response: CoordinatedResponse | null | undefined): CoordinatedResponse | null {
  return response && (response.model === undefined) !== (response.content === undefined) ? response : null;
}

function renderPopup(
  map: maplibregl.Map,
  response: CoordinatedResponse,
  content: string | HTMLElement,
  selection: PlaceSelection | null,
  hits: readonly Hit[],
  primary: Hit,
  click: CoordinatorClick
): void {
  dismissResponse();

  // Split the response into a FROZEN head and a SCROLLING body. The
  // maintainer directive of 2026-07-18 kept the head to title, door, and
  // the feature switcher, with even the agency line scrolling in the
  // body; the owner amended that on 2026-09-10 ("a change from a prior
  // opinion"): a place popup is now a conditions card, not only an
  // identity card, so its succinct identity AND its conditions belong
  // where they are always visible. The head, top to bottom, is now: the
  // title, the one-line "kind of place" (`.popup-agency`) when the
  // content carries a `.popup-conditions` block (see below), that
  // Conditions block itself (`src/ui/popup-conditions.ts`), THEN the
  // briefing door, THEN the "Other map features here" switcher. The
  // boundary detail (acres, classification, treaty year, and the like)
  // and the representation caveat stay in the scrolling body, below the
  // fold, exactly where the owner asked for them NOT to lead the card.
  // Body scrolling never moves the head (the body, not the card, is the
  // scroll container via .ddm-coordinated-popup); whether the head is
  // VISIBLE at a given popup size is governed solely by the canonical
  // tier table in src/ui/popup-viewport.ts, which does not promise head
  // visibility in every tier.
  //
  // A response that carries no `.popup-conditions` block (the NWS alert
  // and SPC Fire Weather Outlook popups, the NIFC perimeter popup, and
  // the telemetry-station skeleton) is NOT a place-identity card in the
  // owner's sense -- the map feature itself IS the subject -- so it keeps
  // the pre-2026-09-10 shape exactly: only the title and the door move to
  // the head, and its own agency line stays in the body.
  const raw = document.createElement('div');
  if (typeof content === 'string') raw.innerHTML = content;
  else raw.appendChild(content);

  // D1 M23: a FRAMED response (the DOM contract of src/ui/popup-frame.ts,
  // validated in takeFrame: a model this coordinator serialized, or a
  // legacy answer that carries the frame's markup) keeps its
  // article as the one real root. Its head and body regions take the
  // coordinated classes the tier table and the panel host rules read, and
  // no node moves out of it (listeners and the title stay where the
  // builder put them). `raw` is then empty, so the legacy class-name split
  // below moves nothing; that split stays for unmigrated builders until
  // M26 retires it.
  const frame = takeFrame(raw);
  const head = frame?.head ?? document.createElement('div');
  head.classList.add('coordinated-response-head');
  const body = frame?.body ?? document.createElement('div');
  body.classList.add('coordinated-response-body');

  // Title first (frozen), if the content carries one. querySelector on the
  // working fragment moves each node out of `raw`, so whatever remains
  // falls through to the body.
  const title = raw.querySelector('.popup-title');
  if (title) head.appendChild(title);
  const conditions = raw.querySelector('.popup-conditions');
  if (conditions) {
    const agency = raw.querySelector('.popup-agency');
    if (agency) head.appendChild(agency);
    head.appendChild(conditions);
  }
  const trigger = raw.querySelector('[data-ddm-impact-trigger]');
  if (trigger) head.appendChild(trigger);
  while (raw.firstChild) body.appendChild(raw.firstChild);

  // The escape hatch sits at the foot of the frozen head, below the door
  // (in a framed head, after the actions slot).
  const others = hits.filter((h) => h !== primary);
  if (others.length > 0) {
    head.appendChild(buildDisclosure(map, hits, others, click));
  }

  const container = frame?.root ?? document.createElement('div');
  container.classList.add('coordinated-response');
  // The committed target's layer id, for the identify-paths observer (M23).
  container.setAttribute('data-ddm-response', primary.feature.layer.id);
  if (!frame) {
    container.appendChild(head);
    container.appendChild(body);
  }
  // The sink's title: the legacy title, or the frame's title slot (which
  // carries the same .popup-title class).
  const titleNode = title ?? head.querySelector('.popup-title');

  if (selection) {
    const context = selection.context;
    container
      .querySelector<HTMLButtonElement>('[data-ddm-impact-trigger]')
      ?.addEventListener('click', () => {
        openImpactPanel(context);
        dismissResponse();
      });
  }

  // The swappable sink (S4c): a PLACE-BEARING response offers itself to
  // the installed sink first (the shell's panel-foot response). The sink
  // may decline (collapsed sidebar, narrow viewport), in which case the
  // popup below renders exactly as before. Non-place responses never
  // route here; the map stays the instrument for those.
  if (sink && selection) {
    const presented = sink.present({
      element: container,
      title: titleNode?.textContent ?? null,
      placeBearing: true
    });
    if (presented) {
      sinkPresented = true;
      sinkSelection = selection;
      return;
    }
  }

  // One usable close control per sink (D1 M23; DDM-P17-T11): the close
  // button is forced AFTER a response's own options, which may still set
  // the offset and the rest (the place label asked for none, places.ts).
  // A framed card takes the frame's measure on the desktop shell through
  // `.ddm-popup-framed` (app.css), not MapLibre's 240 px default.
  const popup = new maplibregl.Popup({
    ...response.popupOptions,
    className: frame ? 'ddm-coordinated-popup ddm-popup-framed' : 'ddm-coordinated-popup',
    closeButton: true,
    closeOnClick: false
  })
    .setLngLat(click.lngLat)
    .setDOMContent(container)
    .addTo(map);

  // Keyboard dismissal (acceptance clause 2). MapLibre's Popup focuses its
  // content on open (`focusAfterOpen`) but does not itself bind Escape to
  // close; without this, a keyboard user who tabs into the popup has no
  // keyboard path out of it at all except tabbing all the way past every
  // link. One document-level listener per open popup, removed the moment
  // the popup closes (by any route: this key, the close button, or the
  // next commit's `dismissResponse`), so it can never fire against a
  // popup that already closed nor leak across commits.
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dismissResponse();
  };
  document.addEventListener('keydown', onEscape);

  popup.on('close', () => {
    document.removeEventListener('keydown', onEscape);
    closed(popup);
    if (selection && getPlaceSelection() === selection) setPlaceSelection(null);
  });
  currentPopup = popup;

  // DR-042 option a (session-ruled 2026-09-09): a NON-place response (the
  // map feature itself is the subject: drought category, fire perimeter,
  // smoke plume, alert, and their peers) painted above with no door. Try,
  // asynchronously, to resolve the tap's PLACE anyway, and if one exists
  // append a place-specific door to the already-painted head. This never
  // races the paint above (the popup is already on screen) and never
  // routes straight to the briefing (only a person clicking the door
  // opens it); see `attachConditionDoor`.
  if (!selection) {
    void attachConditionDoor(map, popup, head, click);
  }
}

/**
 * The place a condition-surface or point-event tap resolves to, for
 * `attachConditionDoor` below: the containing Tribal / reservation land
 * first (D-0.8.0-052 already resolved which active layer wins that), the
 * containing state otherwise. Null over open country or open water, where
 * `resolveLocationIdentity` itself resolves nothing -- the honest case in
 * which no door is offered.
 */
function doorSubjectFromIdentity(
  identity: LocationIdentity
): { kind: BoundaryKind; title: string } | null {
  if (identity.containingTribal) {
    return { kind: identity.containingTribal.source, title: identity.containingTribal.name };
  }
  if (identity.state) {
    return { kind: 'state', title: identity.state.name };
  }
  return null;
}

/**
 * DR-042 option a: resolve a condition-surface or point-event tap's PLACE
 * through the same location-identity stack the briefing panel's own state
 * tier reads (src/state/location-identity.ts), and, only when one
 * resolves, append a place-specific door to the popup's frozen `head`.
 *
 * The popup above has ALREADY painted (this runs after `currentPopup =
 * popup`), so a slow resolve never delays or blocks the response the tap
 * aimed at; the door is a later addition a person may click, never a
 * redirect. This deliberately does NOT call `setPlaceSelection` or
 * `emphasizePlaces`: those are owned by a true boundary commit (the
 * comment above `commit`), and a condition tap must never silently
 * promote or replace the subject a selected boundary or a prior briefing
 * still owns.
 *
 * Stale guard: `currentPopup !== popup` once resolution settles means a
 * later click already replaced or dismissed this popup, so the resolved
 * door is simply dropped rather than appended to detached markup.
 */
async function attachConditionDoor(
  map: maplibregl.Map,
  popup: maplibregl.Popup,
  head: HTMLElement,
  click: CoordinatorClick
): Promise<void> {
  // Dynamic, not static: `interaction-coordinator.ts` sits in the eager
  // entry graph (first paint), and a static import of any of these three
  // drags the location-identity stack, popups.ts, and the urls catalog
  // chunk into first paint too (DDM-P11-T02 fix-wave: measured 31.1 kB to
  // 50.2 kB gzip at the entry chunk, over the DR-008 45 kB budget). This
  // path only runs after a non-place-bearing popup has ALREADY painted
  // (see the call site below), so the import cost lands on that later
  // async step, never on boot.
  let identity: LocationIdentity;
  try {
    const { resolveLocationIdentity } = await import('../state/location-identity');
    identity = await resolveLocationIdentity(
      map,
      { lng: click.lngLat.lng, lat: click.lngLat.lat },
      new AbortController().signal
    );
  } catch {
    return;
  }
  if (currentPopup !== popup || !head.isConnected) return;

  const subject = doorSubjectFromIdentity(identity);
  if (!subject) return;

  const [{ getCurrentRegion }, { buildImpactTriggerButtonHtml }] = await Promise.all([
    import('../state/region-store'),
    import('../ui/popups')
  ]);

  // `identity.state` came from `resolveState` (src/state/location-identity.ts
  // :201-222), which never reads a postal code off the thing this click
  // actually hit (there is none here; `properties` above is null): it
  // either hit-tests the rendered `states` fill at the point or, failing
  // that, walks the bundled Census polygons for the one containing it. Both
  // branches are a point-containment test against a state's OWN boundary,
  // never a property carried by the tapped feature, so this is
  // 'point-in-polygon' rather than 'feature-property' even on the
  // rendered-layer branch; `StateIdentity` (location-identity.ts) carries no
  // field distinguishing the two branches for a finer basis than that.
  const containing: ContainingPlaces =
    identity.state && isStateCode(identity.state.code)
      ? { state: identity.state.code, basis: 'point-in-polygon' }
      : { state: null, basis: 'none' };

  const context: BoundarySelectionContext = {
    kind: subject.kind,
    title: subject.title,
    properties: null,
    lngLat: { lng: click.lngLat.lng, lat: click.lngLat.lat },
    regionKey: getCurrentRegion(),
    containing
  };

  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildImpactTriggerButtonHtml(subject.title);
  const button = wrapper.firstElementChild;
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener('click', () => {
    openImpactPanel(context);
    dismissResponse();
  });

  // The same head order a place-bearing commit uses, before the "Other map
  // features here" disclosure: in a framed head the actions slot (after
  // the source, PF3); in a legacy head directly after the title.
  const actions = head.querySelector('[data-popup-slot="actions"]');
  const title = head.querySelector('.popup-title');
  if (actions) actions.appendChild(button);
  else if (title) title.after(button);
  else head.appendChild(button);
}

/**
 * The frame's DOM contract, checked on the markup itself (a model this
 * module serialized, or a legacy answer's own framed markup): the
 * content is exactly one `[data-popup-frame]` root (nothing beside it but
 * whitespace) whose only child NODES, text included, are the head region,
 * then the body region (the frame module writes no text between them, so
 * this is stricter than the identify-paths validator, which also allows
 * whitespace there). Detaches the root and returns it with its regions; null means
 * legacy content (a broken frame then renders unframed, which the
 * identify-paths observer fails once its builder has left the allowance).
 */
function takeFrame(raw: HTMLElement): { root: HTMLElement; head: HTMLElement; body: HTMLElement } | null {
  const root = raw.firstElementChild as HTMLElement | null;
  const head = root?.children[0] as HTMLElement | undefined;
  const body = root?.children[1] as HTMLElement | undefined;
  if (
    raw.childElementCount !== 1 ||
    !root?.matches('[data-popup-frame]') ||
    root.childNodes.length !== 2 ||
    !head?.matches('[data-popup-region=head]') ||
    !body?.matches('[data-popup-region=body]') ||
    raw.textContent?.trim() !== root.textContent?.trim()
  ) {
    return null;
  }
  root.remove();
  return { root, head, body };
}

/**
 * The escape hatch: a quiet disclosure listing every lower-priority
 * hit as a plain button. Native `details` keeps it keyboard and touch
 * reachable; choosing an entry replaces the primary response in place
 * (never a second popup). A group-capable target's several groups are
 * likewise never a second popup: they are sections inside the one
 * response (ClickTargetSpec.group), and the group hit is one entry here
 * like any other target.
 */
function buildDisclosure(
  map: maplibregl.Map,
  hits: readonly Hit[],
  others: readonly Hit[],
  click: CoordinatorClick
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'popup-other-features';

  const summary = document.createElement('summary');
  summary.textContent = `Other map features here (${others.length})`;
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'popup-other-list';
  for (const other of others) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'popup-other-item';
    button.textContent = other.label;
    button.addEventListener('click', () => {
      commit(map, hits, other, click);
    });
    list.appendChild(button);
  }
  details.appendChild(list);
  return details;
}

/**
 * Close the coordinator's current response, wherever it is presented
 * (the map popup or the installed sink). The sink path clears the
 * response's place selection only if still current, exactly as the
 * popup's close handler does, so a rapid follow-up selection is never
 * clobbered by a late dismissal. A commit still waiting for the frame is
 * retired too: a dismissal wins over it.
 */
export function dismissResponse(): void {
  pendingCommit = null;
  const popup = currentPopup;
  currentPopup = null;
  popup?.remove();
  if (sinkPresented) {
    sinkPresented = false;
    const sel = sinkSelection;
    sinkSelection = null;
    sink?.dismiss();
    if (sel && getPlaceSelection() === sel) setPlaceSelection(null);
  }
}
