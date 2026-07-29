import { parseStudioParam } from './url';

/** The bounded query-state route vocabulary for the two studios. */
export type StudioRoute = 'layers' | 'place' | null;

export type StudioRouteChangeSource = 'initialize' | 'push' | 'popstate';
type StudioRouteListener = (
  route: StudioRoute,
  source: StudioRouteChangeSource
) => void;

let route: StudioRoute = null;
let popstateBound = false;
const listeners = new Set<StudioRouteListener>();
let placeReturnAction: (() => void) | null = null;

/**
 * Physical framing is immutable for this document, so detect it eagerly.
 * Cross-origin WindowProxy access is expected to permit identity comparison,
 * but a denial is conservatively treated as framing.
 */
const physicallyFramed = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

/** Whether this document is running inside any physical frame. */
export function isPhysicallyFramed(): boolean {
  return physicallyFramed;
}

/**
 * Marker stamped on every studio history entry so the module can tell a
 * studio entry it created (button entry or a synthesized direct-boot
 * push) from an entry it did not. `syncUrl` preserves `history.state`
 * across its replaceState writes, so the marker survives in-studio URL
 * writes and reloads.
 */
interface StudioHistoryState {
  readonly ddmStudioEntry?: boolean;
}

function isStudioEntryState(): boolean {
  const state = window.history.state as StudioHistoryState | null;
  return state?.ddmStudioEntry === true;
}

function locationWithStudio(
  next: StudioRoute,
  options?: { dropOneShotSelect?: boolean }
): string {
  const url = new URL(window.location.href);
  if (next === null) url.searchParams.delete('studio');
  else url.searchParams.set('studio', next);
  if (options?.dropOneShotSelect) url.searchParams.delete('select');
  return `${url.pathname}${url.search}${url.hash}`;
}

function notify(source: StudioRouteChangeSource): void {
  for (const listener of [...listeners]) listener(route, source);
}

function routeFromLocation(): StudioRoute {
  const params = new URLSearchParams(window.location.search);
  return params.getAll('studio').length === 1
    ? parseStudioParam(params.get('studio'))
    : null;
}

/**
 * Seed the route after the rest of the map URL state has been applied.
 *
 * A DIRECT studio boot (a shared or typed `studio=` URL) has no in-app
 * map entry behind it, so `Back to map` would leave the application (or
 * do nothing in a fresh tab). Unless the entry is already one this
 * module marked (a reload inside a studio it pushed), synthesize the
 * predecessor: replace the current entry with the same URL minus
 * `studio` and the captured one-shot `select`, then push one marked studio
 * entry. Back then lands on the map exactly as it does after a button entry,
 * and route-aware deep-link handling owns the captured command. Embed and
 * physical-frame boots skip the synthesis (`synthesizeReturnEntry: false`):
 * studios never mount there, so a spare history entry would only pollute Back.
 */
export function initializeStudioRoute(
  initial: StudioRoute,
  options?: { synthesizeReturnEntry?: boolean }
): void {
  route = initial;
  if (
    route !== null &&
    options?.synthesizeReturnEntry !== false &&
    !isStudioEntryState()
  ) {
    const studioTarget = locationWithStudio(route);
    window.history.replaceState(
      window.history.state,
      '',
      locationWithStudio(null, { dropOneShotSelect: true })
    );
    window.history.pushState({ ddmStudioEntry: true }, '', studioTarget);
  }
  if (!popstateBound) {
    popstateBound = true;
    window.addEventListener('popstate', () => {
      const previous = route;
      route = routeFromLocation();
      if (previous === 'place' && route !== null) {
        // Exiting PLACE into another studio: the hand-off is void. Cleared
        // BEFORE notify so no route listener (the island unmount takes the
        // action during notify) can consume it on a studio-to-studio
        // popstate (wave A finding 3). When the exit is to the MAP (route
        // null), the action is deliberately LEFT in place for the studio
        // island's unmount cleanup to take AFTER restoreDisplaySnapshot(),
        // so the ruled restore-then-brief order holds on both exits (a
        // bare microtask here raced the lazy island's unmount: the
        // briefing could open before restore, or be cancelled by the
        // restore's intent supersede and never open).
        placeReturnAction = null;
      }
      notify('popstate');
    });
  }
  notify('initialize');
}

export function getStudioRoute(): StudioRoute {
  return route;
}

export function onStudioRouteChange(listener: StudioRouteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Enter a studio. From the map this pushes exactly ONE marked history
 * entry (D-0.7.0-049). From the OTHER studio it REPLACES the current
 * studio entry instead: the two tokens are exclusive, and stacking a
 * second entry would make one Back step return to the first studio
 * rather than the map.
 */
function enterStudio(next: Exclude<StudioRoute, null>): void {
  if (route === next) return;
  if (route === 'place') placeReturnAction = null;
  const target = locationWithStudio(next);
  if (route === null) {
    window.history.pushState({ ddmStudioEntry: true }, '', target);
  } else {
    window.history.replaceState({ ddmStudioEntry: true }, '', target);
  }
  route = next;
  notify('push');
}

export function enterLayersStudio(): void {
  enterStudio('layers');
}

export function enterPlaceStudio(): void {
  enterStudio('place');
}

/** Browser Back and the studio control share this exact one-step action. */
export function backToMap(): void {
  window.history.back();
}

/** Run one lazy PLACE callback after popstate has unmounted the studio. */
export function setPlaceStudioReturnAction(action: (() => void) | null): void {
  placeReturnAction = action;
}

/**
 * Take (and clear) the pending PLACE return action. Called by the PLACE
 * studio island's unmount cleanup AFTER restoreDisplaySnapshot(), which is
 * the only ordering that honors restore-then-brief deterministically.
 */
export function takePlaceStudioReturnAction(): (() => void) | null {
  const action = placeReturnAction;
  placeReturnAction = null;
  return action;
}

/** Build an embed link-out from the latest current URL state. */
function fullSiteStudioUrl(next: Exclude<StudioRoute, null>): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('embed');
  url.searchParams.set('studio', next);
  return url.href;
}

export function fullSiteLayersStudioUrl(): string {
  return fullSiteStudioUrl('layers');
}

export function fullSitePlaceStudioUrl(): string {
  return fullSiteStudioUrl('place');
}
