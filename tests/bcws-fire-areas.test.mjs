import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * BC Wildfire Service beside NIFC (the acceptance of 2026-09-25, the owner's
 * rulings of 2026-09-26): the Border 2 pair is one fire area by the link
 * rule and a sliver is not; the grouping Worker (and the clipping it
 * carries) starts only for a cross-border pair; a fire area counts once with
 * the ratified label; its popup lists each agency's own record with no
 * merged name, size or status; the stage whitelist; the hectare to acre
 * conversion; a reload that renumbers OBJECTID keeps every record once.
 *
 * Fixture: tests/fixtures/bcws-border2.json, the BC record V10885 and the
 * NIFC record 2026-WANCP-000266 as each layer requests them (its `_source`
 * names the two reads), plus a synthetic sliver. No live host is contacted.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
    return nextResolve(specifier, context);
  }
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bcws-border2.json', import.meta.url), 'utf8'));
const { runPerimeterJob } = await import('../src/util/perimeter-job.ts');
const { measurePerimeterGeometry } = await import('../src/util/perimeter-measures.ts');
const { intersectPolygons } = await import('../src/util/polygon-clip.ts');
const { overlapDecisionFromMeasures, PERIMETER_OVERLAP_RULE } = await import('../src/util/perimeter-grouping.ts');
const areas = await import('../src/layers/fire-areas.ts');
const records = await import('../src/layers/fire-records.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const presentation = await import('../src/config/wildfire-presentation.ts');

const run = (sourceJson) => runPerimeterJob(sourceJson, areas.FIRE_AREA_JOB_LIMITS);
/** The Border 2 grouping, computed once: the strict validation is exact (BigInt) and takes about a second. */
let borderState;
const border = () => (borderState ??= areas.groupFireAreas([fixture.bcws], [fixture.nifc], run));
const V = { maxVertices: 50_000, maxSegmentTests: 50_000_000 };

function decision(a, b) {
  const parts = intersectPolygons(a.geometry, b.geometry, { input: V, output: V });
  const components = parts.length ? measurePerimeterGeometry({ type: 'MultiPolygon', coordinates: parts }, V).components : [];
  return overlapDecisionFromMeasures({
    leftAreaM2: measurePerimeterGeometry(a.geometry, V).areaM2,
    rightAreaM2: measurePerimeterGeometry(b.geometry, V).areaM2,
    components
  });
}

test('the link rule constants are derived: one hectare, twice the 0.0005 degree generalization at 111,320 m a degree, half the smaller record', () => {
  assert.equal(PERIMETER_OVERLAP_RULE.minAreaM2, 10_000);
  assert.ok(Math.abs(PERIMETER_OVERLAP_RULE.minMeanWidthM - 2 * 0.0005 * 111_320) < 1e-9);
  assert.ok(PERIMETER_OVERLAP_RULE.minMeanWidthM >= 111);
  assert.equal(PERIMETER_OVERLAP_RULE.smallerRecordFraction, 0.5);
});

test('the Border 2 pair links by the width clause and is one fire area with one union outline; the sliver does not link', async () => {
  assert.equal(decision(fixture.bcws, fixture.nifc), 'width');
  assert.equal(decision(fixture.bcws, fixture.sliver), 'separate', 'a 20 ha strip 44 m wide holding 1 percent of the smaller record');
  const state = await border();
  assert.equal(state.status, 'complete');
  assert.equal(state.areas.length, 1);
  const [area] = state.areas;
  assert.deepEqual(area.members.map((m) => m.issuer).sort(), ['bcws', 'nifc']);
  assert.equal(area.outlined, true, 'the union came back');
  assert.equal(state.areaOf.get('bcws:2026-V10885'), area.key);
  assert.equal(state.areaOf.get('nifc:2026-WANCP-000266'), area.key);
  // The union covers both members: its area is at least the larger record's.
  const union = measurePerimeterGeometry({ type: 'MultiPolygon', coordinates: area.coordinates }, V).areaM2;
  assert.ok(union >= measurePerimeterGeometry(fixture.nifc.geometry, V).areaM2 - 1);
  const sliver = await areas.groupFireAreas([fixture.bcws], [fixture.sliver], run);
  assert.equal(sliver.status, 'complete');
  assert.deepEqual(sliver.areas, []);
  assert.equal(sliver.areaOf.size, 0);
});

test('the grouping Worker, and the clipping it carries, start only when a cross-border pair exists', async () => {
  let calls = 0;
  const spy = async (json) => { calls += 1; return run(json); };
  const far = { ...fixture.nifc, geometry: { type: 'Polygon', coordinates: [[[-121.6, 44.6], [-121.0, 44.6], [-121.0, 45.0], [-121.6, 45.0], [-121.6, 44.6]]] } };
  const none = await areas.groupFireAreas([fixture.bcws], [far], spy);
  assert.equal(calls, 0, 'no candidate, no Worker');
  assert.equal(none.status, 'complete');
  assert.deepEqual(areas.crossBorderCandidates([fixture.bcws], [far]), []);
  await areas.groupFireAreas([fixture.bcws], [fixture.nifc, far], spy);
  assert.equal(calls, 1);
  assert.deepEqual(areas.crossBorderCandidates([fixture.bcws], [fixture.nifc, far]).map((row) => row.issuer), ['bcws', 'nifc'], 'only the pair is sent');
  // Inside the job, the clip and union loaders are reached only for a candidate and a linked pair.
  let loads = 0;
  const forbidden = async () => { loads += 1; throw new Error('clipping loaded without a candidate'); };
  const rows = [{ issuer: 'bcws', geometry: fixture.bcws.geometry, properties: fixture.bcws.properties }, { issuer: 'nifc', geometry: far.geometry, properties: far.properties }];
  await runPerimeterJob(JSON.stringify(rows), areas.FIRE_AREA_JOB_LIMITS, forbidden, forbidden);
  assert.equal(loads, 0);
});

test('a failed grouping job is unavailable, never "no overlap": its candidates count once per agency and are named unresolved', async () => {
  const failed = await areas.groupFireAreas([fixture.bcws], [fixture.nifc], async () => { throw new Error('worker failed'); });
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual([...failed.unresolved].sort(), ['bcws:2026-V10885', 'nifc:2026-WANCP-000266']);
  const rows = [
    { identity: 'nifc:2026-WANCP-000266', recordKey: 'nifc:2026-WANCP-000266' },
    { identity: 'bcws:2026-V10885', recordKey: 'bcws:2026-V10885' }
  ];
  assert.deepEqual(areas.countFireAreas(rows, (key) => failed.areaOf.get(key) ?? null), { count: 2, merged: 0 });
});

test('a fire area counts once and carries the ratified label', async () => {
  const state = await border();
  const rows = [
    { identity: 'nifc:2026-WANCP-000266', recordKey: 'nifc:2026-WANCP-000266' },
    { identity: 'bcws:2026-V10885', recordKey: 'bcws:2026-V10885' },
    { identity: 'bcws:2026-K1', recordKey: 'bcws:2026-K1' }
  ];
  assert.deepEqual(areas.countFireAreas(rows, (key) => state.areaOf.get(key) ?? null), { count: 2, merged: 1 });
  assert.equal(presentation.OVERLAP_COUNT_LABEL, 'overlapping agency perimeters counted as one fire area');
  assert.ok(presentation.buildFireAreaClaim(2).endsWith('; overlapping agency perimeters counted as one fire area.'));
});

test('a failed BC read leaves the strip\'s NIFC count standing and says so; BC holds the tile only while it loads', async () => {
  const strip = await import('../src/ui/island/strip-metrics.ts');
  const { registry } = await import('../src/state/registry.ts');
  const { setChecked } = await import('../src/ui/island/bridge.ts');
  const nifc = ['2026-WANCP-000266', '2026-IDBOF-000001'].map((id) => ({ properties: { attr_IncidentTypeCategory: 'WF', attr_UniqueFireIdentifier: id } }));
  const map = {
    getLayer: (id) => (id === 'nifc-fires-fill' ? { id } : undefined),
    queryRenderedFeatures: ({ layers }) => (layers.includes('nifc-fires-fill') ? nifc : [])
  };
  try {
    registry.activate('nifc-fires');
    registry.setStatus('nifc-fires', 'ready');
    // A BC outage with no earlier answer: the layer stays checked, with no fill.
    setChecked('bcws-fires', true);
    registry.setStatus('bcws-fires', 'error');
    // The tile's name says it counts both agencies (its accessible name and title read it).
    const name = 'Current Mapped Fire Perimeters (NIFC and BC Wildfire Service)';
    assert.deepEqual(strip.firesMetric(map), {
      value: '2', sublabel: 'mapped wildfire perimeters in view; BC Wildfire Service perimeters unavailable', tone: 'data', name
    });
    registry.setStatus('bcws-fires', 'loading');
    assert.equal(strip.firesMetric(map).value, '-', 'while BC loads, its tile waits');
    registry.activate('bcws-fires');
    registry.setStatus('bcws-fires', 'no-data');
    assert.deepEqual(strip.firesMetric(map), { value: '2', sublabel: 'mapped wildfire perimeters in view', tone: 'data', name });
    setChecked('bcws-fires', false);
    registry.deactivate('bcws-fires');
    assert.equal('name' in strip.firesMetric(map), false, 'NIFC alone keeps its own layer name');
    setChecked('bcws-fires', true);
    registry.activate('bcws-fires');
    // With NIFC off, a failed BC read is never a zero.
    registry.deactivate('nifc-fires');
    registry.setStatus('bcws-fires', 'error');
    assert.equal(strip.firesMetric(map).value, '-');
  } finally {
    registry.deactivate('nifc-fires');
    registry.deactivate('bcws-fires');
    setChecked('bcws-fires', false);
  }
});

test('a reload that renumbers OBJECTID and GlobalID keeps each record\'s key, its fire area and a single count', async () => {
  const reloaded = { ...fixture.bcws, id: 999, properties: { ...fixture.bcws.properties, OBJECTID: 999, GlobalID: '00000000-0000-0000-0000-000000000000' } };
  assert.equal(areas.fireRecordKey('bcws', reloaded.properties), areas.fireRecordKey('bcws', fixture.bcws.properties));
  const before = await border();
  const after = await areas.groupFireAreas([reloaded], [fixture.nifc], run);
  assert.equal(after.areaOf.get('bcws:2026-V10885'), before.areaOf.get('bcws:2026-V10885'));
  // The same fire met in two reads counts once.
  const rows = [fixture.bcws, reloaded].map((f) => ({ identity: areas.fireRecordKey('bcws', f.properties), recordKey: areas.fireRecordKey('bcws', f.properties) }));
  assert.deepEqual(areas.countFireAreas(rows, () => null), { count: 1, merged: 0 });
});

test('the fire-area popup lists each agency\'s own record: number or name, size in its unit with the conversion, status, dates, source; nothing merged', async () => {
  const state = await border();
  const [area] = state.areas;
  const retrieved = Date.UTC(2026, 10, 6, 6, 30);
  const group = records.buildFireAreaGroupInput(area.key, area.members, Date.UTC(2026, 10, 6, 6, 31), 'America/Vancouver', { nifc: null, bcws: retrieved });
  assert.deepEqual(group.issuers.slice().sort(), ['bcws', 'nifc']);
  const html = serializePopupFrame({ kind: 'group', group });
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const slice = (key) => html.slice(html.indexOf(`data-record-key="${key}"`), html.indexOf('</li>', html.indexOf(`data-record-key="${key}"`)));
  const bc = slice('bcws:2026-V10885');
  assert.ok(bc.includes('Fire Number V10885, Fire Year 2026'));
  assert.ok(bc.includes('6,595.6 ha (about 16,298 acres)'));
  assert.ok(bc.includes('data-status-from="issuer">Under Control'));
  assert.ok(bc.includes('Track Date'));
  assert.ok(bc.includes('datetime="2026-09-22"'));
  assert.ok(bc.includes('https://wildfiresituation.nrs.gov.bc.ca/incidents?fireYear=2026&amp;incidentNumber=V10885'));
  const us = slice('nifc:2026-WANCP-000266');
  assert.ok(us.includes('Border 2'));
  assert.ok(us.includes('9,108 acres (about 3,686 ha)'));
  assert.ok(us.includes('23,857 acres (about 9,654 ha)'));
  assert.ok(us.includes('https://data-nifc.opendata.arcgis.com/'));
  assert.equal(us.includes('data-record-slot="status"'), false, 'NIFC status wording is pending; none is printed');
  assert.ok(text.includes('Overlapping agency perimeters counted as one fire area.'));
  assert.ok(text.includes('DDM states no combined name, size or status.'));
  // No merged size: the only sizes printed are each record's own.
  assert.deepEqual([...html.matchAll(/data-record-slot="sizes"/g)].length, 2);
});

test('the BC popup takes the stage of control from the issuer field only: three active stages, Out, and null or unrecognized as unknown', () => {
  const model = (status) => records.buildBcwsPopupModel({ ...fixture.bcws.properties, FIRE_STATUS: status }, null);
  for (const stage of ['Out of Control', 'Being Held', 'Under Control']) {
    assert.equal(model(stage).value[0].text, stage);
    assert.equal(model(stage).value[0].swatch.classKey, 'active');
    assert.deepEqual(model(stage).records[0].status, { from: 'issuer', text: stage });
  }
  assert.equal(model('Out').value[0].swatch.classKey, 'inactive');
  assert.deepEqual(model('Out').records[0].status, { from: 'issuer', text: 'Out' });
  assert.equal(model(null).value[0].swatch.classKey, 'unknown');
  assert.deepEqual(model(null).records[0].status, { from: 'unknown', text: 'Stage of control not stated' });
  assert.equal(model('Smouldering').value[0].swatch.classKey, 'unknown', 'an unrecognized stage is never active');
  assert.deepEqual(model('Smouldering').records[0].status, { from: 'unknown', text: 'Smouldering' });
  const html = serializePopupFrame(model('Under Control'));
  assert.ok(html.includes('Issued by: BC Wildfire Service (British Columbia)'));
  assert.ok(html.includes('https://catalogue.data.gov.bc.ca/dataset/cdfc2d7b-c046-4bf0-90ac-4897232619e1'));
  assert.equal(html.includes('may not reflect'), false, 'the dataset caveat lives in the Impact Briefing, not the popup');
  // A record whose grouping is unknown says so.
  const unresolved = serializePopupFrame(records.buildBcwsPopupModel(fixture.bcws.properties, null, 1, ['grouping-unavailable']));
  assert.ok(unresolved.includes('data-notice="grouping-unavailable"'));
});

test('the map draws by the same whitelist: the paint matches the derived stage class, and the legend names the issuer\'s stages', () => {
  const fill = presentation.buildBcwsFillPaint();
  assert.deepEqual(fill['fill-color'].slice(0, 2), ['match', ['get', presentation.BCWS_STAGE_CLASS_PROPERTY]]);
  assert.equal(presentation.BCWS_STATUS_PRESENTATION.active.legendLabel, 'Out of Control, Being Held or Under Control');
  assert.equal(presentation.BCWS_STATUS_PRESENTATION.inactive.legendLabel, 'Out');
  assert.equal(presentation.BCWS_STATUS_PRESENTATION.inactive.fillOpacity, 0, 'an Out fire is an outline, never a burning fill');
});

/** `hex` at `alpha` over an [r, g, b] ground, as the map composites it. */
const over = (hex, alpha, ground) => '#' + ground.map((g, i) =>
  Math.round(alpha * parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) + (1 - alpha) * g).toString(16).padStart(2, '0')).join('');
const hexOf = (rgb) => over('#000000', 0, rgb);

test('Out and an unstated stage hold 3:1 over both basemaps: the line over the default dark base, its casing over the satellite cloud', async () => {
  const { contrast } = await import('./road-color-math.mjs');
  // Grounds read off the 2026-11-06 captures: the default base (typical, brightest) and the satellite cloud (grey, white).
  const grounds = [[59, 62, 64], [77, 80, 82], [158, 155, 163], [232, 232, 234]];
  const casing = presentation.buildBcwsCasingPaint();
  for (const cls of ['inactive', 'unknown']) {
    const row = presentation.BCWS_STATUS_PRESENTATION[cls];
    for (const ground of grounds) {
      const edge = Math.max(contrast(over(row.lineColor, row.lineOpacity, ground), hexOf(ground)),
        contrast(over(row.casingColor, row.lineOpacity, ground), hexOf(ground)));
      assert.ok(edge >= 3, `${cls} over ${ground}: ${edge.toFixed(2)}:1`);
    }
  }
  // The casing paint draws for the outline-only stages and stays clear under the active ones, one pixel wider each side.
  const opacity = casing['line-opacity'];
  assert.deepEqual(opacity.slice(0, 2), ['match', ['get', presentation.BCWS_STAGE_CLASS_PROPERTY]]);
  assert.equal(opacity[3], 0, 'no casing under an active stage');
  assert.deepEqual(casing['line-width'].slice(2), ['active', 5, 'inactive', 4.4, 4.4]);
});

test('the unstated stage is drawn apart from Out and from NIFC "Other or unclassified"; the key gives each stage its own line, as the map draws it', async () => {
  const { BCWS_STATUS_PRESENTATION: bc, NIFC_INCIDENT_PRESENTATION: nifc } = presentation;
  const mark = (row) => `${row.lineColor} ${row.lineDasharray.join(',')}`;
  assert.equal(new Set([mark(bc.unknown), mark(bc.inactive), mark(nifc.other)]).size, 3, 'colour and dash together differ');
  assert.notDeepEqual([...bc.unknown.lineDasharray], [...nifc.other.lineDasharray], 'not the NIFC dash in the NIFC colour');
  assert.notDeepEqual([...bc.unknown.lineDasharray], [...bc.inactive.lineDasharray], 'not the Out line');
  const dash = presentation.buildBcwsLinePaint()['line-dasharray'];
  assert.deepEqual(dash.slice(2), ['active', ['literal', [1, 0]], 'inactive', ['literal', [1, 0]], ['literal', [0.5, 2]]]);
  const { buildFireKey } = await import('../src/ui/map-key.ts');
  const html = buildFireKey(new Set(['nifc-fires', 'bcws-fires'])).itemsHtml;
  const item = (cls) => html.match(new RegExp(`<span class="map-key-item" style="([^"]*)" data-bcws-stage="${cls}"><span class="map-key-swatch" style="([^"]*)">`));
  for (const cls of ['active', 'inactive', 'unknown']) assert.equal(item(cls)?.[1], 'flex-basis:100%', `${cls} on its own line`);
  assert.equal(item('active')[2], `background:${bc.active.lineColor}`, 'the active stages are a filled mark, as drawn');
  assert.equal(item('inactive')[2], 'background:transparent;border:2px solid #a8a29e;box-shadow:none', 'Out is an outline alone');
  assert.equal(item('unknown')[2], 'background:transparent;border:2px dotted #94a3b8;box-shadow:none', 'an unstated stage is a dotted outline');
});

test('the minimap credits both agencies it checks: no label or Technical information note names NIFC alone', () => {
  const source = readFileSync(new URL('../src/ui/island/minimap.tsx', import.meta.url), 'utf8');
  for (const nifcAlone of ["'NIFC / WHP 2023'", 'Checking current mapped NIFC wildfire perimeters', 'Current mapped NIFC wildfire perimeter summary unavailable',
    'Current mapped NIFC wildfire perimeter check unavailable', '`NIFC browser check:', 'Current mapped NIFC wildfire perimeters with static']) {
    assert.equal(source.includes(nifcAlone), false, nifcAlone);
  }
  assert.ok(source.includes("'NIFC, BCWS / WHP 2023'"));
});

test('hectares in the issuer\'s unit as served, with the acre conversion beside it', () => {
  assert.equal(records.bcwsSizeText(6595.6), '6,595.6 ha (about 16,298 acres)');
  assert.equal(records.bcwsSizeText(0.1), '0.1 ha (under 1 acre)');
  assert.equal(records.bcwsSizeText(0), '0 ha (0 acres)');
  assert.equal(records.bcwsSizeText(1), '1 ha (about 2 acres)');
  assert.equal(records.bcwsSizeText(null), null);
  assert.ok(Math.abs(1 / records.HECTARES_PER_ACRE - 2.4710538146716534) < 1e-12);
});

test('Track Date reads at date precision in its served form (midnight at UTC-7); any other form is shown as supplied', () => {
  const clock = (value) => records.bcwsRecordBlock({ ...fixture.bcws.properties, TRACK_DATE: value }, null).clocks[0];
  assert.deepEqual(clock(1790060400000).at, { precision: 'date', date: '2026-09-22' });
  assert.equal(clock(Date.UTC(2026, 8, 22)).at.precision, 'supplied');
  assert.equal(clock(null).label, 'Record loaded', 'no Track Date, the load time leads');
});

test('the briefing sentences set out the issuer\'s own stage names and say when a count is a lower bound', () => {
  assert.equal(presentation.buildBcwsAreaPerimeterClaim([]), 'No current BC Wildfire Service perimeters intersect the bounding box around this selection.');
  assert.equal(presentation.buildBcwsAreaPerimeterClaim(['Out of Control']), '1 current BC Wildfire Service perimeter intersects the bounding box around this selection: 1 Out of Control.');
  assert.ok(presentation.buildBcwsAreaPerimeterClaim(['Out'], { truncated: true }).endsWith('so this count is a lower bound.'));
});
