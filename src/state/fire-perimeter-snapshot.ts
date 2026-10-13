/**
 * The fire perimeters the flat layer (src/layers/nifc-fires.ts) last put on
 * the map, published by that layer for the 3D ribbon and the fuel-risk drape.
 * They follow it here instead of reading the map back, and import no layer
 * module so they stay in their own lazy download. The revision goes up each
 * time a different collection (or none, once the layer is off) is published.
 */

import type { FeatureCollection } from 'geojson';

export interface FirePerimeterSnapshot {
  readonly collection: FeatureCollection | null;
  readonly revision: number;
}

let snapshot: FirePerimeterSnapshot = { collection: null, revision: 0 };
const listeners = new Set<() => void>();

/** Publish what the map now holds; the same object again changes nothing. */
export function setPerimeterSnapshot(collection: FeatureCollection | null): void {
  if (collection === snapshot.collection) return;
  snapshot = { collection, revision: snapshot.revision + 1 };
  listeners.forEach((fn) => {
    fn();
  });
}

export function getPerimeterSnapshot(): FirePerimeterSnapshot {
  return snapshot;
}

/** Subscribe to each new revision. Returns an unsubscribe function. */
export function onPerimeterSnapshotChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
