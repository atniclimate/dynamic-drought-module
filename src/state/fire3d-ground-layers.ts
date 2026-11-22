/**
 * The Wildfire 3D ground switches in the console (owner, DR-199): plant
 * stress and fuel risk, each on until a person turns it off, and live fuel
 * moisture, off until a person turns it on (owner, 2026-11-21). Session state
 * only: nothing here is written to the address bar or kept past a reload.
 * Each layer follows its own switch (src/layers/wildfire-dryness.ts,
 * src/layers/whp-3d.ts, src/layers/live-fuel-moisture.ts); this module knows
 * nothing about the map.
 *
 * Plant stress and live fuel moisture are a choice. Both draw the ground
 * white under the fuel-risk drape, so two at once would read as one brighter
 * ground that means neither: turning one on turns the other off.
 */

export type Fire3DGroundLayer = 'plantStress' | 'fuelRisk' | 'liveFuelMoisture';

const shown: Record<Fire3DGroundLayer, boolean> = { plantStress: true, fuelRisk: true, liveFuelMoisture: false };
const listeners = new Set<(layer: Fire3DGroundLayer) => void>();

/** The ground each ground gives way to; fuel risk is a drape above them and excludes nothing. */
const GIVES_WAY_TO: Partial<Record<Fire3DGroundLayer, Fire3DGroundLayer>> = {
  plantStress: 'liveFuelMoisture',
  liveFuelMoisture: 'plantStress'
};

/** Whether the layer is switched on. */
export function getFire3DGroundLayer(layer: Fire3DGroundLayer): boolean {
  return shown[layer];
}

function write(layer: Fire3DGroundLayer, on: boolean): void {
  if (shown[layer] === on) return;
  shown[layer] = on;
  listeners.forEach((fn) => {
    fn(layer);
  });
}

/**
 * Switch one layer; setting the current value again notifies nobody. Turning
 * a ground on first turns off the ground it replaces (and says so), so a
 * listener never sees both on.
 */
export function setFire3DGroundLayer(layer: Fire3DGroundLayer, on: boolean): void {
  if (shown[layer] === on) return;
  const other = GIVES_WAY_TO[layer];
  if (on && other) write(other, false);
  write(layer, on);
}

/** Subscribe to switch changes, told which layer changed. Returns an unsubscribe function. */
export function onFire3DGroundLayerChange(fn: (layer: Fire3DGroundLayer) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
