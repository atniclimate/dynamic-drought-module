import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The look at 4237781, R1-2: a searched Tribal land area lost its highlight as
 * its briefing opened, because the briefing writes its own selection (a new
 * object, the same place) and the overlay cleared on every selection change.
 * A write for the same label keeps it; a close or a different subject still
 * clears it (the U3 stage-5 major 4 fix, tests/u3-stage5-fixes.spec.ts).
 * Red on 4237781: the same-label write removes both layers.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const { showLocatedBoundary, initLocatedBoundary } = await import('../src/state/located-boundary.ts');
const { setPlaceSelection } = await import('../src/state/place-selection.ts');

function fakeMap() {
  const layers = new Set();
  const sources = new Set();
  const map = {
    getSource: (id) => (sources.has(id) ? { setData() {} } : undefined),
    addSource: (id) => sources.add(id),
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => (layers.has(id) ? {} : undefined),
    addLayer: (spec) => layers.add(spec.id),
    removeLayer: (id) => layers.delete(id)
  };
  return { map, layers };
}

const GEOM = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const selection = (label) => ({ label, context: { title: label } });

test('the briefing taking over the searched place keeps its highlight; a new subject or a close clears it', () => {
  const { map, layers } = fakeMap();
  const dispose = initLocatedBoundary(map);
  try {
    setPlaceSelection(selection('Fixture Land Area'));
    showLocatedBoundary(map, GEOM);
    assert.equal(layers.size, 2);

    setPlaceSelection(selection('Fixture Land Area'));
    assert.equal(layers.size, 2, 'the briefing writing the same place keeps the highlight');

    setPlaceSelection(selection('Another Place'));
    assert.equal(layers.size, 0, 'a different subject clears it');

    setPlaceSelection(selection('Fixture Land Area'));
    showLocatedBoundary(map, GEOM);
    setPlaceSelection(null);
    assert.equal(layers.size, 0, 'a close clears it');
  } finally {
    dispose();
    setPlaceSelection(null);
  }
});
