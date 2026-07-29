import { render } from 'preact';
import { signal } from '@preact/signals';
import type { ReadonlySignal, Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import { LAYER_DEFS } from '../../config/layers';
import { registry } from '../../state/registry';
import type { LayerController } from '../../state/layer-controller';
import { backToMap } from '../../state/studio-route';
import type { LayerStatus } from '../../types/layer';
import { Catalog } from './catalog';
import { checkedSnapshot, onCheckedChange } from './bridge';
import { Search } from './search';
import type { SearchProps } from './search';

interface LayersStudioProps {
  controller: LayerController;
  checked: ReadonlySignal<ReadonlyMap<string, boolean>>;
  statuses: ReadonlySignal<ReadonlyMap<string, LayerStatus>>;
  search: SearchProps;
}

interface RehostRecord {
  element: HTMLElement;
  parent: Node;
  nextSibling: ChildNode | null;
}

function moveIntoHost(element: HTMLElement | null, host: HTMLElement | null): RehostRecord | null {
  if (!element || !host || !element.parentNode) return null;
  const record: RehostRecord = {
    element,
    parent: element.parentNode,
    nextSibling: element.nextSibling
  };
  host.appendChild(element);
  return record;
}

function restore(record: RehostRecord | null): void {
  if (!record) return;
  if (record.nextSibling?.parentNode === record.parent) {
    record.parent.insertBefore(record.element, record.nextSibling);
  } else {
    record.parent.appendChild(record.element);
  }
}

function LayersStudio({ controller, checked, statuses, search }: LayersStudioProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const telemetryHostRef = useRef<HTMLDivElement>(null);
  const basemapHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const app = document.getElementById('app');
    const priorAriaHidden = app?.getAttribute('aria-hidden') ?? null;
    if (app) {
      app.inert = true;
      app.setAttribute('aria-hidden', 'true');
    }

    const telemetry = moveIntoHost(
      document.getElementById('panel-telemetry'),
      telemetryHostRef.current
    );
    const basemapButton = document.querySelector<HTMLButtonElement>('.basemap-switcher-btn');
    const basemap = moveIntoHost(
      basemapButton?.closest<HTMLElement>('.maplibregl-ctrl') ?? null,
      basemapHostRef.current
    );

    backRef.current?.focus();

    return () => {
      restore(basemap);
      restore(telemetry);
      if (app) {
        app.inert = false;
        if (priorAriaHidden === null) app.removeAttribute('aria-hidden');
        else app.setAttribute('aria-hidden', priorAriaHidden);
      }
    };
  }, []);

  return (
    <section class="layers-studio" aria-labelledby="layers-studio-heading">
      <header class="layers-studio-header">
        <button
          ref={backRef}
          type="button"
          class="layers-studio-back"
          onClick={backToMap}
        >
          Back to map
        </button>
        <h2 id="layers-studio-heading">Layer studio</h2>
        <div class="layers-studio-basemap" ref={basemapHostRef} />
      </header>
      <div class="layers-studio-scroll">
        <div class="layers-studio-search">
          <Search {...search} />
        </div>
        <div class="layers-studio-grid">
          <div class="layers-studio-catalog">
            <Catalog
              controller={controller}
              checked={checked}
              statuses={statuses}
              studio
            />
          </div>
          <div class="layers-studio-depth" ref={telemetryHostRef} />
        </div>
      </div>
    </section>
  );
}

function statusSnapshot(): ReadonlyMap<string, LayerStatus> {
  const snapshot = new Map<string, LayerStatus>();
  for (const def of LAYER_DEFS) {
    const status = registry.getStatus(def.key);
    if (status) snapshot.set(def.key, status);
  }
  return snapshot;
}

interface MountedStudio {
  checked: Signal<ReadonlyMap<string, boolean>>;
  statuses: Signal<ReadonlyMap<string, LayerStatus>>;
  unsubscribe: () => void;
}

const mounted = new WeakMap<HTMLElement, MountedStudio>();

export function mountLayersStudio(
  root: HTMLElement,
  controller: LayerController,
  search: SearchProps
): void {
  let state = mounted.get(root);
  if (!state) {
    const checked = signal<ReadonlyMap<string, boolean>>(checkedSnapshot());
    const statuses = signal<ReadonlyMap<string, LayerStatus>>(statusSnapshot());
    const unsubscribeChecked = onCheckedChange(() => {
      checked.value = checkedSnapshot();
    });
    const unsubscribeStatus = registry.on('status-change', () => {
      statuses.value = statusSnapshot();
    });
    const unsubscribeRegistry = registry.on('change', () => {
      statuses.value = statusSnapshot();
    });
    state = {
      checked,
      statuses,
      unsubscribe: () => {
        unsubscribeChecked();
        unsubscribeStatus();
        unsubscribeRegistry();
      }
    };
    mounted.set(root, state);
  }

  render(
    <LayersStudio
      controller={controller}
      checked={state.checked}
      statuses={state.statuses}
      search={search}
    />,
    root
  );
}

export function unmountLayersStudio(root: HTMLElement): void {
  render(null, root);
  const state = mounted.get(root);
  state?.unsubscribe();
  mounted.delete(root);
}
