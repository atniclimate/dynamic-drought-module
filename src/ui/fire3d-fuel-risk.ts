/**
 * The Wildfire console's one "Fuel risk" switch (src/ui/island/fire3d-control.tsx).
 *
 * On the flat Wildfire map it turns on the catalog's USFS Wildfire Hazard
 * Potential surface, drawn as white of increasing opacity by class by its own
 * adapter (src/layers/usfs-whp.ts). In the 3D scene, while the scene's white
 * drape is mounted (src/layers/whp-3d.ts), it shows or hides that drape, as
 * it always has. Pure and DOM-free so Node can prove the decisions.
 */

/** The flat USFS Wildfire Hazard Potential surface (src/config/layers.ts). */
export const FLAT_FUEL_RISK_KEY = 'usfs-whp';

/**
 * One name for one feature: the button's word ("Fuel risk") joined to the
 * catalog's layer name, on the button's tooltip and on the key section the
 * button adds, so a person can follow it to the layer list.
 */
export const FUEL_RISK_TITLE = 'Fuel risk: USFS Wildfire Hazard Potential';

/**
 * Which fire-family sections the map key draws, or null when neither the
 * SPC outlook nor the potential layer is eligible (the later surfaces, and
 * the NIFC-only Fire key, keep their own precedence in src/ui/map-key.ts).
 * Fuel risk turned on over Wildfire adds the potential section to the Fire
 * key rather than replacing it, since the display is Wildfire plus one layer.
 */
export function fireKeySections(
  eligible: ReadonlySet<string>
): { readonly fire: boolean; readonly whp: boolean } | null {
  const whp = eligible.has(FLAT_FUEL_RISK_KEY) || eligible.has('usfs-whp-classes');
  if (!whp && !eligible.has('spc-fire-weather')) return null;
  return { fire: eligible.has('spc-fire-weather') || eligible.has('nifc-fires'), whp };
}

/** What the switch acts on, or null when there is nothing to switch. */
export type FuelRiskSwitch = 'drape' | 'flat' | null;

export function fuelRiskSwitch(input: {
  readonly sceneActive: boolean;
  readonly drapeMounted: boolean;
  readonly cluster: string;
  readonly flatOn: boolean;
}): FuelRiskSwitch {
  if (input.sceneActive && input.drapeMounted) return 'drape';
  // Long Range: the committed Wildfire recipe is the flat layer itself.
  if (input.cluster === 'wildfire' && input.flatOn) return null;
  return 'flat';
}

/**
 * Whether the console is offered. Turning the flat layer on adds a layer to
 * the Wildfire recipe, so the display honestly reads custom (the URL carries
 * `layers=`); the console stays so the same switch can turn it off.
 */
export function fuelRiskKeepsConsole(
  cluster: string,
  selectedHazard: string,
  flatOn: boolean
): boolean {
  return cluster === 'wildfire' || (cluster === 'custom' && selectedHazard === 'wildfire' && flatOn);
}

/**
 * Pixels to scroll a panel down so an element's bottom shows, never moving
 * its top above the panel's top. The sidebar scrolls by contract
 * (tests/s4-layout-spike.spec.ts), so a control that grows below the fold
 * is brought up; the panel is scrolled directly rather than through
 * scrollIntoView, which would also scroll a page that frames this app.
 */
export function revealScroll(
  el: { readonly top: number; readonly bottom: number },
  box: { readonly top: number; readonly bottom: number }
): number {
  return Math.max(0, Math.min(el.bottom - box.bottom, el.top - box.top));
}

/**
 * Whether the control block may scroll the sidebar to reveal itself. Never on
 * its first run (page load: the scroll carried the horizon chips under the
 * sticky mode row). Later, a person who turned 3D on gets the reveal; without
 * 3D only a changed Fuel risk row does.
 */
export function shouldRevealScroll(input: {
  readonly firstRun: boolean;
  readonly sceneRequested: boolean;
  readonly fuelRowChanged: boolean;
}): boolean {
  return !input.firstRun && (input.sceneRequested || input.fuelRowChanged);
}
