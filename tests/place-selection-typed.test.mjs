import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * DR-099 (DDM-P2-T13): a place picked on the map replaces the durable typed
 * place the Place studio opens on, newest intent wins (the look of
 * 2026-11-05, D11: pick Oregon in the studio, go back to the map, click
 * Nevada, reopen the studio, and it showed Oregon).
 *
 * The map's click door, the search and the `select=` deep link all write the
 * popup-scoped selection through `setPlaceSelection`; these cases drive that
 * one door and read the durable store the studio mounts from.
 *
 * Red on base (6748f25): the durable place stays Oregon after the Nevada
 * click. Plain `node --test` (Node 24 strips types).
 */

// The product modules import each other without extensions; append `.ts`
// to a relative, extensionless specifier whose `.ts` target exists
// (tests/briefing-truth.test.mjs, the same hook).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { setPlaceSelection, standingBriefingDoor } = await import('../src/state/place-selection.ts');
const { getTypedPlace, onTypedPlaceChange, setTypedPlace } = await import('../src/state/typed-place.ts');

function selection(kind, title, properties) {
  return {
    label: title,
    context: {
      kind,
      title,
      properties,
      lngLat: { lng: -117, lat: 39 },
      regionKey: null,
      containing: { state: null, basis: 'none' }
    }
  };
}

const OREGON = { kind: 'state', id: 'OR', label: 'Oregon' };

test.beforeEach(() => {
  setPlaceSelection(null);
  setTypedPlace(OREGON);
});

test('a state clicked on the map replaces the studio place (pick Oregon, click Nevada, reopen: Nevada)', () => {
  setPlaceSelection(selection('state', 'Nevada', { STUSPS: 'NV', NAME: 'Nevada' }));
  assert.deepEqual(getTypedPlace(), { kind: 'state', id: 'NV', label: 'Nevada' });
  // The popup closing clears only the popup-scoped selection.
  setPlaceSelection(null);
  assert.deepEqual(getTypedPlace(), { kind: 'state', id: 'NV', label: 'Nevada' });
});

test('an ecoregion click names the catalog code, Level IV before Level III', () => {
  setPlaceSelection(selection('ecoregion', 'Cascades', { US_L3CODE: '4', US_L3NAME: 'Cascades' }));
  assert.deepEqual(getTypedPlace(), { kind: 'ecoregion', id: '4', label: 'Cascades' });
  setPlaceSelection(
    selection('ecoregion', 'Western Cascades Lowlands and Valleys', { US_L3CODE: '4', US_L4CODE: '4a' })
  );
  assert.deepEqual(getTypedPlace(), {
    kind: 'ecoregion',
    id: '4a',
    label: 'Western Cascades Lowlands and Valleys'
  });
});

test('the same place again (the studio exit opening its own briefing) does not rewrite the store', () => {
  let writes = 0;
  const stop = onTypedPlaceChange(() => {
    writes += 1;
  });
  setPlaceSelection(selection('state', 'Oregon', { STUSPS: 'OR', NAME: 'Oregon' }));
  stop();
  assert.equal(writes, 0);
  assert.equal(getTypedPlace(), OREGON);
});

test('a watershed click names its HUC code, HUC4 before HUC2, padded as the studio catalog pads it', () => {
  setPlaceSelection(selection('watershed', 'Kootenai-Pend Oreille-Spokane', { huc4: '1701', name: 'Kootenai-Pend Oreille-Spokane' }));
  assert.deepEqual(getTypedPlace(), { kind: 'watershed', id: '1701', label: 'Kootenai-Pend Oreille-Spokane' });
  setPlaceSelection(null);
  assert.deepEqual(getTypedPlace(), { kind: 'watershed', id: '1701', label: 'Kootenai-Pend Oreille-Spokane' });
  // A numeric HUC2 reads as the catalog's two-digit code (src/config/place-catalog.ts pads it).
  setPlaceSelection(selection('watershed', 'New England Region', { huc2: 1, name: 'New England Region' }));
  assert.deepEqual(getTypedPlace(), { kind: 'watershed', id: '01', label: 'New England Region' });
});

test('a watershed code the studio catalog cannot hold leaves the studio place', () => {
  setPlaceSelection(selection('watershed', 'Somewhere', { huc4: '17x1' }));
  setPlaceSelection(selection('watershed', 'Somewhere', { huc2: '170101' }));
  setPlaceSelection(selection('watershed', 'Somewhere', { name: 'Somewhere' }));
  assert.equal(getTypedPlace(), OREGON);
});

test('a hazard-surface popup reads the selected place for its door and leaves the studio place', () => {
  // A condition or event tap never calls setPlaceSelection (interaction-coordinator.ts `finish`
  // writes only a response's place); its door only reads the selection.
  setPlaceSelection(selection('watershed', 'Kootenai-Pend Oreille-Spokane', { huc4: '1701' }));
  const typed = getTypedPlace();
  let writes = 0;
  const stop = onTypedPlaceChange(() => {
    writes += 1;
  });
  assert.deepEqual(standingBriefingDoor(), [{ kind: 'briefing', place: 'Kootenai-Pend Oreille-Spokane' }]);
  stop();
  assert.equal(writes, 0);
  assert.equal(getTypedPlace(), typed);
});

test('a place with no catalog code, or a kind the studio reaches only through the roster crosswalk, leaves the studio place', () => {
  setPlaceSelection(selection('state', 'Somewhere', {}));
  setPlaceSelection(selection('bia-reservation', 'Yakama', { LARNAME: 'Yakama' }));
  setPlaceSelection(selection('aiannh', 'Yakama Nation Reservation', { AIANNHNS: '01384291' }));
  assert.equal(getTypedPlace(), OREGON);
});
