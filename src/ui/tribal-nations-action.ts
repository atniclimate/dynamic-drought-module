/**
 * The eager Tribal Nations action (the umbrella build's Unit F; the Codex
 * front-end consultation Q1): the ratified "prominent button in the initial
 * display" cannot live only in the catalog, because a bare URL opens the
 * BRIEF door where no catalog exists (and a brief embed never downloads the
 * island chunk at all, headroom C1). This module supplies the compact
 * Brief-door affordance: one labeled row hosted by the impact panel's
 * static chrome, wired through the same `LayerGroupDef` action set and the
 * same bridge-safe `requestLayerOn` command the catalog umbrella uses.
 *
 * Eager-chunk discipline: this file may import ONLY eager modules (the pure
 * group config and the layer-toggle command). It must never import the
 * island entry, catalog.tsx, Preact, or the search controller; that would
 * pull the catalog chunk into the brief embed and break the C1 boundary
 * (tests/view-mode.spec.ts pins `islandRequests === []`).
 */

import { TRIBAL_NATIONS_GROUP } from '../config/layer-groups';
import { requestLayerOn } from './layer-toggle-command';
import { registry } from '../state/registry';
import { isChecked, onCheckedChange } from './island/bridge';

/**
 * Request the group's action set on, in the configured order, through the
 * shared toggle command (checkbox intent, registry, URL, and pills stay in
 * sync; already-on members are a guarded no-op). Shared by the Brief-door
 * action and the catalog umbrella button.
 */
export function activateTribalNationsGroup(): void {
  for (const key of TRIBAL_NATIONS_GROUP.buttonActivates) {
    requestLayerOn(key);
  }
}

/**
 * One shared format for the group's intent-versus-outcome line, used by the
 * Brief-door hosts (via `wireTribalNationsHealth`) and the catalog card, so
 * the wording can never drift between surfaces (the pill-text lesson).
 * "Selected" is intent (the bridge checkbox state, never a readiness
 * claim); "unavailable" is outcome (an agency that terminally failed).
 */
export function formatGroupHealth(
  selected: number,
  total: number,
  unavailable: number
): string {
  const base = `${selected} of ${total} selected`;
  return unavailable > 0 ? `${base} · ${unavailable} unavailable` : base;
}

/**
 * Aggregate health of the group's action set, from the eager bridge
 * (intent) plus the eager registry (outcome). A member counts unavailable
 * ONLY on registry status 'error': a terminally failed boot activation
 * keeps its re-asserted error status after the controller unchecks it, and
 * a failed live refresh reports error while staying checked. A valid empty
 * response ('no-data') is an ANSWER, never a failure (the Unit C wording
 * owns its presentation), so it stays out of the unavailable count.
 */
export function tribalNationsHealthText(): string {
  const total = TRIBAL_NATIONS_GROUP.buttonActivates.length;
  let selected = 0;
  let unavailable = 0;
  for (const key of TRIBAL_NATIONS_GROUP.buttonActivates) {
    if (isChecked(key)) selected += 1;
    if (registry.getStatus(key) === 'error') unavailable += 1;
  }
  return formatGroupHealth(selected, total, unavailable);
}

/**
 * Keep an element's text mirroring the group health (Codex final-pass
 * finding 2: a partial agency outage must be VISIBLE on the default Brief,
 * mobile at-hand, and brief-embed surfaces, not only inside the lazy
 * catalog's hidden details). Eager wiring only; both Brief-door hosts call
 * this once at build time.
 */
export function wireTribalNationsHealth(el: HTMLElement): void {
  const update = (): void => {
    el.textContent = tribalNationsHealthText();
  };
  update();
  onCheckedChange(update);
  registry.on('change', update);
  registry.on('status-change', update);
}

/**
 * Build the compact Brief-door action row: the visible "Tribal Nations"
 * button, its screen-reader effect description, and the visible group
 * health line. The caller owns placement (the impact panel inserts it
 * between its header and body).
 */
export function buildTribalNationsBriefAction(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tribal-nations-brief-row';

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'tribal-nations-brief-action';
  button.className = 'tribal-nations-brief-action';
  button.textContent = TRIBAL_NATIONS_GROUP.label;
  button.setAttribute('aria-label', `Show ${TRIBAL_NATIONS_GROUP.label} layers`);
  button.setAttribute('aria-describedby', 'tribal-nations-brief-action-desc');
  button.addEventListener('click', () => activateTribalNationsGroup());

  const desc = document.createElement('span');
  desc.id = 'tribal-nations-brief-action-desc';
  desc.className = 'sr-only';
  desc.textContent = TRIBAL_NATIONS_GROUP.actionDescription;

  const health = document.createElement('span');
  health.className = 'tribal-nations-health';
  health.setAttribute('aria-live', 'polite');
  wireTribalNationsHealth(health);

  row.append(button, desc, health);
  return row;
}
