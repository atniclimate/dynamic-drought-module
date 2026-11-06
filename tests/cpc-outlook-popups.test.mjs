import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The look at 6748f25, D6: a click inside a CPC outlook area (the seasonal
 * pair and the 6-10 and 8-14 day four) opened no popup of its own; a
 * reference layer's popup answered, or nothing did. Each outlook now
 * registers one click target on its fill with the InteractionCoordinator, as
 * the CPC Drought Outlook does (src/layers/drought.ts): a condition surface,
 * so a reservation, a Tribal land or a state under the click still answers
 * first and the outlook is listed under "Other map features here".
 *
 * Drives the REAL shipped layer modules with the coordinator's registration
 * stubbed to record each target, then serializes every answer through the
 * real popup frame, as the coordinator does. Red on 6748f25: no module
 * exports `bindPopups`, so nothing registers.
 */

const STUBS = {
  '/map/interaction-coordinator': 'export function registerClickTarget(t) { (globalThis.__cpcTargets ??= []).push(t); }'
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

// The legend registry finds no legend panel here.
globalThis.document = { getElementById: () => null };

const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const { CPC_EXTENDED_COLORS, CPC_SEASONAL_COLORS } = await import('../src/config/palette.ts');

const LAYERS = [
  { key: 'cpc-seasonal-precip', name: 'Seasonal Precipitation Outlook', product: 'cpc-seasonal-precip', seasonal: true, variable: 'precipitation' },
  { key: 'cpc-seasonal-temp', name: 'Seasonal Temperature Outlook', product: 'cpcSeasonalTemp', seasonal: true, variable: 'temperature' },
  { key: 'cpc-610-precip', name: '6-10 Day Precipitation Outlook', product: 'cpc-610-precip', seasonal: false, variable: 'precipitation' },
  { key: 'cpc-610-temp', name: '6-10 Day Temperature Outlook', product: 'cpc-610-temp', seasonal: false, variable: 'temperature' },
  { key: 'cpc-814-precip', name: '8-14 Day Precipitation Outlook', product: 'cpc-814-precip', seasonal: false, variable: 'precipitation' },
  { key: 'cpc-814-temp', name: '8-14 Day Temperature Outlook', product: 'cpc-814-temp', seasonal: false, variable: 'temperature' }
];

const bound = [];
const map = {
  on(type, layer) { bound.push(`${type}:${layer}`); },
  getCanvas: () => ({ style: {} })
};
for (const layer of LAYERS) {
  const module = await import(`../src/layers/${layer.key}.ts`);
  assert.equal(typeof module.bindPopups, 'function', `${layer.key} exports bindPopups`);
  module.bindPopups(map);
}
const targets = globalThis.__cpcTargets ?? [];
const targetFor = (key) => targets.find((t) => t.layerIds.includes(`${key}-fill`));
const feature = (key, properties) => ({ layer: { id: `${key}-fill` }, properties });
const SEASONAL_CLOCK = { valid_seas: 'NDJ 2026-2027', fcst_date: Date.UTC(2026, 9, 15) };
const EXTENDED_CLOCK = { fcst_date: Date.UTC(2026, 10, 6), start_date: Date.UTC(2026, 10, 14), end_date: Date.UTC(2026, 10, 20) };
const hex = ([r, g, b]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

test('each of the six outlooks registers one condition-surface target on its own fill, and a hover cursor', () => {
  assert.equal(targets.length, LAYERS.length);
  for (const layer of LAYERS) {
    const target = targetFor(layer.key);
    assert.ok(target, `${layer.key} registered`);
    assert.equal(target.kind, 'condition-surface', 'ranked under every boundary (src/config/interaction-ranks.ts)');
    assert.deepEqual(target.layerIds, [`${layer.key}-fill`]);
    assert.ok(bound.includes(`mouseenter:${layer.key}-fill`) && bound.includes(`mouseleave:${layer.key}-fill`));
  }
});

test('every drawn class answers a framed popup naming the class as the key words it and the issuer clocks as the key labels them', () => {
  for (const layer of LAYERS) {
    const target = targetFor(layer.key);
    const classes = (layer.seasonal ? CPC_SEASONAL_COLORS : CPC_EXTENDED_COLORS)[layer.variable];
    for (const row of classes) {
      const props = { cat: row.cat, prob: row.prob, ...(layer.seasonal ? SEASONAL_CLOCK : EXTENDED_CLOCK) };
      assert.equal(target.label(feature(layer.key, props)), `${layer.name}: ${row.label}`);
      const answer = target.respond(feature(layer.key, props), { lngLat: { lng: -120, lat: 47 }, point: { x: 0, y: 0 } }, map);
      assert.ok(answer && answer.model, `${layer.key} ${row.label} answers a model`);
      assert.equal(answer.selection, undefined, 'an outlook is not a place: it never sets the place selection');
      const { model } = answer;
      assert.equal(model.kind, 'surface');
      assert.equal(model.title, layer.name);
      assert.deepEqual(model.issuer, { role: 'issued-by', name: 'NOAA Climate Prediction Center', productKey: layer.product });
      assert.equal(model.value[0].text, row.label);
      if (row.color[3] === 0) assert.equal(model.value[0].swatch, undefined, 'Equal Chances is drawn clear');
      else assert.deepEqual(model.value[0].swatch, { table: layer.seasonal ? 'CPC_SEASONAL_COLORS' : 'CPC_EXTENDED_COLORS', classKey: `${row.cat},${row.prob}`, color: hex(row.color) });
      assert.deepEqual(model.clocks.map((c) => [c.label, c.meaning]), layer.seasonal
        ? [['Valid Season', 'valid'], ['Forecast Date', 'issued']]
        : [['Start Date', 'valid'], ['End Date', 'valid'], ['Forecast Date', 'issued']]);
      // The frame accepts it (a refused model throws PopupFrameError).
      const markup = serializePopupFrame(model);
      assert.match(markup, /data-popup-kind="surface"/);
      assert.ok(markup.includes(layer.name));
      if (layer.seasonal) {
        assert.ok(markup.includes('NDJ 2026-2027'), 'the season as the issuer states it');
        assert.ok(markup.includes('<time datetime="2026-10-15">'));
      } else {
        for (const date of ['2026-11-14', '2026-11-20', '2026-11-06']) assert.ok(markup.includes(`<time datetime="${date}">`), date);
      }
      assert.match(markup, /href="https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
    }
  }
});

test('a class outside the renderer offers nothing; a polygon with no clock field says so rather than inventing one', () => {
  const target = targetFor('cpc-814-precip');
  const outside = feature('cpc-814-precip', { cat: 'EC', prob: 33 });
  assert.equal(target.label(outside), null);
  assert.equal(target.respond(outside, { lngLat: { lng: 0, lat: 0 }, point: { x: 0, y: 0 } }, map), null);
  const bare = target.respond(feature('cpc-814-precip', { cat: 'Below', prob: 40, fcst_date: null, start_date: 1e20, end_date: '  ' }), { lngLat: { lng: 0, lat: 0 }, point: { x: 0, y: 0 } }, map);
  assert.deepEqual(bare.model.clocks, [{ kind: 'not-stated', label: 'Forecast Date', reason: 'not stated' }]);
  assert.ok(serializePopupFrame(bare.model).includes('Forecast Date'));
  // A date string the issuer supplies is shown as supplied, never read as a date.
  const supplied = targetFor('cpc-seasonal-temp').respond(feature('cpc-seasonal-temp', { cat: 'Normal', prob: 33, valid_seas: 'DJF 2026-2027', fcst_date: '11/19/2026' }), { lngLat: { lng: 0, lat: 0 }, point: { x: 0, y: 0 } }, map);
  assert.equal(supplied.model.clocks[1].at.precision, 'supplied');
  assert.equal(supplied.model.clocks[1].at.text, '11/19/2026');
});
