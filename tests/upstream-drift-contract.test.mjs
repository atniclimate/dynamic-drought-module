import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ARCGIS_FIELD_PROBES,
  DRIFT_TIERS,
  buildFieldProbeEntries,
  checkFieldSchema,
  classifyDriftResults,
  extractOutFields,
  extractUrls,
  missingFields,
  soilDriftInputState,
  sourceTierForKey,
} from '../scripts/check-upstream-drift.mjs';

test('extracts single- and double-quoted endpoints with explicit tiers', () => {
  const entries = extractUrls(`
    workerProxy: 'https://worker.example.test',
    usgsVegdriWeeklyWms: "https://candidate.example.test/wms",
    cdmDroughtAreasZipRoot:
      'https://build.example.test/archive',
  `);

  assert.deepEqual(entries, [
    {
      key: 'workerProxy',
      url: 'https://worker.example.test',
      tier: DRIFT_TIERS.RUNTIME,
    },
    {
      key: 'usgsVegdriWeeklyWms',
      url: 'https://candidate.example.test/wms',
      tier: DRIFT_TIERS.CANDIDATE,
    },
    {
      key: 'cdmDroughtAreasZipRoot',
      url: 'https://build.example.test/archive',
      tier: DRIFT_TIERS.BUILD,
    },
  ]);
});

test('defaults new source keys to runtime protection', () => {
  assert.equal(sourceTierForKey('newlyAddedEndpoint'), DRIFT_TIERS.RUNTIME);
});

test('recognizes only complete, bound soil drift inputs', () => {
  const normalize = (value) => value.replaceAll('\\', '/');
  const stateFor = (paths) =>
    soilDriftInputState('/repo', (value) => paths.has(normalize(value)));
  const committedRoot =
    '/repo/scripts/landscape/intermediates/soil/FY2025/';
  const overflowRoot =
    '/repo/scripts/.cache/soil/intermediates-overflow/FY2025/';
  const dataNames = [
    'histogram-l3.json',
    'histogram-l4.json',
    'sda-rows.json',
  ];

  assert.equal(stateFor(new Set()), 'missing');
  assert.equal(
    stateFor(new Set(dataNames.map((name) => committedRoot + name))),
    'committed',
  );
  assert.equal(
    stateFor(
      new Set([
        ...dataNames.map((name) => overflowRoot + name),
        overflowRoot + 'INPUT-BINDING.json',
      ]),
    ),
    'overflow',
  );
  assert.equal(
    stateFor(new Set(dataNames.map((name) => overflowRoot + name))),
    'missing',
  );
});

test('candidate failures are warnings while runtime and build failures block', () => {
  const classified = classifyDriftResults([
    { key: 'workerProxy', tier: DRIFT_TIERS.RUNTIME, ok: false },
    { key: 'landscapeSoilVintage', tier: DRIFT_TIERS.BUILD, ok: false },
    { key: 'usgsQuickdriWeeklyWms', tier: DRIFT_TIERS.CANDIDATE, ok: false },
    {
      key: 'landscapeNlcdPinnedTime',
      tier: DRIFT_TIERS.BUILD,
      ok: true,
      warning: 'new vintage',
    },
    {
      key: 'landscapeSoilVintage',
      tier: DRIFT_TIERS.BUILD,
      ok: true,
      skipped: true,
      warning: 'bound inputs absent',
    },
  ]);

  assert.deepEqual(classified.runtimeFailures.map(({ key }) => key), [
    'workerProxy',
  ]);
  assert.deepEqual(classified.buildFailures.map(({ key }) => key), [
    'landscapeSoilVintage',
  ]);
  assert.deepEqual(classified.candidateFailures.map(({ key }) => key), [
    'usgsQuickdriWeeklyWms',
  ]);
  assert.deepEqual(classified.blockingFailures.map(({ key }) => key), [
    'workerProxy',
    'landscapeSoilVintage',
  ]);
  assert.deepEqual(classified.warnings.map(({ key }) => key), [
    'landscapeNlcdPinnedTime',
  ]);
  assert.deepEqual(classified.skipped.map(({ key }) => key), [
    'landscapeSoilVintage',
  ]);
});

test('the current URL registry keeps representative lifecycle tiers distinct', async () => {
  const source = await readFile(
    new URL('../src/config/urls.ts', import.meta.url),
    'utf8',
  );
  const entries = extractUrls(source);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  assert.equal(byKey.get('workerProxy')?.tier, DRIFT_TIERS.RUNTIME);
  assert.equal(byKey.get('nifcFires')?.tier, DRIFT_TIERS.RUNTIME);
  assert.equal(
    byKey.get('cdmDroughtAreasZipRoot')?.tier,
    DRIFT_TIERS.BUILD,
  );
  assert.equal(
    byKey.get('usgsVegdriWeeklyWms')?.tier,
    DRIFT_TIERS.CANDIDATE,
  );
  assert.equal(new Set(entries.map(({ key }) => key)).size, entries.length);
});

test('extractOutFields reads literal lists, joined arrays, named string constants, and imported names', () => {
  const source = `
    import { NIFC_OUT_FIELDS } from '../config/wildfire-presentation';
    const PLANTS_OUT_FIELDS = 'Plant_Name,Total_MW';
    const LOCAL_FIELDS = ['DM', 'MapDate'] as const;
    params.set('a', '1');
    const q = new URLSearchParams({ where: '1=1', outFields: 'LARID,LARNAME', f: 'geojson' });
    const r = new URLSearchParams({ outFields: NIFC_OUT_FIELDS.join(','), f: 'geojson' });
    const s = new URLSearchParams({ outFields: PLANTS_OUT_FIELDS });
    const t = new URLSearchParams({ outFields: LOCAL_FIELDS.join(',') });
    const u = new URLSearchParams({ outFields: '*' });
    const v = new URLSearchParams({ outFields: \`\${codeField},name,areasqkm,states\` });
    const outFields = isLevel4
      ? 'US_L4CODE,US_L4NAME,US_L3CODE,US_L3NAME'
      : 'US_L3CODE,US_L3NAME';
    const w = new URLSearchParams({ where, outFields, f: 'geojson' });
  `;
  const found = extractOutFields(source);
  assert.deepEqual(found.map((f) => f.fields), [
    ['LARID', 'LARNAME'],
    null,
    ['Plant_Name', 'Total_MW'],
    ['DM', 'MapDate'],
    ['name', 'areasqkm', 'states'],
    ['US_L4CODE', 'US_L4NAME', 'US_L3CODE', 'US_L3NAME'],
    ['US_L3CODE', 'US_L3NAME'],
  ]);
  assert.deepEqual(found.map((f) => f.via), [
    'literal', 'NIFC_OUT_FIELDS', 'PLANTS_OUT_FIELDS', 'LOCAL_FIELDS', 'template', 'ternary:isLevel4', 'ternary:!isLevel4',
  ]);
  assert.equal(found[1].importedFrom, '../config/wildfire-presentation');
  assert.equal(found[0].importedFrom, null);
  assert.deepEqual(found[4].dynamic, ['codeField']);
  assert.deepEqual(found[0].dynamic, []);
});

test('missingFields matches names exactly and reports case-only near misses separately', () => {
  const pjson = { fields: [{ name: 'LARID' }, { name: 'LarName' }, { name: 'GISACRES' }] };
  assert.deepEqual(missingFields(['LARID', 'LARNAME', 'REGION'], pjson), {
    missing: ['LARNAME', 'REGION'],
    caseOnly: ['LARNAME'],
  });
  assert.deepEqual(missingFields(['LARID'], {}), { missing: ['LARID'], caseOnly: [] });
});

test('checkFieldSchema turns a pjson body into a tripwire miss or a present note', () => {
  const body = JSON.stringify({ fields: [{ name: 'DM' }, { name: 'MapDate' }] });
  assert.deepEqual(checkFieldSchema(['DM', 'MapDate'], body), { miss: null, note: '2/2 requested fields present' });
  assert.match(checkFieldSchema(['DM', 'mapdate'], body).miss, /missing fields: mapdate \(case-only: mapdate\)/);
  assert.match(checkFieldSchema(['DM'], '{"error":{"code":400,"message":"Invalid URL"}}').miss, /ArcGIS error 400/);
  assert.match(checkFieldSchema(['DM'], '<html>').miss, /not JSON/);
  assert.match(checkFieldSchema(['DM'], '{"name":"x"}').miss, /no fields array/);
});

test('every ArcGIS field probe names a runtime URLS key, an existing module, and resolves its field list', async () => {
  const urls = await readFile(new URL('../src/config/urls.ts', import.meta.url), 'utf8');
  const urlEntries = extractUrls(urls);
  const keys = new Set(urlEntries.map((e) => e.key));
  for (const probe of ARCGIS_FIELD_PROBES) {
    assert.ok(keys.has(probe.key), `${probe.key} is not in URLS`);
    assert.equal(sourceTierForKey(probe.key), DRIFT_TIERS.RUNTIME, `${probe.key} is not a runtime source`);
    assert.ok(existsSync(new URL(`../${probe.file}`, import.meta.url)), `${probe.file} missing`);
    assert.match(probe.layer, /^(\/\d+)?$/);
  }
  const entries = await buildFieldProbeEntries(urlEntries);
  assert.equal(entries.length, ARCGIS_FIELD_PROBES.length);
  for (const entry of entries) {
    assert.match(entry.key, /^fields:/);
    assert.match(entry.url, /\?f=pjson$/);
    assert.equal(entry.tier, DRIFT_TIERS.RUNTIME);
    assert.ok(entry.fieldsExpected.length >= 2, `${entry.key} resolved ${entry.fieldsExpected.length} fields`);
    assert.ok(!entry.fieldsExpected.includes('*'));
  }
  const nifc = entries.find((e) => e.key === 'fields:nifcFires');
  assert.ok(nifc.fieldsExpected.includes('attr_IncidentSize'));
  assert.ok(!nifc.fieldsExpected.includes('attr_DailyAcres'));
  assert.equal(new Set(entries.map((e) => e.key)).size, entries.length);
  const level4 = entries.find((e) => e.key === 'fields:epaEcoregionsMapServer/7');
  const level3 = entries.find((e) => e.key === 'fields:epaEcoregionsMapServer/11');
  assert.ok(level4.fieldsExpected.includes('US_L4CODE'));
  assert.deepEqual(level3.fieldsExpected, ['US_L3CODE', 'US_L3NAME']);
  assert.deepEqual(level4.fieldsExpected, ['US_L4CODE', 'US_L4NAME', 'US_L3CODE', 'US_L3NAME']);
  const wbd = entries.find((e) => e.key === 'fields:wbdMapServer/1');
  assert.deepEqual(wbd.fieldsExpected, ['name', 'areasqkm', 'states']);
  assert.deepEqual(wbd.fieldsDynamic, ['codeField']);
  assert.deepEqual(nifc.fieldsDynamic, []);
});
