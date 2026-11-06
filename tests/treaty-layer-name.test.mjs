import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit round 2, R2-29: the Treaty layer read its feature name with a `??`
 * chain, so an empty string in an earlier key (a converted shapefile's
 * blank field) hid the real name in a later one. The outline then took the
 * default colour and the label and popup read "Treaty Area". The layer now
 * takes the name the briefing resolves (src/impact/context.ts), which skips
 * blank values. Red on 035eed5: the colour is the default and the label is
 * "Treaty Area".
 *
 * The REAL treaty.ts, with the coordinator's registration recorded and the
 * Conditions block stubbed (it reads the map); `fetch` answers the deployer
 * file.
 */

const STUBS = {
  '/map/interaction-coordinator': 'export function registerClickTarget(t) { (globalThis.__treatyTargets ??= []).push(t); }',
  '/ui/popup-conditions':
    'export function buildPlaceConditionsHtml() { return { head: [{ label: "Conditions", text: "Fixture conditions." }], rows: [], hasWarning: false, warningLabel: null }; }'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(STUBS).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const treaty = await import('../src/layers/treaty.ts');
const { TREATY_COLORS, TREATY_COLOR_DEFAULT } = await import('../src/config/palette.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');

const BLANK_FIRST = { name: '', TREATY_NAME: 'Treaty of Point Elliott' };

test('a blank earlier name key does not hide the Treaty name from the colour, the label or the popup', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: BLANK_FIRST, geometry: null }] }), {
      headers: { 'content-type': 'application/json' }
    });
  try {
    let data = null;
    const map = {
      getLayer: () => undefined,
      getSource: () => undefined,
      addSource: (_id, source) => { data = source.data; },
      addLayer() {},
      on() {},
      getCanvas: () => ({ style: {} })
    };
    await treaty.activate(map);
    const pointElliott = TREATY_COLORS.find((entry) => entry.match === 'Point Elliott').color;
    assert.equal(data.features[0].properties._color, pointElliott);

    treaty.bindPopups(map);
    const [target] = globalThis.__treatyTargets;
    assert.equal(target.label({ properties: BLANK_FIRST }), 'Treaty of Point Elliott');
    const click = { lngLat: { lng: -122, lat: 47 }, point: { x: 0, y: 0 } };
    const answer = target.respond({ id: 1, properties: BLANK_FIRST, geometry: null }, click, map);
    assert.equal(/data-popup-slot="title"[^>]*>([^<]*)</.exec(serializePopupFrame(answer.model))[1], 'Treaty of Point Elliott');
    assert.equal(answer.selection.title, 'Treaty of Point Elliott');

    // A feature with no name at all keeps the default colour.
    data = null;
    treaty.deactivate(map);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }] }));
    await treaty.activate(map);
    assert.equal(data.features[0].properties._color, TREATY_COLOR_DEFAULT);
  } finally {
    globalThis.fetch = original;
  }
});
