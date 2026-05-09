import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import { createMap } from './map/init';
import { LAYER_DEFS } from './config/layers';
import { buildSidebar } from './ui/sidebar';

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

  await new Promise<void>((resolve) => {
    if (map.loaded()) {
      resolve();
      return;
    }
    map.once('load', () => resolve());
  });

  // Bind popup click handlers up front. MapLibre tolerates binding against
  // a layer ID that does not yet exist; the handlers fire once the matching
  // layer is added by the layer module's `activate`. Calling once at boot
  // means a layer can be toggled on, off, and on again without re-binding.
  for (const def of LAYER_DEFS) {
    if (def.module.bindPopups) {
      def.module.bindPopups(map);
    }
  }

  buildSidebar(map, () => {
    // Region-change observer hook. The sidebar handles fitBounds, the
    // active radio button, and URL sync internally; this callback is here
    // for any future analytics or cross-module subscriber that wants to
    // observe region transitions without coupling to the sidebar.
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void boot();
  });
} else {
  void boot();
}
