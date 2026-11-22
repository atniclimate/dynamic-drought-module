// The Node cases of u3-stage5-fixes.spec.ts, moved here because they open no page and so run in the pure lane.
import { test, expect } from './offline-test';
import type * as maplibregl from 'maplibre-gl';
import type { Polygon } from 'geojson';

import {
  showLocatedBoundary,
  clearLocatedBoundary,
  initLocatedBoundary
} from '../src/state/located-boundary';
import { setPlaceSelection } from '../src/state/place-selection';
import type { PlaceSelection } from '../src/state/place-selection';
import type { BoundarySelectionContext } from '../src/impact/types';

/** A minimal selection for driving the store in Node tests. */
function fakeSelection(label: string): PlaceSelection {
  return { label, context: { title: label } as unknown as BoundarySelectionContext };
}

// ---------------------------------------------------------------------------
// Major 4 (Node): the located-boundary highlight clears on EVERY change
// ---------------------------------------------------------------------------

test.describe('U3 stage-5: located-boundary clear seam (major 4)', () => {
  interface FakeMapState {
    layers: Set<string>;
    sources: Set<string>;
  }

  function fakeMap(): { map: maplibregl.Map; state: FakeMapState } {
    const state: FakeMapState = { layers: new Set(), sources: new Set() };
    const map = {
      getSource: (id: string) => (state.sources.has(id) ? { setData: () => undefined } : undefined),
      addSource: (id: string) => {
        state.sources.add(id);
      },
      removeSource: (id: string) => {
        state.sources.delete(id);
      },
      getLayer: (id: string) => (state.layers.has(id) ? {} : undefined),
      addLayer: (spec: { id: string }) => {
        state.layers.add(spec.id);
      },
      removeLayer: (id: string) => {
        state.layers.delete(id);
      }
    } as unknown as maplibregl.Map;
    return { map, state };
  }

  const GEOM: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

  let dispose: (() => void) | null = null;
  test.afterEach(() => {
    dispose?.();
    dispose = null;
    setPlaceSelection(null);
  });

  test('a selection CHANGE clears the highlight, not only a close to null', () => {
    const { map, state } = fakeMap();
    dispose = initLocatedBoundary(map);

    showLocatedBoundary(map, GEOM);
    expect(state.layers.size).toBe(2);

    // A NEW subject (a different briefing or popup), not a close: the stale
    // highlight must go, because it depicts the previous subject.
    setPlaceSelection(fakeSelection('Another place'));
    expect(state.layers.size).toBe(0);
    expect(state.sources.size).toBe(0);
  });

  test('the locate ordering contract: set-then-show keeps the new subject; close clears it', () => {
    const { map, state } = fakeMap();
    dispose = initLocatedBoundary(map);

    // The search-locate path opens the briefing FIRST (which sets the
    // selection and clears any stale highlight) and shows its own highlight
    // AFTER, so the new subject survives the seam.
    setPlaceSelection(fakeSelection('Located land area'));
    showLocatedBoundary(map, GEOM);
    expect(state.layers.size).toBe(2);

    // Closing the briefing nulls the selection; the highlight goes with it.
    setPlaceSelection(null);
    expect(state.layers.size).toBe(0);
  });

  test('clearLocatedBoundary is safe when nothing is shown', () => {
    const { map, state } = fakeMap();
    expect(() => clearLocatedBoundary(map)).not.toThrow();
    expect(state.layers.size).toBe(0);
  });
});
