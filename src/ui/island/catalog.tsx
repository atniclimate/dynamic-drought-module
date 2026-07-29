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
 * U3a (D-0.7.0-009 sibling; the corpus "group by user question with
 * active counts, not provider names") tightens the catalog WITHOUT
 * touching those contracts:
 *
 *   - each role group heading carries an ACTIVE COUNT ("2 on") so a
 *     person sees what is live at a glance,
 *   - the provider/source attribution collapses behind a per-group
 *     "Sources" disclosure (hidden by default; the role headings are
 *     already meaning-based, not provider-based, so the catalog no
 *     longer leads with agency names),
 *   - active rows are lit via `:has(input:checked)` (CSS only).
 *
 * State: checkbox intent comes from the eager `./bridge` store (written
 * by this island's change handler AND by the controller's view adapter,
 * one source of truth); pill statuses mirror the registry. Both arrive
 * as signals from `./index`. The per-group sources disclosure is local
 * ephemeral view state (`useState`), never a URL or registry concern.
 *
 * Stewardship: no Tribal, Treaty, or sovereign-jurisdiction data is
 * surfaced here. All labels come from the config tables in `src/config/`.
 */

import { useState } from 'preact/hooks';
import type { ReadonlySignal } from '@preact/signals';

import { LAYER_DEFS, LAYER_ROLE_ORDER, getLayerDef } from '../../config/layers';
import type { LayerDef } from '../../config/layers';
import { TRIBAL_NATIONS_PROVENANCE_NOTE } from '../../config/provenance';
import { TRIBAL_NATIONS_GROUP } from '../../config/layer-groups';
import { activateTribalNationsGroup, formatGroupHealth } from '../tribal-nations-action';
import type { LayerRole, LayerStatus } from '../../types/layer';
import type { LayerController } from '../../state/layer-controller';
import { resolveStatusPillText } from './pill-text';
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
  /** The studio has its own id namespace (the live Treaty row was retired by D-0.7.0-065). */
  studio?: boolean;
}

interface RowProps extends CatalogProps {
  def: LayerDef;
  /** Whether the group's provider attributions are revealed (U3a). */
  showSource: boolean;
  /**
   * Natively hide a ui-hidden umbrella-member row while keeping it mounted.
   * Its exact DOM contract (`data-layer-key`, `data-layer-status`) remains
   * available for read-only locators and the bridge/registry sync, while the
   * flat-list uiHidden handling below unmounts the deployer slots.
   */
  rowHidden?: boolean;
}

/**
 * One layer toggle row. The change handler writes the bridge intent
 * synchronously (so the controller's `isCheckboxChecked` reads the new
 * state immediately, exactly as the native checkbox gave it) and defers
 * to the layer controller, which owns the activation state machine
 * (surface exclusivity, the op chain, the intent guards, the loading
 * indicator).
 */
/** Session-sticky reveal for buried umbrella members (E2, D-0.7.0-058
 * ruling 4): once a ui-hidden member has been active this session, its
 * row stays visible so toggling it off remains reversible. Module-level
 * so an island remount does not re-bury an in-use row. */
const revealedThisSession = new Set<string>();

function LayerRow({
  def,
  controller,
  checked,
  statuses,
  showSource,
  rowHidden,
  studio
}: RowProps) {
  const id = `${studio ? 'studio-' : ''}layer-toggle-${def.key}`;
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
    <label class="layer-toggle" for={id} hidden={rowHidden ?? false}>
      <input
        type="checkbox"
        id={id}
        data-layer-key={def.key}
        checked={isOn}
        onChange={onChange}
      />
      <span class="layer-toggle-text">
        <span class="layer-toggle-name">{def.name}</span>
        <span
          class={status ? `layer-toggle-status ${status}` : 'layer-toggle-status'}
          data-layer-status={def.key}
        >
          {status ? resolveStatusPillText(status, def.noDataLabel) : ''}
        </span>
        {showSource ? <span class="layer-toggle-source">{def.source}</span> : null}
      </span>
    </label>
  );
}

interface UmbrellaProps extends CatalogProps {
  /** Whether the hosting role group's Sources disclosure is open (U3a). */
  readonly sourcesOpen: boolean;
}

/**
 * The Tribal Nations umbrella (D-0.7.0-033; Unit F): the featured group
 * card inside the reference role group, per the Codex front-end
 * consultation (C:\dev\_reviews\ddm\2026-07-15_unit-F-frontend-codex.md).
 * Two SEPARATE controls: the prominent activation button is a command (it
 * requests the configured live member set on through the bridge-safe
 * shared door; no aria-expanded, no aria-pressed, never disabled), and the
 * quieter "Layer details" disclosure reveals the granular member rows.
 * Member rows stay PERMANENTLY MOUNTED inside a natively `hidden` region:
 * checkboxes leave the tab order and the accessibility tree while
 * collapsed, but their DOM, signal subscriptions, and exact contract
 * (`data-layer-key`, `data-layer-status`) survive, so read-only locators
 * and the bridge/registry sync never depend on visibility. The group
 * provenance note (Unit D) renders here but stays controlled by the role
 * group's SOURCES state, not by the details disclosure (it is group
 * provenance, not a child control).
 */
function LayerUmbrella({ sourcesOpen, ...props }: UmbrellaProps) {
  const { checked, statuses, studio } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const group = TRIBAL_NATIONS_GROUP;
  const memberDefs = group.members
    .map((key) => getLayerDef(key))
    .filter((def): def is LayerDef => def !== null);
  const selectedCount = group.buttonActivates.filter(
    (key) => checked.value.get(key) ?? false
  ).length;
  // Outcome beside intent (the final-pass finding 2): a terminally failed
  // agency shows here too, in the same shared format the Brief hosts use.
  const unavailableCount = group.buttonActivates.filter(
    (key) => statuses.value.get(key) === 'error'
  ).length;
  const idPrefix = studio ? 'studio-' : '';
  const controlsId = `${idPrefix}${group.key}-layer-controls`;
  const descId = `${idPrefix}${group.key}-action-desc`;

  return (
    <div
      class="layer-umbrella"
      data-layer-group-key={group.key}
      role="group"
      aria-label={group.label}
    >
      <button
        type="button"
        class="layer-umbrella-cta"
        aria-label={`Show ${group.label} layers`}
        aria-describedby={descId}
        onClick={() => activateTribalNationsGroup()}
      >
        {group.label}
      </button>
      <p id={descId} class="sr-only">
        {group.actionDescription}
      </p>
      {/* "selected", never "live": activation may still be loading or may
          fail; the pills carry the honest per-layer status, and a terminal
          agency failure surfaces as "unavailable" right here. */}
      <p class="layer-umbrella-count" aria-live="polite">
        {formatGroupHealth(selectedCount, group.buttonActivates.length, unavailableCount)}
      </p>
      <button
        type="button"
        class="layer-umbrella-details-toggle"
        data-layer-group-toggle={group.key}
        aria-expanded={detailsOpen}
        aria-controls={controlsId}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        {detailsOpen ? 'Hide layer details' : 'Layer details'}
      </button>
      <div id={controlsId} class="layer-umbrella-controls" hidden={!detailsOpen}>
        {memberDefs.map((def) => {
          const isChecked = checked.value.get(def.key) ?? false;
          if (isChecked) revealedThisSession.add(def.key);
          return (
            <LayerRow
              key={def.key}
              def={def}
              showSource={sourcesOpen}
              rowHidden={
                def.uiHidden === true && !isChecked && !revealedThisSession.has(def.key)
              }
              {...props}
            />
          );
        })}
      </div>
      {sourcesOpen ? (
        <p class="layer-group-provenance" data-provenance="tribal-nations">
          {TRIBAL_NATIONS_PROVENANCE_NOTE}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The full catalog: role groups in `LAYER_ROLE_ORDER`, entries keeping
 * their `LAYER_DEFS` order within a group, empty groups omitted. Each
 * group carries its active count and a "Sources" disclosure (U3a). The
 * reference group leads with the Tribal Nations umbrella; its member rows
 * render inside the umbrella and nowhere else.
 */
export function Catalog(props: CatalogProps) {
  const { checked, studio = false } = props;
  // Which groups have their provider attributions revealed. Ephemeral view
  // state: a fresh Set so the default is "all collapsed" on every mount.
  const [openSources, setOpenSources] = useState<Set<LayerRole>>(() => new Set());

  const toggleSources = (role: LayerRole): void => {
    setOpenSources((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  };

  return (
    <>
      {LAYER_ROLE_ORDER.map((role) => {
        const defs = LAYER_DEFS.filter((def) => def.role === role);
        if (defs.length === 0) return null;
        const label = ROLE_GROUP_LABELS[role];
        const headingId = `${studio ? 'studio-' : ''}layer-group-${role}`;
        // The active count spans EVERY layer of the role, umbrella members
        // included: the umbrella is presentation, not a separate role.
        const onCount = defs.filter((def) => checked.value.get(def.key) ?? false).length;
        const sourcesOpen = openSources.has(role);
        const isReference = role === 'reference';
        // The umbrella members render inside the LayerUmbrella card (first
        // in the group) and nowhere else; every other row keeps its place.
        // A ui-hidden layer (the deployer own-data slots, Unit I /
        // D-0.7.0-038 part 3) renders NO row while off; when it is on (a
        // ?layers= deep link) its row appears so the state stays visible
        // and reversible.
        const grouped = isReference
          ? defs.filter((def) => !TRIBAL_NATIONS_GROUP.members.includes(def.key))
          : defs;
        const flatDefs = grouped.filter(
          (def) => !def.uiHidden || (checked.value.get(def.key) ?? false)
        );
        return (
          <div class="layer-group" role="group" aria-labelledby={headingId} key={role}>
            <div class="layer-group-title">
              {/* The group's accessible name is the title + hint only; the
                  active count sits OUTSIDE the labelledby target so the group
                  name does not mutate as layers toggle (Opus review nit). */}
              <span class="layer-group-title-text" id={headingId}>
                {label.title}
                {label.hint ? <> <span class="layer-group-hint">{label.hint}</span></> : null}
              </span>
              {onCount > 0 ? (
                <span class="layer-group-count">{onCount} on</span>
              ) : null}
            </div>
            {isReference ? <LayerUmbrella sourcesOpen={sourcesOpen} {...props} /> : null}
            {flatDefs.map((def) => (
              <LayerRow key={def.key} def={def} showSource={sourcesOpen} {...props} />
            ))}
            <button
              type="button"
              class="layer-group-sources-toggle"
              aria-expanded={sourcesOpen}
              onClick={() => toggleSources(role)}
            >
              {sourcesOpen ? 'Hide sources' : 'Sources'}
            </button>
          </div>
        );
      })}
    </>
  );
}
