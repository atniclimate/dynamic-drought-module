import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import type maplibregl from 'maplibre-gl';
import { createMap } from './map/init';
import { setMap } from './state/map-store';
import { applyDeepLink } from './state/deep-link';
import { parseSelectParam } from './state/url';
import { buildSidebar } from './ui/sidebar';
import { initHoverInspector } from './ui/hover-inspector';
import { initMapKey } from './ui/map-key';
import { buildEnsoDriver } from './ui/enso-driver';
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

async function boot(): Promise<void> {
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

  // Popup click handlers are bound on a layer's FIRST activation (in the
  // sidebar's activate path), not up front, so a layer's module and its popup
  // wiring arrive together in the same lazy chunk. MapLibre tolerates a handler
  // bound before its layer exists, and binding once (guarded in the sidebar)
  // survives later toggle-off and toggle-on cycles, matching the old boot-time
  // behavior without forcing every layer module into the initial bundle.

  // Capture the one-shot `select` deep link BEFORE the sidebar boots: the
  // sidebar's first syncUrl rewrites the URL and deliberately drops the
  // parameter, so it must be read first (order is load-bearing).
  const select = parseSelectParam();

  buildSidebar(map, () => {
    // Region-change observer hook. The sidebar handles fitBounds, the
    // active radio button, and URL sync internally; this callback is here
    // for any future analytics or cross-module subscriber that wants to
    // observe region transitions without coupling to the sidebar.
  });

  // The hover inspector (UX-4) reads what is under the cursor from the active
  // layers. Pointer-only; it is inert on touch devices.
  initHoverInspector(map);

  // The on-map drought key (0.3.0 design pass): the opening view and the
  // embed answer "what do the colors mean" without the sidebar legend.
  initMapKey();

  // Selected-place emphasis (U3h, headroom A1): the chosen boundary stays lit
  // while its popup or briefing is open. This wires only the close seam (clear
  // on place-selection null); the set side lives in each boundary layer's click
  // handler and the U3 search-locate path.
  initPlaceEmphasis(map);

  // The located-boundary highlight (U3d): when the search jumps to a Tribal
  // land area, it lights that live-fetched geometry so it reads regardless of
  // the BIA layer's viewport; this wires the clear-on-close seam.
  initLocatedBoundary(map);

  // The ENSO driver line (0.4.0 B2): the one-line climate-driver read under
  // the conditions strip, from the bundled snapshot. Hidden on any failure.
  buildEnsoDriver();

  // The mobile bottom sheet (U2, D-0.7.0-017): below 720px the sidebar
  // becomes the one three-detent sheet; never in embed. Before the view
  // shell, so a Brief boot finds the sheet already seated at half. The
  // at-hand place picker is the ONE shared search (U3), which the sheet
  // mounts lazily on activation, so no deep-link/impact-panel callback is
  // injected here anymore.
  initMobileSheet(map);

  // The two doors (U1, D-ARCH-002): mode chrome, the Brief head, and the
  // answer-first boot. After the sidebar (which seeds the mode from the
  // URL); told about the deep link so it does not double-open a briefing.
  initViewShell(map, { hasSelectDeepLink: select !== null });

  // Applied after the sidebar so the deep link's fitBounds supersedes the
  // region framing; async, so a slow bundled-data fetch never blocks boot.
  void applyDeepLink(map, select);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void boot();
  });
} else {
  void boot();
}
