import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D D1 M26a repair (block 4; DDM-P11-T04): the block 4 reviewer's two
 * proofs (R4-1 and R4-2, read-only review file tests/review4-proofs.test.mjs
 * in the review worktree), ported as red-first cases over the real builders
 * under plain `node --test`. Every popup assertion reads the frame markup the
 * coordinator would receive (`serializePopupFrame` of the returned model).
 *
 *   - R4-1 (P2, plan_rules 3): a bundled place row the build renamed to its
 *     GNIS/BGN official form (it carries `gnis`, scripts/build-places.mjs:17-24)
 *     must not credit that name form to Natural Earth alone. Red on 4c2afb4
 *     plus M26a: `activate` drops `gnis` and the popup names only
 *     "Natural Earth (populated places)".
 *   - R4-2 (P3, design/grouping-contract.md item 3 and section 5.1): a NIFC
 *     record with neither UniqueFireIdentifier nor IRWIN id is never keyed by
 *     its name. Red on 4c2afb4 plus M26a: the key is `nifc:name:<name>`.
 *
 * The map runtime modules these layers import are stubbed (no DOM, no GL):
 * the coordinator's `registerClickTarget` records each target so the case
 * can call the layer's own `respond`.
 */
const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/map/interaction-coordinator':
    'export function registerClickTarget(t){ (globalThis.placeNifcTargets ??= []).push(t); }',
  '/map/gl-capability': 'export function mapRendererClass(){ return "webgl2"; }',
  '/ui/legend-registry':
    'export const LEGEND_ORDER={surface:1,event:2}; export function showLegend(){} export function hideLegend(){} export function renderSwatchLegend(){}',
  '/ui/time-bar':
    'export function setTimeBar(){} export function clearTimeBar(){} export function getTimeBarSpec(){return null;} export function onTimeBarSpecChange(){return ()=>{};} export function timeBarOwner(){return null;}'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
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
globalThis.window = globalThis;
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const places = await import('../src/layers/places.ts');
const nifc = await import('../src/layers/nifc-fires.ts');

/** The crosswalk's own source words (scripts/data/hi-gnis-crosswalk.json `_source`). */
const GNIS_SOURCE = JSON.parse(readFileSync(new URL('../scripts/data/hi-gnis-crosswalk.json', import.meta.url), 'utf8'))._source;

/** The text of one `data-popup-slot` in the markup, or undefined. */
function slot(html, name) {
  return html.match(new RegExp(`data-popup-slot="${name}"[^>]*>([^<]*)<`))?.[1];
}

test('R4-1: a GNIS-renamed place label does not credit its name form to Natural Earth alone', async () => {
  // The shipped bundle row (public/data/us-places.json): Natural Earth spells
  // it "Lihue"; the bundle carries the GNIS/BGN official form and its GNIS
  // feature id. The second row is a control the build did not rename.
  const shipped = JSON.parse(readFileSync(new URL('../public/data/us-places.json', import.meta.url), 'utf8'));
  const lihue = shipped.places.find((p) => p.gnis === '361837');
  assert.deepEqual(lihue, { name: 'Līhuʻe', lon: -159.3693, lat: 21.9756, rank: 7, gnis: '361837' }, 'the shipped Līhuʻe row');
  const bundle = {
    meta: { count: 2, retrieved: '2026-07-12' },
    places: [lihue, { name: 'Hilo', lon: -155.09, lat: 19.7297, rank: 7 }]
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(bundle), { status: 200, headers: { 'content-type': 'application/json' } });
  let data = null;
  const map = {
    getSource: () => undefined,
    getLayer: () => undefined,
    addSource: (_id, spec) => {
      data = spec.data;
    },
    addLayer() {},
    on() {},
    off() {},
    getCanvas: () => ({ style: {} })
  };
  await places.activate(map);
  places.bindPopups(map);
  const target = globalThis.placeNifcTargets.find((t) => (t.layerIds ?? []).includes('us-places-labels'));
  assert.ok(target, 'the place-label click target registered');
  const click = { point: { x: 0, y: 0 }, lngLat: { lng: -159.3693, lat: 21.9756 } };

  const renamed = data.features.find((f) => f.properties.name === 'Līhuʻe');
  const html = serializePopupFrame(target.respond(renamed, click, map).model);
  assert.match(html, /Līhuʻe/);
  assert.match(html, /GNIS/, `the popup names only: ${slot(html, 'issuer')}`);
  // Every issuer kept distinct (plan_rules 3): Natural Earth still issues the
  // point, and the name form's source is named in the crosswalk's own words.
  assert.equal(slot(html, 'issuer'), 'Issued by: Natural Earth (populated places)');
  assert.ok(html.includes(`<dd>${GNIS_SOURCE}</dd>`), `the name form's source in the crosswalk's words: ${html}`);

  // The control: a name the build did not rename credits Natural Earth alone.
  const kept = data.features.find((f) => f.properties.name === 'Hilo');
  const keptHtml = serializePopupFrame(target.respond(kept, click, map).model);
  assert.doesNotMatch(keptHtml, /GNIS/, 'a Natural Earth spelling names no GNIS source');
  assert.equal(slot(keptHtml, 'issuer'), 'Issued by: Natural Earth (populated places)');
});

test('R4-2: a NIFC record with no UniqueFireIdentifier and no IRWIN id is not keyed by its name (grouping-contract item 3)', () => {
  const context = { drought: { label: 'Drought beneath', text: 'x' }, details: [], note: 'n' };
  const model = nifc.buildNifcPopupModel({ attr_IncidentName: 'Cedar Creek', attr_IncidentSize: 10 }, context, null);
  assert.doesNotMatch(model.records[0].key, /^nifc:name:/, `record key: ${model.records[0].key}`);
  assert.doesNotMatch(model.records[0].key, /Cedar Creek/, `record key: ${model.records[0].key}`);

  // Through the layer's own click target: the stub is keyed on its feature
  // id inside the one response, under a prefix that says it is unkeyed
  // (section 4's "key plus OBJECTID within one response"; section 5.1).
  nifc.bindPopups({ on() {}, getCanvas: () => ({ style: {} }) });
  const target = (globalThis.placeNifcTargets ?? []).find((t) => (t.layerIds ?? []).includes('nifc-fires-fill'));
  assert.ok(target, 'the NIFC click target registered');
  // No layer is on the stub map, so the fire context reads its off states.
  const stubMap = { getLayer: () => undefined, queryRenderedFeatures: () => [] };
  const feature = { id: 7, properties: { attr_IncidentName: 'Cedar Creek', attr_IncidentTypeCategory: 'WF' } };
  const response = target.respond(feature, { point: { x: 0, y: 0 }, lngLat: { lng: -120.5, lat: 47.3 } }, stubMap);
  const html = serializePopupFrame(response.model);
  assert.match(html, /data-record-key="nifc:unkeyed:7"/, `the record key in ${html.match(/data-record-key="[^"]*"/)?.[0]}`);

  // The keyed forms are unchanged (section 4's record key row).
  const keyed = nifc.buildNifcPopupModel({ attr_IncidentName: 'Cedar Creek', attr_UniqueFireIdentifier: ' 2026-wafix-000123 ' }, context, null);
  assert.equal(keyed.records[0].key, 'nifc:2026-WAFIX-000123');
  const irwin = nifc.buildNifcPopupModel({ attr_IncidentName: 'Cedar Creek', attr_IrwinID: '{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}' }, context, null);
  assert.equal(irwin.records[0].key, 'nifc:irwin:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
});
