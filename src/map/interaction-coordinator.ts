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
import { placeRefFromBoundary } from '../config/entities';
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

/** The click location a response builder receives. */
export interface CoordinatorClick {
  readonly lngLat: maplibregl.LngLat;
  readonly point: maplibregl.Point;
}

/** What a committed target renders and establishes. */
export interface CoordinatedResponse {
  /** Popup content: an HTML string or a prebuilt DOM element. */
  readonly content: string | HTMLElement;
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
}

const specs: ClickTargetSpec[] = [];
const specByLayerId = new Map<string, ClickTargetSpec>();
let currentPopup: maplibregl.Popup | null = null;
let initialized = false;

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
  popup.once('close', () => {
    if (currentPopup === popup) currentPopup = null;
  });
  currentPopup = popup;
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
  const taken = new Set<ClickTargetSpec>();

  for (const [order, feature] of features.entries()) {
    const spec = specByLayerId.get(feature.layer.id);
    if (!spec || taken.has(spec)) continue;
    const label = spec.label(feature);
    if (label === null) continue;
    taken.add(spec);
    hits.push({
      spec,
      feature,
      label,
      kind: isSelectedPlace(feature, label) ? 'selected-place' : spec.kind,
      order
    });
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
 * re-commits it in place (the former primary joins the disclosure).
 */
function commit(
  map: maplibregl.Map,
  hits: readonly Hit[],
  primary: Hit,
  click: CoordinatorClick
): void {
  const response = primary.spec.respond(primary.feature, click, map);
  if (!response) {
    const rest = hits.filter((h) => h !== primary);
    if (rest.length > 0) commit(map, rest, rest[0]!, click);
    else dismissResponse();
    return;
  }

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

  // The active mobile Brief sheet is its own response surface: a
  // place-bearing tap answers at the half detent (the at-hand block),
  // and no popup paints (the shipped U2 route, moved here from
  // attachImpactTrigger). Non-place responses keep their popups: the
  // map is the instrument for those.
  if (selection && response.selection && isSheetActive() && getViewMode() === 'brief') {
    dismissResponse();
    openImpactPanel(response.selection);
    return;
  }

  renderPopup(map, response, selection, hits, primary, click);
}

function renderPopup(
  map: maplibregl.Map,
  response: CoordinatedResponse,
  selection: PlaceSelection | null,
  hits: readonly Hit[],
  primary: Hit,
  click: CoordinatorClick
): void {
  dismissResponse();

  const container = document.createElement('div');
  container.className = 'coordinated-response';

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
  if (typeof response.content === 'string') raw.innerHTML = response.content;
  else raw.appendChild(response.content);

  const head = document.createElement('div');
  head.className = 'coordinated-response-head';
  const body = document.createElement('div');
  body.className = 'coordinated-response-body';

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

  // The escape hatch sits at the foot of the frozen head, below the door.
  const others = hits.filter((h) => h !== primary);
  if (others.length > 0) {
    head.appendChild(buildDisclosure(map, hits, others, click));
  }

  container.appendChild(head);
  container.appendChild(body);

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
      title: title?.textContent ?? null,
      placeBearing: true
    });
    if (presented) {
      sinkPresented = true;
      sinkSelection = selection;
      return;
    }
  }

  const popup = new maplibregl.Popup({
    closeButton: true,
    ...response.popupOptions,
    className: 'ddm-coordinated-popup',
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
    if (currentPopup === popup) currentPopup = null;
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
    containing,
    place: placeRefFromBoundary(subject.kind, null)
  };

  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildImpactTriggerButtonHtml(subject.title);
  const button = wrapper.firstElementChild;
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener('click', () => {
    openImpactPanel(context);
    dismissResponse();
  });

  // The same head order a place-bearing commit uses: directly after the
  // title, before the "Other map features here" disclosure.
  const title = head.querySelector('.popup-title');
  if (title) title.after(button);
  else head.appendChild(button);
}

/**
 * The escape hatch: a quiet disclosure listing every lower-priority
 * hit as a plain button. Native `details` keeps it keyboard and touch
 * reachable; choosing an entry replaces the primary response in place
 * (never a second popup).
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
 * clobbered by a late dismissal.
 */
export function dismissResponse(): void {
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
