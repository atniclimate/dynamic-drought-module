/**
 * The two Wildfire 3D ground switches in the console (owner, DR-199): plant
 * stress and fuel risk, each on until a person turns it off. Session state
 * only: nothing here is written to the address bar or kept past a reload.
 * Each layer follows its own switch (src/layers/wildfire-dryness.ts,
 * src/layers/whp-3d.ts); this module knows nothing about the map.
 */

export type Fire3DGroundLayer = 'plantStress' | 'fuelRisk';

const shown: Record<Fire3DGroundLayer, boolean> = { plantStress: true, fuelRisk: true };
const listeners = new Set<(layer: Fire3DGroundLayer) => void>();

/** Whether the layer is switched on. */
export function getFire3DGroundLayer(layer: Fire3DGroundLayer): boolean {
  return shown[layer];
}

/** Switch one layer; setting the current value again notifies nobody. */
export function setFire3DGroundLayer(layer: Fire3DGroundLayer, on: boolean): void {
  if (shown[layer] === on) return;
  shown[layer] = on;
  listeners.forEach((fn) => {
    fn(layer);
  });
}

/** Subscribe to switch changes, told which layer changed. Returns an unsubscribe function. */
export function onFire3DGroundLayerChange(fn: (layer: Fire3DGroundLayer) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
