import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import type * as maplibregl from 'maplibre-gl';
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
import { isGpuInitializationError, webGl2Capability } from './map/gl-capability';
import {
  hideRendererNotice,
  showRendererNotice
} from './ui/renderer-notice';
import { initMapInformation } from './ui/map-information';
import { initMobileSheet } from './ui/mobile-sheet';
import { initViewShell } from './ui/view-shell';
import { initPlaceEmphasis } from './state/place-emphasis';
import { initLocatedBoundary } from './state/located-boundary';

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

/**
 * How long boot waits for the map's `load` event before it stops holding the
 * rest of the interface hostage to it (DR-035a).
 *
 * 8 s is this project's standing single-request budget (`CATALOG_TIMEOUT_MS`,
 * `src/config/place-catalog.ts`, and the `src/util/*` fetch budgets), and a
 * healthy boot finishes well inside it even on a slow connection, so a
 * slow-but-working device does not flash the notice. The bound decides only
 * when the interface starts saying what it is actually showing: a late `load`
 * still completes the boot and clears the notice.
 */
const MAP_LOAD_BOUND_MS = 8_000;

/**
 * Resolve true when the map fires `load` within `boundMs`, false when the
 * bound expires first. Never rejects: a boot must not fail on the question
 * of whether it can boot.
 */
function waitForMapLoad(
  map: maplibregl.Map,
  boundMs: number
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (map.loaded()) {
      resolve(true);
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, boundMs);
    map.once('load', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The on-map key rides a lazy chunk (DR-008a): it is an honesty surface, but
 * nothing can read it before a surface has rendered, so it does not belong in
 * the entry chunk. Called from an already-async boot path, so the dynamic
 * import costs a microtask, not a round of blocking work.
 */
function loadMapKey(): void {
  void import('./ui/map-key')
    .then(({ initMapKey }) => {
      initMapKey();
    })
    .catch((err: unknown) => {
      console.error('[boot] the on-map key failed to load:', err);
    });
}

/**
 * The chrome that needs no renderer: the on-map key and the map-information
 * disclosure, which is where the OpenStreetMap and per-source attribution
 * lives. Booted on the degraded paths (DR-035a) so a map that never paints
 * still leaves a reachable, honest interface rather than a complete-looking
 * skeleton. Idempotent.
 */
let mapFreeChromeBooted = false;
function bootMapFreeChrome(): void {
  if (mapFreeChromeBooted) return;
  mapFreeChromeBooted = true;
  loadMapKey();
  initMapInformation();
}

async function boot(): Promise<void> {
  // The build's source commit and per-run nonce, readable by any
  // browser run (T1-0 receipt integrity): a verification suite asserts
  // these against the commit and run it BELIEVES it is testing, so an
  // exit code can never again silently describe the wrong server's
  // build (the nonce distinguishes two servers on the same commit).
  document.documentElement.dataset.ddmBuildSha = __DDM_BUILD_SHA__;
  document.documentElement.dataset.ddmBuildNonce = __DDM_BUILD_NONCE__;

  // DR-025a / DR-035a: MapLibre 6 requires WebGL 2 and has no WebGL 1
  // fallback, so ask first. Without a context the constructor would build a
  // map that can never paint and would only report it through an error
  // event, so the honest move is not to construct one at all: say what was
  // observed and boot the chrome that needs no renderer.
  const capability = webGl2Capability();
  if (!capability.webgl2) {
    console.warn(
      `[boot] no WebGL 2 context: ${capability.reason ?? 'unknown'}`
    );
    showRendererNotice('no-webgl2');
    bootMapFreeChrome();
    return;
  }

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

  // MapLibre 6 reports a failed GPU context through the map's `error` event
  // rather than a constructor throw (`Map._setupPainter` fires an ErrorEvent
  // carrying a GPUInitializationError). Only that error means "this browser
  // cannot render the map"; routine tile and source errors travel the same
  // event and must not raise a renderer notice, so the classifier is narrow.
  let gpuInitializationFailed = false;
  map.on('error', (event) => {
    if (!isGpuInitializationError(event.error)) return;
    gpuInitializationFailed = true;
    showRendererNotice('no-webgl2');
    bootMapFreeChrome();
  });

  const loadedInBound = await waitForMapLoad(map, MAP_LOAD_BOUND_MS);
  if (loadedInBound) {
    wireMapDependentChrome(map);
    return;
  }

  // DR-035a: the bound expired. Say so, and stop blocking the chrome. A GPU
  // initialization error already said something more specific about this
  // browser, and the weaker statement must not overwrite it.
  showRendererNotice(gpuInitializationFailed ? 'no-webgl2' : 'not-rendering');
  bootMapFreeChrome();
  map.once('load', () => {
    hideRendererNotice();
  });

  if (map.isStyleLoaded() === true) {
    // The style is in hand and only the painting is stalled (a hidden or
    // occluded window throttles requestAnimationFrame to nothing, so `load`
    // never fires even though everything loaded). Sources and layers can be
    // added safely, so the full interface is wired now and the notice stands
    // until a frame actually renders.
    wireMapDependentChrome(map);
    return;
  }

  // The style is not in hand, so adding a source or a layer would throw.
  // Wait on, passively and without a second bound: nothing is blocked on
  // this now, and the interface is already saying what it is showing.
  map.once('load', () => {
    wireMapDependentChrome(map);
  });
}

/**
 * Everything that genuinely needs a live map. Split out of `boot` so the
 * chrome can come up without it (DR-035a) and so a late `load` can still
 * complete the boot from either degraded path.
 */
function wireMapDependentChrome(map: maplibregl.Map): void {
  hideRendererNotice();

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
  // embed answer "what do the colors mean" without the sidebar legend. Lazy
  // under DR-008a; it renders a microtask later and nothing waits on it.
  loadMapKey();

  // The mobile information disclosure mirrors the active key, governed layer
  // names, sources, and six-state registry without creating durable map state.
  initMapInformation();

  // The desktop 3D Fire mode (W3/W4) rides its own lazy chunk behind the
  // shell's desktop breakpoint, so a mobile boot never fetches it. A boot
  // below the breakpoint arms a one-shot widen listener instead: the mode's
  // toggle only renders on desktop widths, and a later resize into them
  // must find a live controller rather than an inert control.
  const fire3dViewport = window.matchMedia('(min-width: 721px)');
  const loadFire3D = (): void => {
    void import('./map/fire3d').then(({ initFire3DController }) => {
      initFire3DController(map);
    });
  };
  if (fire3dViewport.matches) {
    loadFire3D();
  } else {
    const onWiden = (): void => {
      if (!fire3dViewport.matches) return;
      fire3dViewport.removeEventListener('change', onWiden);
      loadFire3D();
    };
    fire3dViewport.addEventListener('change', onWiden);
  }

  // Selected-place emphasis (U3h, headroom A1): the chosen boundary stays lit
  // while its popup or briefing is open. This wires only the close seam (clear
  // on place-selection null); the set side lives in the coordinator's
  // place-bearing commits and the search-locate path.
  initPlaceEmphasis(map);

  // The located-boundary highlight (U3d): when the search jumps to a Tribal
  // land area, it lights that live-fetched geometry so it reads regardless of
  // the BIA layer's viewport; this wires the clear-on-close seam.
  initLocatedBoundary(map);

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
