import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import type maplibregl from 'maplibre-gl';
import { createMap } from './map/init';
import { initInteractionCoordinator } from './map/interaction-coordinator';
import { setMap } from './state/map-store';
import { applyDeepLink } from './state/deep-link';
import { parseSelectParam } from './state/url';
import type { SelectParam } from './state/url';
import { getStudioRoute, onStudioRouteChange } from './state/studio-route';
import { onTypedPlaceChange } from './state/typed-place';
import { buildSidebar } from './ui/sidebar';
import { initHoverInspector } from './ui/hover-inspector';
import { initMapKey } from './ui/map-key';
import { initMobileSheet } from './ui/mobile-sheet';
import { initViewShell } from './ui/view-shell';
import { initPlaceEmphasis } from './state/place-emphasis';
import { initLocatedBoundary } from './state/located-boundary';
import { initHistoricalGround } from './map/historical-ground';

/**
 * Dynamic Drought Module (DDM) boot.
 *
 * The orchestrator is intentionally thin: create the MapLibre instance,
 * wait for it to load, attach popup click handlers for any layer that
 * declares one, then hand off to the sidebar. The sidebar reads the URL
 * parameters, applies the region selection, activates default-on layers,
 * and wires every event the user can trigger from the chrome (region
 * radiogroup, layer toggles, telemetry list, share button, reset button,
 * sidebar collapse and expand, viewport resize). The layer registry
 * (`src/state/registry.ts`) is the single source of truth for "which
 * layers are on" and propagates changes to the URL sync layer and the
 * sidebar pills.
 */

/**
 * Hold a boot-time select command while a studio owns the route. This listener
 * is armed before the sidebar initializes route state, so it observes a
 * select-bearing popstate before the sidebar's canonical URL write removes
 * the one-shot parameter.
 */
function prepareStudioAwareDeepLink(
  map: maplibregl.Map,
  initialSelect: SelectParam
): () => void {
  interface InFlightCommand {
    readonly select: SelectParam;
    readonly routeGeneration: number;
  }

  let heldSelect: SelectParam | null = initialSelect;
  let inFlight: InFlightCommand | null = null;
  let routeGeneration = 0;
  let started = false;
  let disposed = false;
  let unsubscribeRoute: (() => void) | null = null;
  let unsubscribeTypedPlace: (() => void) | null = null;

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeRoute?.();
    unsubscribeTypedPlace?.();
  };

  const runHeld = (): void => {
    if (!started || disposed || getStudioRoute() !== null || !heldSelect) return;
    const command: InFlightCommand = {
      select: heldSelect,
      routeGeneration
    };
    heldSelect = null;
    inFlight = command;
    void applyDeepLink(
      map,
      command.select,
      () =>
        getStudioRoute() === null &&
        routeGeneration === command.routeGeneration
    ).finally(() => {
      if (inFlight === command) inFlight = null;
      if (heldSelect && getStudioRoute() === null) {
        runHeld();
      } else if (!heldSelect && !inFlight) {
        cleanup();
      }
    });
  };

  unsubscribeRoute = onStudioRouteChange((route, source) => {
    routeGeneration += 1;
    const interrupted = inFlight;
    if (interrupted) {
      inFlight = null;
      if (route !== null && heldSelect === null) {
        heldSelect = interrupted.select;
      }
    }

    if (source === 'popstate' && (heldSelect !== null || interrupted !== null)) {
      const navigationSelect = parseSelectParam();
      if (navigationSelect) heldSelect = navigationSelect;
    }

    if (route === null) runHeld();
  });

  unsubscribeTypedPlace = onTypedPlaceChange((place) => {
    if (!place || getStudioRoute() !== 'place') return;
    routeGeneration += 1;
    heldSelect = null;
    inFlight = null;
    cleanup();
  });

  return () => {
    if (started) return;
    started = true;
    if (getStudioRoute() === null) {
      cleanup();
      void applyDeepLink(map, initialSelect);
      return;
    }
    runHeld();
  };
}

async function boot(): Promise<void> {
  // The build's source commit and per-run nonce, readable by any
  // browser run (T1-0 receipt integrity): a verification suite asserts
  // these against the commit and run it BELIEVES it is testing, so an
  // exit code can never again silently describe the wrong server's
  // build (the nonce distinguishes two servers on the same commit).
  document.documentElement.dataset.ddmBuildSha = __DDM_BUILD_SHA__;
  document.documentElement.dataset.ddmBuildNonce = __DDM_BUILD_NONCE__;

  const map = createMap('map');
  // Publish the map so the frozen UI-service facades (the impact panel) can
  // resolve a selection's location identity without a map parameter (F3).
  setMap(map);

  // Development-only handle for manual and automated testing in the browser
  // console (for example projecting a feature to a pixel, or driving the map
  // during a Playwright verification). `import.meta.env.DEV` is statically
  // replaced with `false` in the production build, so this block is dead-code
  // eliminated from `dist/`; no debug handle ships. Not application logic.
  if (import.meta.env.DEV) {
    const devWindow = window as unknown as {
      __ddmMap?: maplibregl.Map;
      __ddmResolveIdentity?: (lng: number, lat: number) => Promise<unknown>;
    };
    devWindow.__ddmMap = map;
    // Resolve the location identity for a point (R1 browser verification):
    // window.__ddmResolveIdentity(lng, lat) returns the resolved identity.
    devWindow.__ddmResolveIdentity = async (lng, lat) => {
      const { resolveLocationIdentity } = await import('./state/location-identity');
      return resolveLocationIdentity(map, { lng, lat }, new AbortController().signal);
    };
  }

  await new Promise<void>((resolve) => {
    if (map.loaded()) {
      resolve();
      return;
    }
    map.once('load', () => resolve());
  });

  // Reveal the shared historical ground only after a bounded known-data
  // probe. OSM is already visible underneath, so boot and failure both retain
  // a usable map. Recent NOAA imagery remains a separate URL-backed mode.
  const disposeHistoricalGround = initHistoricalGround(map);
  map.once('remove', disposeHistoricalGround);

  // Click targets register with the InteractionCoordinator on a layer's
  // FIRST activation (the layer-controller's bindPopups seam), not up
  // front, so a layer's module and its click wiring arrive together in
  // the same lazy chunk. Registration order never matters: the
  // coordinator arbitrates by the semantic precedence table, and one
  // registration survives later toggle-off and toggle-on cycles.

  // Capture the one-shot `select` deep link BEFORE the sidebar boots: the
  // sidebar's first syncUrl rewrites the URL and deliberately drops the
  // parameter, so it must be read first (order is load-bearing).
  const select = parseSelectParam();
  const startStudioAwareDeepLink = select
    ? prepareStudioAwareDeepLink(map, select)
    : null;

  buildSidebar(map, () => {
    // Region-change observer hook. The sidebar handles fitBounds, the
    // active radio button, and URL sync internally; this callback is here
    // for any future analytics or cross-module subscriber that wants to
    // observe region transitions without coupling to the sidebar.
  });

  // The InteractionCoordinator (D-0.7.0-058 ruling 5): one map click,
  // one response. Layers register their click targets lazily (in their
  // bindPopups, on first activation); the one arbitrating click handler
  // binds here so no per-layer handler can ever stack a second popup.
  initInteractionCoordinator(map);

  // The hover inspector (UX-4) reads what is under the cursor from the active
  // layers. Pointer-only; it is inert on touch devices.
  initHoverInspector(map);

  // The on-map drought key (0.3.0 design pass): the opening view and the
  // embed answer "what do the colors mean" without the sidebar legend.
  initMapKey();

  // Selected-place emphasis (U3h, headroom A1): the chosen boundary stays lit
  // while its popup or briefing is open. This wires only the close seam (clear
  // on place-selection null); the set side lives in the coordinator's
  // place-bearing commits and the search-locate path.
  initPlaceEmphasis(map);

  // The located-boundary highlight (U3d): when the search jumps to a Tribal
  // land area, it lights that live-fetched geometry so it reads regardless of
  // the BIA layer's viewport; this wires the clear-on-close seam.
  initLocatedBoundary(map);

  // The ENSO driver line (0.4.0 B2): the one-line climate-driver read under
  // the conditions strip, from the bundled snapshot. Hidden on any failure.
  void import('./ui/enso-driver').then(
    ({ buildEnsoDriver }) => buildEnsoDriver(),
    () => undefined
  );

  // The mobile bottom sheet (U2, D-0.7.0-017): below 720px the sidebar
  // becomes the one three-detent sheet; never in embed. Before the view
  // shell, so a Brief boot finds the sheet already seated at half. The
  // at-hand place picker is the ONE shared search (U3), which the sheet
  // mounts lazily on activation, so no deep-link/impact-panel callback is
  // injected here anymore.
  initMobileSheet(map, { deepLinkBoot: select !== null });

  // The two doors (U1, D-ARCH-002): mode chrome and the Brief head, after
  // the sidebar (which seeds the mode from the URL). The U1 answer-first
  // boot open is retired (S2, D-0.7.0-041: no unsolicited briefing); the
  // `select=` deep link below is the only boot-time briefing opener.
  initViewShell(map);

  // Applied after the sidebar so the deep link's fitBounds supersedes the
  // region framing; async, so a slow bundled-data fetch never blocks boot.
  // A studio route holds the command until its one-step return to the map.
  if (startStudioAwareDeepLink) startStudioAwareDeepLink();
  else void applyDeepLink(map, select);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void boot();
  });
} else {
  void boot();
}
