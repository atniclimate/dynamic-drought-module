/**
 * The door to the ENSO chain (owner direction 2026-11-09 (sprint),
 * DR-pending). The sea surface temperature layer calls it from its own
 * activate and deactivate (src/layers/sst-anomaly.ts), exactly where it
 * starts and stops the flow overlay, so the chain exists while the ENSO
 * surface is on the map and at no other time. This module is small and rides
 * the layer's lazy chunk; the chain itself (src/ui/enso-chain.ts, with the
 * shared link component, the gauges and the index module) is a further
 * dynamic import, so a session that never opens ENSO downloads none of it.
 *
 * An embed has no sidebar and no phone column, so nothing is loaded there.
 * Leaving the embed (its expand control) loads it then.
 *
 * A failed load says so in one line, as the 3D Fire view does
 * (src/ui/fire3d-phone.ts), and the next activation asks again under a new
 * URL (src/util/chunk-retry.ts). The map and its key never wait on this chunk.
 *
 * The layer announces the date of the frame it displays as an event with no
 * replay (`ddm:sst-snapshot`), and the chain arrives a moment after the layer
 * does. This module listens from the start and hands the date over, so the
 * chain never misses the frame it has to name.
 */

import type * as maplibregl from 'maplibre-gl';

import { createChunkLoader } from '../util/chunk-retry';
import { showToast } from './overlay';

type ChainModule = typeof import('./enso-chain');

/** Mirrors src/layers/sst-anomaly.ts `SST_SNAPSHOT_EVENT`. */
const SST_SNAPSHOT_EVENT = 'ddm:sst-snapshot';

/** The one line a failed load says. GUIDE_NAME in src/ui/enso-chain.ts names the guide. */
const UNAVAILABLE = 'ENSO guide unavailable; the map and its key are unaffected.';

const loadChain = createChunkLoader(() => import('./enso-chain'), import.meta.url);

/**
 * The guide's own host (mountEnsoChain in src/ui/enso-chain.ts draws only
 * into #app and the sidebar's scroll). Where neither exists there is no
 * guide to miss, so a failed load there says nothing.
 */
function guideHostExists(): boolean {
  return (
    document.getElementById('app') !== null &&
    document.querySelector('#sidebar .sidebar-scroll') !== null
  );
}

let generation = 0;
let chain: ChainModule | null = null;
let frameDate: string | null = null;
let embedWatch: MutationObserver | null = null;

function onSstSnapshot(event: Event): void {
  const detail = (event as CustomEvent<{ status?: unknown; date?: unknown } | null>).detail;
  frameDate = detail?.status === 'ready' && typeof detail.date === 'string' ? detail.date : null;
  chain?.setEnsoChainFrameDate(frameDate);
}

/** Start the chain for this activation of the surface. Idempotent per activation. */
export function activateEnsoChain(map: maplibregl.Map): void {
  deactivateEnsoChain();
  const mine = ++generation;
  window.addEventListener(SST_SNAPSHOT_EVENT, onSstSnapshot);
  const start = (): void => {
    void loadChain()
      .then((module) => {
        // A deactivate while the chunk was in flight wins: nothing mounts late.
        if (mine !== generation) return;
        chain = module;
        module.mountEnsoChain(map, frameDate);
      })
      .catch((error: unknown) => {
        console.error('[enso-chain] the chain failed to load:', error);
        // Said only while the surface is still on the map, where the guide draws.
        if (mine === generation && guideHostExists()) showToast(UNAVAILABLE);
      });
  };
  const app = document.getElementById('app');
  if (app?.classList.contains('embed')) {
    embedWatch = new MutationObserver(() => {
      if (mine !== generation || app.classList.contains('embed')) return;
      embedWatch?.disconnect();
      embedWatch = null;
      start();
    });
    embedWatch.observe(app, { attributes: true, attributeFilter: ['class'] });
    return;
  }
  start();
}

/** The surface left the map: remove the chain and stand down any pending load. */
export function deactivateEnsoChain(): void {
  generation += 1;
  window.removeEventListener(SST_SNAPSHOT_EVENT, onSstSnapshot);
  embedWatch?.disconnect();
  embedWatch = null;
  chain?.unmountEnsoChain();
  chain = null;
  frameDate = null;
}
