import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import { createMap } from './map/init';
import { REGIONS, DEFAULT_REGION, regionToMapLibreBounds } from './config/regions';

import * as ecoregions from './layers/ecoregions';
import * as tribal from './layers/tribal';
import * as treaty from './layers/treaty';
import * as drought from './layers/drought';

/**
 * Phase B boot.
 *
 * M1 scaffold + M2 map init + M3 (Ecoregions, Tribal, Treaty) + M4 (Drought)
 * landed. Region selection, telemetry markers, hydrography, full URL state,
 * and the sidebar UI are pending in M5-M8; for the milestone-tranche check-in
 * we boot the map, fit the default region, and pre-activate the four ported
 * layers + their popups so a maintainer running `npm run dev` can verify
 * each layer behaves as expected before later milestones touch them.
 *
 * Default-on follows the vanilla baseline (Tribal Lands), plus the toggle-
 * only Drought Outlook (so the tranche-1 reviewer can see drought tiles
 * without needing the sidebar UI). Ecoregions and Treaty layers stay
 * inactive at boot per the vanilla `defaultOn: false`; their popup handlers
 * are still wired so they light up on toggle (which arrives in M8).
 */

async function boot(): Promise<void> {
  const map = createMap('map');

  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', () => resolve());
  });

  const region = REGIONS[DEFAULT_REGION];
  const [west, south, east, north] = regionToMapLibreBounds(region);
  map.fitBounds(
    [
      [west, south],
      [east, north]
    ],
    { padding: 20, animate: false }
  );

  // Bind popup click handlers up front; MapLibre tolerates binding against
  // a layer ID that does not yet exist, and the handlers no-op when the
  // associated layer has not been activated.
  ecoregions.bindPopups(map);
  tribal.bindPopups(map);
  treaty.bindPopups(map);

  // Pre-activate the layers we want visible on first paint. Default-on per
  // the vanilla baseline + Drought as a tranche-1 verification surface.
  // Failures are reported to the layer's own console.info; do not let a
  // single layer reject break the rest of the boot.
  await Promise.allSettled([
    tribal.activate(map),
    drought.activate(map)
  ]);

  // Ecoregions and Treaty are toggle-only per the vanilla `defaultOn: false`.
  // Calling activate here is a developer affordance during the M2-M4 review;
  // it can be removed once M8 wires the real toggle UI.
  await Promise.allSettled([
    ecoregions.activate(map),
    treaty.activate(map)
  ]);

  // Expose for ad-hoc DevTools poking during the tranche review. Removed
  // once M7 wires the LayerRegistry.
  (window as unknown as { __ddmMap?: unknown }).__ddmMap = map;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void boot();
  });
} else {
  void boot();
}
