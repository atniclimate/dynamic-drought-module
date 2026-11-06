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

const { setPlaceSelection } = await import('../src/state/place-selection.ts');
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

test('a place with no catalog code, or a kind the studio reaches only through the roster crosswalk, leaves the studio place', () => {
  setPlaceSelection(selection('state', 'Somewhere', {}));
  setPlaceSelection(selection('bia-reservation', 'Yakama', { LARNAME: 'Yakama' }));
  setPlaceSelection(selection('aiannh', 'Yakama Nation Reservation', { AIANNHNS: '01384291' }));
  assert.equal(getTypedPlace(), OREGON);
});
