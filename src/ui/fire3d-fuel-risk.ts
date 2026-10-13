/**
 * The Wildfire console's one "Fuel risk" switch (src/ui/island/fire3d-control.tsx).
 *
 * On the flat Wildfire map it turns on the catalog's USFS Wildfire Hazard
 * Potential surface, drawn in the issuer's own class colours by its own
 * adapter (src/layers/usfs-whp.ts). In the 3D scene, while the scene's white
 * drape is mounted (src/layers/whp-3d.ts), it shows or hides that drape, as
 * it always has. Pure and DOM-free so Node can prove the decisions.
 */

/** The flat USFS Wildfire Hazard Potential surface (src/config/layers.ts). */
export const FLAT_FUEL_RISK_KEY = 'usfs-whp';

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
