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

/**
 * Audit round 5, R5-38: one Nation title can cover several land areas (the
 * gated roster names five areas "Minnesota Chippewa Tribe"), so the overlay is
 * matched by the place's own code, not its title. Red on 0ffe87a: a click on a
 * second area under the same title kept the first area's highlight.
 */
test('a different land area under the same Nation title clears the highlight; the same area keeps it', () => {
  const { map, layers } = fakeMap();
  const dispose = initLocatedBoundary(map);
  const area = (code) => ({
    label: 'Fixture Nation',
    context: { title: 'Fixture Nation', place: { scheme: 'bia', code } }
  });
  try {
    setPlaceSelection(area('1001'));
    showLocatedBoundary(map, GEOM);
    setPlaceSelection(area('1001'));
    assert.equal(layers.size, 2, 'the same area written again keeps the highlight');

    setPlaceSelection(area('1002'));
    assert.equal(layers.size, 0, 'another area under the same title clears it');
  } finally {
    dispose();
    setPlaceSelection(null);
  }
});

/**
 * Audit round 5 review: the condition door's briefing carries no place code,
 * only the title and area label search uses, so a code-only key cleared the
 * searched place's highlight. Red before the fix: the uncoded write cleared it.
 */
test('an uncoded briefing on the searched place keeps the highlight; another area name clears it', () => {
  const { map, layers } = fakeMap();
  const dispose = initLocatedBoundary(map);
  const coded = {
    label: 'Fixture Nation',
    context: { title: 'Fixture Nation', areaLabel: 'Land area: Fixture Land Area', place: { scheme: 'bia', code: '1001' } }
  };
  const uncoded = (areaLabel) => ({ label: 'Fixture Nation', context: { title: 'Fixture Nation', areaLabel } });
  try {
    setPlaceSelection(coded);
    showLocatedBoundary(map, GEOM);
    setPlaceSelection(uncoded('Land area: Fixture Land Area'));
    assert.equal(layers.size, 2, 'the condition door on the same land area keeps the highlight');

    setPlaceSelection(uncoded('Land area: Another Land Area'));
    assert.equal(layers.size, 0, 'the same title on another land area clears it');
  } finally {
    dispose();
    setPlaceSelection(null);
  }
});
