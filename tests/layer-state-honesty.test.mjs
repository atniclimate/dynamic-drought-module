import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// What a layer says (its key, its popup) follows what it has drawn, not what
// it was last asked for. The shipped function bodies run with recording
// stand-ins for their module neighbours, the telemetry-keyboard pattern.
function functionBody(path, name) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const body = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(body, `${name} is still a source function with its own closing line`);
  return stripTypeScriptTypes(body.replace(/^export\s+/, ''));
}

test('the drought outlook popup names the range drawn while a new range is still loading', () => {
  const targets = [];
  const ranges = [];
  const dependencies = {
    registerClickTarget: (target) => targets.push(target),
    buildOutlookPopupModel: (_props, range) => { ranges.push(range); return {}; },
    FILL_LAYER_ID: 'fill',
    // Monthly was just pressed; Seasonal's polygons are still the ones on the map.
    timeline: { outlookRange: 'monthly' },
    renderedRange: 'seasonal'
  };
  const bindPopups = new Function(...Object.keys(dependencies),
    `${functionBody('../src/layers/drought.ts', 'bindPopups')}\nreturn bindPopups;`)(...Object.values(dependencies));
  bindPopups({ on() {}, getCanvas: () => ({ style: {} }) });
  targets[0].respond({ properties: {} });
  assert.deepEqual(ranges, ['seasonal']);
});

test('the fire perimeter key leaves when a re-query draws no perimeters', () => {
  const legend = [];
  const dependencies = {
    SOURCE_ID: 'nifc', LAYER_KEY: 'nifc-fires', NIFC_INCIDENT_TYPE_PROPERTY: 'type',
    NIFC_INCIDENT_PRESENTATION: { wildfire: {}, prescribed: {}, other: {} }, LEGEND_ORDER: { event: 1 },
    registry: { getStatus: () => null }, console,
    getPerimeterSnapshot: () => ({ collection: null }), setPerimeterSnapshot() {},
    armTimeBar() {}, ensureLayersAdded() {}, classifyNifcIncidentType: () => 'wildfire',
    startWildfirePulse() {}, stopWildfirePulse() {}, renderSwatchLegend() {}, reportStatus() {},
    showLegend: (key) => legend.push(['show', key]),
    hideLegend: (key) => legend.push(['hide', key])
  };
  const apply = new Function(...Object.keys(dependencies),
    `let lastAppliedStatus = null;\n${functionBody('../src/layers/nifc-fires.ts', 'applyFeatureCollection')}\nreturn applyFeatureCollection;`)(...Object.values(dependencies));
  const map = { getSource: () => ({ setData() {} }) };
  apply(map, { type: 'FeatureCollection', features: [{ properties: { type: 'WF' } }] });
  apply(map, { type: 'FeatureCollection', features: [] });
  assert.deepEqual(legend, [['show', 'nifc-fires'], ['hide', 'nifc-fires']]);
});
