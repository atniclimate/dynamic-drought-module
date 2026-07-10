/**
 * The grouped layer catalog as a Preact island (ADR 0002, D-0.7.0-021).
 * Ports `buildLayerToggles` / `buildLayerToggle` and the status-pill
 * rendering from the retired vanilla builders in `src/ui/sidebar.ts`
 * with the DOM contract unchanged:
 *
 *   - real checkboxes at `input[data-layer-key=...]` (the one true door
 *     outside callers click or dispatch `change` on: usdm's
 *     switchToOutlook, drought's switchToObserved, the telemetry list;
 *     plus the Playwright helpers),
 *   - pill spans at `[data-layer-status=...]` carrying the canonical
 *     six-state text from `./pill-text` and the status word as a CSS
 *     class,
 *   - role-group headings and hints exactly as the vanilla builder
 *     rendered them (UX-1).
 *
 * State: checkbox intent comes from the eager `./bridge` store (written
 * by this island's change handler AND by the controller's view adapter,
 * one source of truth); pill statuses mirror the registry. Both arrive
 * as signals from `./index`.
 *
 * Stewardship: no Tribal, Treaty, or sovereign-jurisdiction data is
 * surfaced here. All labels come from the config tables in `src/config/`.
 */

import type { ReadonlySignal } from '@preact/signals';

import { LAYER_DEFS, LAYER_ROLE_ORDER } from '../../config/layers';
import type { LayerDef } from '../../config/layers';
import type { LayerRole, LayerStatus } from '../../types/layer';
import type { LayerController } from '../../state/layer-controller';
import { STATUS_PILL_TEXT } from './pill-text';
import { setChecked } from './bridge';

/**
 * User-facing labels for the four role groups (UX-1), moved verbatim
 * from the vanilla sidebar. The headings carry the ratified place/state
 * taxonomy: condition surfaces describe the state a place is in (one at
 * a time); references are the tactile anchor for place; events and
 * stations sit on top.
 */
const ROLE_GROUP_LABELS: Record<LayerRole, { title: string; hint: string | null }> = {
  surface: { title: 'Conditions', hint: 'one at a time' },
  reference: { title: 'Place', hint: 'boundaries & rivers' },
  event: { title: 'Events', hint: null },
  stations: { title: 'Stations', hint: null }
};

interface CatalogProps {
  controller: LayerController;
  checked: ReadonlySignal<ReadonlyMap<string, boolean>>;
  statuses: ReadonlySignal<ReadonlyMap<string, LayerStatus>>;
}

interface RowProps extends CatalogProps {
  def: LayerDef;
}

/**
 * One layer toggle row. The change handler writes the bridge intent
 * synchronously (so the controller's `isCheckboxChecked` reads the new
 * state immediately, exactly as the native checkbox gave it) and defers
 * to the layer controller, which owns the activation state machine
 * (surface exclusivity, the op chain, the intent guards, the loading
 * indicator).
 */
function LayerRow({ def, controller, checked, statuses }: RowProps) {
  const id = `layer-toggle-${def.key}`;
  const isOn = checked.value.get(def.key) ?? false;
  const status = statuses.value.get(def.key);

  const onChange = (event: Event): void => {
    const on = (event.currentTarget as HTMLInputElement).checked;
    setChecked(def.key, on);
    if (on) {
      void controller.activate(def.key);
    } else {
      controller.deactivate(def.key);
    }
  };

  return (
    <label class="layer-toggle" for={id}>
      <input
        type="checkbox"
        id={id}
        data-layer-key={def.key}
        checked={isOn}
        onChange={onChange}
      />
      <span class="layer-toggle-text">
        <span class="layer-toggle-name">{def.name}</span>
        <span class="layer-toggle-source">{def.source}</span>
        <span
          class={status ? `layer-toggle-status ${status}` : 'layer-toggle-status'}
          data-layer-status={def.key}
        >
          {status ? STATUS_PILL_TEXT[status] : ''}
        </span>
      </span>
    </label>
  );
}

/**
 * The full catalog: role groups in `LAYER_ROLE_ORDER`, entries keeping
 * their `LAYER_DEFS` order within a group, empty groups omitted.
 */
export function Catalog(props: CatalogProps) {
  return (
    <>
      {LAYER_ROLE_ORDER.map((role) => {
        const defs = LAYER_DEFS.filter((def) => def.role === role);
        if (defs.length === 0) return null;
        const label = ROLE_GROUP_LABELS[role];
        const headingId = `layer-group-${role}`;
        return (
          <div class="layer-group" role="group" aria-labelledby={headingId} key={role}>
            <div class="layer-group-title" id={headingId}>
              {label.title}
              {label.hint ? <> <span class="layer-group-hint">{label.hint}</span></> : null}
            </div>
            {defs.map((def) => (
              <LayerRow key={def.key} def={def} {...props} />
            ))}
          </div>
        );
      })}
    </>
  );
}
