import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Round 5 audit, Tribal naming. Every name and boundary here is public data
 * (the Federal Register roster, BIA AIAN-LAR, Census AIANNH); shapes are stand-ins.
 *
 * R5-1: a failed roster read must not pin a Tribal area to its Census or
 * land-area name for the session. The roster loader forgets a failed read
 * (src/state/tribal-roster.ts), so a later search names the Nation; the click
 * name maps (impact/context) must ask again too, or a map click and the search
 * give the same place two names. Red on 0ffe87a: the second call returns the
 * first, rejected, promise, and the BIA popup keeps its bound-once copy.
 * Runs first: it needs the roster not yet loaded.
 *
 * R5-37: a legal Census area keeps its D-0.8.0-052 rank and carries the BIA
 * land area under the same point, so the condition door can name the Nation.
 * Red on 0ffe87a: no biaLandArea.
 *
 * R5-42: the BIA row credits AIAN-LAR and the Federal Register list every
 * Nation name comes from, as unrendered drafts until ddm-cite records them.
 * Red on 0ffe87a: the BIA row is name-only.
 */

// The REAL BIA layer with the coordinator's registration recorded and the Conditions block stubbed.
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

const context = await import('../src/impact/context.ts');
const { gatedCensusName, gatedDisplayName } = await import('../src/state/tribal-roster.ts');
const { resolveLocationIdentity } = await import('../src/state/location-identity.ts');
const { ACKNOWLEDGEMENTS } = await import('../src/config/acknowledgements.ts');
const biaLayer = await import('../src/layers/bia-reservations.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');

const ROSTER = JSON.parse(readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8'));
const census = ROSTER.censusAreas.find((area) => area.name === 'Creek OTSA');
const bia = ROSTER.areas.find((area) => area.provenance === 'safe-match' && area.displayName !== area.larName);

test('a failed roster read is retried by the next click name lookup, Census and BIA alike', async () => {
  assert.ok(census && bia, 'the shipped roster carries a trusted Census row and a trusted BIA row');
  const original = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
    return new Response(JSON.stringify(ROSTER), { headers: { 'content-type': 'application/json' } });
  };
  console.warn = () => {};
  try {
    // The one shared roster read fails for both maps; the BIA layer binds its popup during it.
    const map = { on() {}, getCanvas: () => ({ style: {} }) };
    biaLayer.bindPopups(map);
    const [biaTarget] = globalThis.__biaTargets;
    const biaPopupTitle = () => /data-popup-slot="title"[^>]*>([^<]*)</.exec(serializePopupFrame(biaTarget.respond(
      { id: 1, layer: { id: 'bia-reservations-fill' }, properties: { LARNAME: bia.larName }, geometry: null },
      { lngLat: { lng: -120, lat: 46 }, point: { x: 0, y: 0 } },
      map
    ).model))[1];
    const [censusFirst, biaFirst] = await Promise.allSettled([
      context.loadCensusNationNames(),
      context.loadBiaNationNames()
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(biaPopupTitle(), bia.larName, 'offline: the BIA popup titles the land area');
    assert.equal(censusFirst.status, 'rejected');
    assert.equal(biaFirst.status, 'rejected');
    assert.equal(context.censusNationNames(), undefined);
    assert.equal(context.biaNationNames(), undefined);
    assert.equal(context.resolveBoundaryTitle('aiannh', { NAME: census.name }), census.name, 'offline: the Census name');

    // A later click asks again and now names the Nation, as the search does.
    const censusNames = await context.loadCensusNationNames();
    const biaNames = await context.loadBiaNationNames();
    assert.equal(calls, 2, 'one more roster read, shared by both maps');
    assert.equal(censusNames.get(census.name), gatedCensusName(census));
    assert.equal(biaNames.get(bia.larName), gatedDisplayName(bia));
    assert.equal(context.censusNationNames(), censusNames, 'the click-time getter reads the loaded map');
    assert.equal(context.biaNationNames(), biaNames);
    assert.equal(context.resolveBoundaryTitle('aiannh', { NAME: census.name }), census.displayName);
    assert.equal(context.resolveBoundaryTitle('bia-reservation', { LARNAME: bia.larName }), bia.displayName);
    assert.equal(biaPopupTitle(), bia.displayName, 'the BIA popup reads the map at click time, not a bound-once copy');
  } finally {
    globalThis.fetch = original;
    console.warn = originalWarn;
  }
});

/** A map double whose rendered layers answer with the given features (a rendered state keeps it offline). */
function identityMap(layers) {
  const features = { 'us-states-fill': [{ properties: { STUSPS: 'WA', NAME: 'Washington' } }], ...layers };
  return {
    project: () => ({ x: 0, y: 0 }),
    getLayer: (id) => (features[id] ? { id } : undefined),
    queryRenderedFeatures: (_point, options) => (options?.layers ?? []).flatMap((id) => features[id] ?? [])
  };
}

async function containingTribal(layers) {
  const identity = await resolveLocationIdentity(identityMap(layers), { lng: -120.5, lat: 47.2 }, new AbortController().signal);
  return identity.containingTribal;
}

test('a legal Census area under a BIA land area keeps its rank and carries the BIA land area', async () => {
  const LEGAL = { properties: { NAME: 'Stand-in Census Reservation', AIANNHCC: 'D1' } };
  const STATISTICAL = { properties: { NAME: 'Stand-in Census Statistical Area', AIANNHCC: 'D6' } };
  const BIA = { properties: { LARNAME: 'Stand-in Land Area' } };
  assert.deepEqual(
    await containingTribal({ 'aiannh-fill': [LEGAL], 'bia-reservations-fill': [BIA] }),
    { name: 'Stand-in Census Reservation', source: 'aiannh', biaLandArea: 'Stand-in Land Area' }
  );
  // Without a BIA feature, nothing rides along; a statistical area still yields to BIA.
  assert.deepEqual(await containingTribal({ 'aiannh-fill': [LEGAL] }), { name: 'Stand-in Census Reservation', source: 'aiannh' });
  assert.deepEqual(
    await containingTribal({ 'aiannh-fill': [STATISTICAL], 'bia-reservations-fill': [BIA] }),
    { name: 'Stand-in Land Area', source: 'bia-reservation' }
  );
});

test('the BIA row credits AIAN-LAR and the Federal Register list, unrendered until ddm-cite records them', () => {
  const credits = ACKNOWLEDGEMENTS.bia.credits;
  assert.ok(credits.some((c) => c.text.includes('American Indian and Alaska Native Land Area Representation (AIAN-LAR)')));
  assert.ok(credits.some((c) => c.text.includes('Federal Register document 2026-01899')));
  for (const c of credits) assert.equal(c.citeId, null, 'a draft must not render (DR-147)');
});
