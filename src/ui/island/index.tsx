/**
 * Island mount (ADR 0002, D-0.7.0-021): the layers catalog and the
 * conditions strip as Preact components, mounted into the static
 * containers inside `.sidebar-scroll` (#layer-toggles and
 * #conditions-metrics).
 *
 * This module (and everything Preact) is loaded via dynamic import from
 * `buildSidebar`, so the framework rides a lazy chunk and the app entry
 * chunk stays under the 45 kB gzip gate (ADR 0002 condition 1). The
 * eager side keeps working before the mount lands: checkbox intent
 * buffers in `./bridge`, and the registry is the source of truth this
 * module snapshots at mount.
 *
 * The island talks ONLY to `src/state/layer-controller.ts` (activation),
 * the registry events, the timeline store, and the map's settle events;
 * zero imports from `src/layers/`, `src/impact/`, or any layer module.
 *
 * The island lives for the app lifetime; its map observers stop when the
 * map is removed.
 */

import { render } from 'preact';
import { signal } from '@preact/signals';
import type * as maplibregl from 'maplibre-gl';

import { LAYER_DEFS } from '../../config/layers';
import type { LayerStatus } from '../../types/layer';
import { registry } from '../../state/registry';
import { timeline } from '../../state/timeline';
import type { LayerController } from '../../state/layer-controller';
import { checkedSnapshot, onCheckedChange } from './bridge';
import { Catalog } from './catalog';
import { ConditionsStrip } from './conditions-strip';
import { CONDITIONS_METRIC_SOURCES } from './strip-metrics';
import { Search } from './search';
import type { SearchProps } from './search';
import { mountShell } from './shell';
import { mountPanelResponse } from './panel-response';

/**
 * Mirror of the registry's per-key status map. Rebuilt wholesale on
 * every registry event (about fifteen keys; cheap and simple): a
 * `status-change` writes a status, and a `change` after deactivate
 * CLEARS one (the registry deletes the stored status so getStatus reads
 * "off"), which is exactly why the mirror re-reads instead of patching.
 */
function statusSnapshot(): ReadonlyMap<string, LayerStatus> {
  const m = new Map<string, LayerStatus>();
  for (const def of LAYER_DEFS) {
    const s = registry.getStatus(def.key);
    if (s) m.set(def.key, s);
  }
  return m;
}

export function mountSidebarIsland(
  map: maplibregl.Map,
  controller: LayerController,
  searchProps?: SearchProps
): void {
  const checked = signal<ReadonlyMap<string, boolean>>(checkedSnapshot());
  const statuses = signal<ReadonlyMap<string, LayerStatus>>(statusSnapshot());
  const tick = signal(0);

  // rAF-coalesced strip recompute, mirroring the vanilla scheduleRender:
  // a burst of settle/registry/timeline events becomes one render.
  let scheduled: number | null = null;
  let disposed = false;
  const scheduleTick = (): void => {
    if (disposed || scheduled !== null) return;
    scheduled = window.requestAnimationFrame(() => {
      scheduled = null;
      tick.value = tick.value + 1;
    });
  };

  const unsubscribers = [
    onCheckedChange(() => {
      checked.value = checkedSnapshot();
    }),
    registry.on('status-change', () => {
      statuses.value = statusSnapshot();
      scheduleTick();
    }),
    registry.on('change', () => {
      statuses.value = statusSnapshot();
      scheduleTick();
    }),
    timeline.onChange(scheduleTick)
  ];
  // Global idle waits for every source, including unrelated imagery. A
  // metric source's own data event requests a render; read after that frame
  // so newly visible polygons update even while another tile is still pending.
  let metricSourceDirty = true;
  const sourceChanged = (event: maplibregl.MapSourceDataEvent): void => {
    if (CONDITIONS_METRIC_SOURCES.has(event.sourceId)) metricSourceDirty = true;
  };
  const rendered = (): void => {
    if (!metricSourceDirty) return;
    metricSourceDirty = false;
    scheduleTick();
  };
  map.on('sourcedata', sourceChanged);
  map.on('render', rendered);
  map.on('idle', scheduleTick);
  map.on('moveend', scheduleTick);
  map.once('remove', () => {
    disposed = true;
    if (scheduled !== null) window.cancelAnimationFrame(scheduled);
    for (const unsubscribe of unsubscribers) unsubscribe();
    map.off('sourcedata', sourceChanged);
    map.off('render', rendered);
    map.off('idle', scheduleTick);
    map.off('moveend', scheduleTick);
  });

  const toggles = document.getElementById('layer-toggles');
  if (toggles) {
    render(
      <Catalog controller={controller} checked={checked} statuses={statuses} />,
      toggles
    );
  }

  const metrics = document.getElementById('conditions-metrics');
  if (metrics) {
    render(<ConditionsStrip map={map} tick={tick} checked={checked} />, metrics);
  }

  // The one search (U3d): mounted into the console catalog when the host
  // supplies its wiring. Pure props; the routing brain lives in the injected
  // search-controller, so the island keeps its no-impact-imports contract.
  const searchContainer = document.getElementById('catalog-search');
  if (searchContainer && searchProps) {
    render(<Search {...searchProps} />, searchContainer);
  }

  // The S4 main-screen shell (cluster buttons, minimap, compact WHEN
  // row, the honest display summary) and the panel-foot response sink.
  // Both ride this same lazy chunk (ADR 0002 condition 1) and mount into
  // static hosts, so a brief embed (which defers the island entirely)
  // never pays for them and never changes its shipped surface.
  const shellHost = document.getElementById('shell-island');
  if (shellHost) {
    mountShell(shellHost, map);
    // Stamp the mount so the stylesheet may retire the vanilla fallbacks
    // (#time-bar in desktop Brief) and reveal the shell panel. Until this
    // class exists the shipped controls stay: a failed or slow island
    // chunk degrades to the pre-S4 surface, never to a control-less panel.
    document.getElementById('app')?.classList.add('shell-ready');
  }
  const responseHost = document.getElementById('panel-response');
  if (responseHost) {
    mountPanelResponse(responseHost);
  }
}
