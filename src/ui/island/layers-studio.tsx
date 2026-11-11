/**
 * The Layer studio: what is on the map, then what can be added.
 *
 * PRESENTATION (owner direction 2026-11-09 (sprint), DR-pending). The studio
 * leads with ON THE MAP NOW: the condition surface that is on and every
 * overlay that is on, each with its honest state word at a readable size and
 * a control that turns it off. The catalog under it is what can be added;
 * there the condition surfaces are one choice (a radio group, see
 * `./catalog`) because one exclusive condition surface at a time is the
 * rule, and the overlays stay multi-select.
 *
 * Nothing here owns layer state. A row is listed while its checkbox intent
 * is on (the eager bridge, the same intent the share URL serializes); its
 * state word is the registry's own status through `resolveStatusPillText`,
 * so the six states keep their exact words; and every press goes through
 * the one layer controller, exactly as the catalog row's does. A layer whose
 * read failed stays listed as unavailable, never as on.
 */

import { render } from 'preact';
import { signal } from '@preact/signals';
import type { ReadonlySignal, Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import { LAYER_DEFS, LAYER_ROLE_ORDER } from '../../config/layers';
import type { LayerDef } from '../../config/layers';
import { registry } from '../../state/registry';
import type { LayerController } from '../../state/layer-controller';
import { backToMap } from '../../state/studio-route';
import type { LayerRole, LayerStatus } from '../../types/layer';
import { isFailedCheckedLayer, requestLayerOn } from '../layer-toggle-command';
import { Catalog } from './catalog';
import { checkedSnapshot, onCheckedChange, setChecked } from './bridge';
import { resolveStatusPillText } from './pill-text';
import { Search } from './search';
import type { SearchProps } from './search';
import { applyStudioInertScope } from './studio-inert';
import '../../styles/studios.css';

interface LayersStudioProps {
  controller: LayerController;
  checked: ReadonlySignal<ReadonlyMap<string, boolean>>;
  statuses: ReadonlySignal<ReadonlyMap<string, LayerStatus>>;
  // Optional: a search-controller chunk failure (DDM-P1-T04) degrades the
  // studio to no search box rather than to no studio at all.
  search?: SearchProps;
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

/** What kind of layer a listed row is, in one plain word. */
const ROLE_WORD: Readonly<Record<LayerRole, string>> = {
  surface: 'Condition',
  reference: 'Place',
  event: 'Event',
  stations: 'Stations'
};

/**
 * ON THE MAP NOW: every layer whose intent is on, the condition surface
 * first, each with the registry's state word and the control that turns it
 * off. A layer whose read failed keeps its intent (the controller's rule
 * for a committed view), so it is listed with the word "unavailable" and a
 * control that asks for it again; it is never presented as drawn.
 */
function OnTheMapNow({
  controller,
  checked,
  statuses
}: Pick<LayersStudioProps, 'controller' | 'checked' | 'statuses'>) {
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const on: LayerDef[] = [];
  for (const role of LAYER_ROLE_ORDER) {
    for (const def of LAYER_DEFS) {
      if (def.role === role && (checked.value.get(def.key) ?? false)) on.push(def);
    }
  }
  const hasCondition = on.some((def) => def.role === 'surface');
  // The count says what is drawn. A layer whose read failed is counted as
  // unavailable, never as on the map.
  const unavailableCount = on.filter((def) => statuses.value.get(def.key) === 'error').length;
  const drawnCount = on.length - unavailableCount;
  const countText =
    (drawnCount === 1 ? '1 layer' : `${drawnCount} layers`) +
    (unavailableCount > 0 ? `, ${unavailableCount} unavailable` : '');

  // The pressed control leaves with its row, so focus moves to the row that
  // takes its place, or to the heading when the list empties: it never
  // falls back to the page behind the studio.
  const turnOff = (def: LayerDef, button: HTMLButtonElement): void => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('.layers-now-off') ?? []
    );
    const at = buttons.indexOf(button);
    const nextKey = (buttons[at + 1] ?? buttons[at - 1])?.dataset['nowOff'] ?? null;
    setChecked(def.key, false);
    controller.deactivate(def.key);
    requestAnimationFrame(() => {
      const next = nextKey
        ? listRef.current?.querySelector<HTMLButtonElement>(`[data-now-off="${nextKey}"]`)
        : null;
      (next ?? headingRef.current)?.focus();
    });
  };

  return (
    <section class="layers-now" aria-labelledby="layers-now-heading">
      <div class="layers-now-head">
        <h3 id="layers-now-heading" ref={headingRef} tabIndex={-1}>
          On the map now
        </h3>
        <span class="layers-now-count">{countText}</span>
      </div>
      {on.length > 0 ? (
        <ul class="layers-now-list" ref={listRef}>
          {on.map((def) => {
            const status = statuses.value.get(def.key);
            const failed = isFailedCheckedLayer(def.key);
            return (
              <li key={def.key} class="layers-now-row" data-now-key={def.key} data-now-role={def.role}>
                <span class="layers-now-text">
                  <span class="layers-now-role">{ROLE_WORD[def.role]}</span>
                  <span class="layers-now-name">{def.name}</span>
                  <span
                    class={status ? `layer-toggle-status layers-now-status ${status}` : 'layer-toggle-status layers-now-status'}
                    data-now-status={def.key}
                  >
                    {status ? resolveStatusPillText(status, def.noDataLabel) : ''}
                  </span>
                </span>
                <span class="layers-now-actions">
                  {failed ? (
                    <button
                      type="button"
                      class="layers-now-retry"
                      aria-label={`Try ${def.name} again`}
                      onClick={() => requestLayerOn(def.key)}
                    >
                      Try again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="layers-now-off"
                    data-now-off={def.key}
                    aria-label={`Turn off ${def.name}`}
                    onClick={(event) => turnOff(def, event.currentTarget)}
                  >
                    Turn off
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hasCondition ? null : (
        <p class="layers-now-none">
          No condition layer is on. Choose one under Conditions to draw it.
        </p>
      )}
    </section>
  );
}

function LayersStudio({ controller, checked, statuses, search }: LayersStudioProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const telemetryHostRef = useRef<HTMLDivElement>(null);
  const basemapHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const releaseInertScope = applyStudioInertScope();

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

    // found-013: the rehosted Water & Snow list's own click handler
    // (src/ui/sidebar.ts buildTelemetryList) still flies the camera and
    // opens the station's popup underneath this full-screen overlay, so a
    // press produced no visible response. A capturing listener on the
    // rehost wrapper (ancestor of the moved #panel-telemetry, so it fires
    // BEFORE the item's own bubble-phase click handler) closes the studio
    // the same way "Back to map" does, revealing the map underneath before
    // the camera moves and the popup opens.
    const telemetryHost = telemetryHostRef.current;
    const onStationPress = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.telemetry-item')) {
        backToMap();
      }
    };
    telemetryHost?.addEventListener('click', onStationPress, true);

    return () => {
      telemetryHost?.removeEventListener('click', onStationPress, true);
      restore(basemap);
      restore(telemetry);
      releaseInertScope();
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
        {search && (
          <div class="layers-studio-search">
            <Search {...search} />
          </div>
        )}
        <div class="layers-studio-grid">
          <OnTheMapNow controller={controller} checked={checked} statuses={statuses} />
          <div class="layers-studio-catalog">
            <h3 class="layers-add-heading">Add to the map</h3>
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
  search?: SearchProps
): void {
  // NO STYLESHEET, NO STUDIO (the same check, for the same reason, as
  // mountPlaceStudio in place-studio.tsx): src/styles/studios.css marks the
  // studio roots, and a mount that does not find the mark throws before
  // anything is subscribed, which lands in the shell's "Studio unavailable".
  if (getComputedStyle(root).getPropertyValue('--ddm-studios-css').trim() !== '1') {
    throw new Error('[layers-studio] the studio stylesheet is not loaded.');
  }
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
      {...(search ? { search } : {})}
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
