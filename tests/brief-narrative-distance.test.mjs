import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit round 5 (R5-27): the at-hand line for the mobile sheet and Place
 * Studio names how far the reporting station is from the selected point, as
 * the briefing card and "Heat sources together" already do, so a station
 * tens of kilometres off is not read as the heat at the point itself.
 */

// Same extensionless-specifier hook as tests/briefing-truth.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { selectBriefNarrativeLine } = await import('../src/impact/brief-narrative-selector.ts');

function briefing(observation) {
  return {
    pointHeat: { observation, grid: { status: 'no-data', metrics: [] } },
    horizons: { current: { claims: [] } }
  };
}

const temperature = { key: 'temperature', values: [{ value: 32, unitCode: 'wmoUnit:degC' }] };

test('a station observation names its distance from the selected point', () => {
  const line = selectBriefNarrativeLine(
    briefing({ status: 'ready', stationName: 'Far Airport', distanceKm: 60, metrics: [temperature] })
  );
  assert.match(line, /^Heat at the selected point: Far Airport, 37\.3 mi \(60\.0 km\) from the selected point, reports temperature /);
});

test('an observation with no distance keeps the bare station name', () => {
  const line = selectBriefNarrativeLine(briefing({ status: 'ready', stationName: 'Far Airport', metrics: [temperature] }));
  assert.match(line, /^Heat at the selected point: Far Airport reports temperature /);
});

const { pointHeatHeading, pointHeatScope, pointReadPlace, seasonalOutlookTitle } = await import('../src/impact/point-heat-format.ts');
const { synthesizeHeatSources } = await import('../src/impact/heat-synthesis.ts');

// A Nation's headquarters town (src/ui/search-controller.ts openHeadquarters): nobody clicked and no boundary was drawn.
const HQ = { readAt: 'the headquarters town, Great Falls' };

test('a headquarters-town briefing names the town in the heat card and drops the boundary caveat', () => {
  assert.equal(pointReadPlace(HQ), 'the headquarters town, Great Falls');
  assert.equal(pointHeatHeading(HQ), 'Heat at the headquarters town, Great Falls');
  assert.equal(pointHeatScope(HQ), 'Values describe this coordinate and nearby station.');
  assert.equal(seasonalOutlookTitle(HQ), 'Seasonal outlook at the headquarters town, Great Falls');
  const synthesis = synthesizeHeatSources(
    { status: 'ready', observation: { status: 'ready', stationName: 'Great Falls Airport', distanceKm: 7, metrics: [temperature] }, grid: { status: 'no-data', metrics: [] } },
    [], true, pointReadPlace(HQ)
  );
  assert.match(synthesis.reads[0].text, /Great Falls Airport, 4\.3 mi \(7\.0 km\) from the headquarters town, Great Falls:/);
});

test('a clicked or chosen point keeps the selected-point words and the boundary caveat', () => {
  for (const context of [{}, undefined]) {
    assert.equal(pointReadPlace(context), 'the selected point');
    assert.equal(pointHeatHeading(context), 'Heat at selected point');
    assert.match(pointHeatScope(context), /not the complete selected boundary or jurisdiction\.$/);
    assert.equal(seasonalOutlookTitle(context), 'Seasonal outlook at this point');
  }
});
