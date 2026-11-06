import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The look at 6748f25, P3-14: a BIA reservation popup titled the land area
 * ("Yakama", "Colville", "Navajo") where the search and the Place studio name
 * the Nation. The layer's click target now reads the shared names-only roster
 * (src/state/tribal-roster.ts) through its provenance gate, the one search and
 * the place catalog use (DR-094): a trusted row's Nation name titles the
 * popup, an untrusted row keeps its land-area label, and until the roster
 * loads (or if it fails) the land area titles it as before.
 *
 * The Impact Briefing that popup opens, and the label the selected-place
 * match compares, take the same name from the same map (src/impact/context.ts).
 * Red on 1589964: the selection title stays the LARNAME.
 *
 * The REAL bia-reservations.ts with the coordinator's registration recorded,
 * the Conditions block stubbed (it reads the map) and `fetch` answering the
 * roster. Red on 6748f25: the popup title is the LARNAME.
 */

const STUBS = {
  '/map/interaction-coordinator': 'export function registerClickTarget(t) { (globalThis.__biaTargets ??= []).push(t); }',
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

const bia = await import('../src/layers/bia-reservations.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');

const ROSTER = {
  areas: [
    { larName: 'Fixture Trusted Area', displayName: 'Fixture Trusted Nation', provenance: 'safe-match' },
    { larName: 'Fixture Untrusted Area', displayName: 'Fixture Unverified Nation Name', provenance: 'unverified' }
  ]
};

test('the BIA popup titles the gated Nation name once the roster loads, and the land area before it', async () => {
  const requests = [];
  const original = globalThis.fetch;
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  globalThis.fetch = (input) => {
    requests.push(String(input));
    return answered.then(() => new Response(JSON.stringify(ROSTER), { headers: { 'content-type': 'application/json' } }));
  };
  try {
    const map = { on() {}, getCanvas: () => ({ style: {} }) };
    bia.bindPopups(map);
    const [target] = globalThis.__biaTargets;
    assert.equal(target.kind, 'reservation-boundary', 'the click rank is unchanged');
    assert.ok(requests.some((url) => url.endsWith('data/tribal-roster.json')), 'the roster is asked for when the popup binds');
    const click = { lngLat: { lng: -120, lat: 46 }, point: { x: 0, y: 0 } };
    const respond = (larName) =>
      target.respond({ id: 1, layer: { id: 'bia-reservations-fill' }, properties: { LARNAME: larName }, geometry: null }, click, map);
    const title = (larName) => /data-popup-slot="title"[^>]*>([^<]*)</.exec(serializePopupFrame(respond(larName).model))[1];
    const label = (larName) => target.label({ properties: { LARNAME: larName } });
    // Before the roster lands: the land area, as before, in the popup, the briefing and the label.
    assert.equal(title('Fixture Trusted Area'), 'Fixture Trusted Area');
    assert.equal(respond('Fixture Trusted Area').selection.title, 'Fixture Trusted Area');
    assert.equal(label('Fixture Trusted Area'), 'Fixture Trusted Area');
    answer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(title('Fixture Trusted Area'), 'Fixture Trusted Nation');
    assert.equal(title('Fixture Untrusted Area'), 'Fixture Untrusted Area', 'an untrusted row keeps its land-area label');
    assert.equal(title('Fixture Unlisted Area'), 'Fixture Unlisted Area');

    // The Impact Briefing the popup opens is titled by the same formal name (its
    // landTitle, the sidebar door's "See what this means for ..." and the
    // selection label all read context.title), with the land area beside the
    // source in the subtitle, worded as the search words it.
    const trusted = respond('Fixture Trusted Area').selection;
    assert.equal(trusted.title, 'Fixture Trusted Nation');
    assert.equal(trusted.areaLabel, 'Land area: Fixture Trusted Area');
    assert.equal(trusted.kind, 'bia-reservation', 'the source kind (its subtitle) is unchanged');
    const untrusted = respond('Fixture Untrusted Area').selection;
    assert.equal(untrusted.title, 'Fixture Untrusted Area', 'an untrusted row titles the briefing by its land area');
    assert.equal(untrusted.areaLabel, undefined);
    // The selected-place match: the coordinator stores the selection under
    // response.selection.title and promotes a later hit whose label is the
    // exact same string, so the label moves with the title.
    assert.equal(label('Fixture Trusted Area'), trusted.title);
    assert.equal(label('Fixture Untrusted Area'), untrusted.title);
  } finally {
    globalThis.fetch = original;
  }
});
