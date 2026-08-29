import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARCGIS_FIELD_PROBES,
  DRIFT_TIERS,
  OUT_FIELDS_SENDERS_COVERED_ELSEWHERE,
  buildFieldProbeEntries,
  checkFieldSchema,
  classifyDriftResults,
  extractOutFields,
  extractUrls,
  missingFields,
  readWorkerRevision,
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

test('readWorkerRevision returns the exact WORKER_REVISION constant in the Worker source', async () => {
  const source = await readFile(
    new URL('../workers/proxy/src/index.ts', import.meta.url),
    'utf8',
  );
  const revision = readWorkerRevision(source);
  // Confirm the returned value is really present as a WORKER_REVISION
  // assignment in source, not merely the first string the regex touched.
  assert.match(
    source,
    new RegExp(`const\\s+WORKER_REVISION\\s*=\\s*["']${revision}["']`),
  );
});

test('readWorkerRevision returns a date-prefixed string', async () => {
  const source = await readFile(
    new URL('../workers/proxy/src/index.ts', import.meta.url),
    'utf8',
  );
  const revision = readWorkerRevision(source);
  assert.match(
    revision,
    /^\d{4}-\d{2}-\d{2}-/,
    `expected a YYYY-MM-DD-prefixed revision, got ${JSON.stringify(revision)}`,
  );
});

test('readWorkerRevision throws when the constant is removed from source', () => {
  const withoutConstant = `
    const USER_AGENT = "DDM-Proxy/0.1.0 (+https://example.test)";
    const UPSTREAM_TIMEOUT_MS = 12_000;
  `;
  assert.throws(
    () => readWorkerRevision(withoutConstant),
    /WORKER_REVISION constant not found/,
  );
});

test('readWorkerRevision throws on an empty source file', () => {
  assert.throws(
    () => readWorkerRevision(''),
    /WORKER_REVISION constant not found/,
  );
});

test('readWorkerRevision throws on an ambiguous, repeated constant', () => {
  const doubled = `
    const WORKER_REVISION = "2026-01-01-a";
    const WORKER_REVISION = "2026-01-02-b";
  `;
  assert.throws(
    () => readWorkerRevision(doubled),
    /matched 2 times/,
  );
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
    const outFields =
      layer === 7
        ? 'A,B'
        : 'C';
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
    ['A', 'B'],
    ['C'],
  ]);
  assert.deepEqual(found.map((f) => f.via), [
    'literal', 'NIFC_OUT_FIELDS', 'PLANTS_OUT_FIELDS', 'LOCAL_FIELDS', 'template', 'ternary:isLevel4', 'ternary:!(isLevel4)', 'ternary:layer === 7', 'ternary:!(layer === 7)',
  ]);
  assert.deepEqual(found[7].fields, ['A', 'B']);
  assert.deepEqual(found[8].fields, ['C']);
  assert.equal(extractOutFields('interface Q { outFields: string }\nfunction f(outFields: string) {}').length, 0);
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

test('extractOutFields keeps an unresolvable identifier as unresolved instead of dropping it', () => {
  const found = extractOutFields("const q = new URLSearchParams({ outFields: MYSTERY_FIELDS, f: 'json' });");
  assert.equal(found.length, 1);
  assert.equal(found[0].unresolved, true);
  assert.equal(found[0].fields, null);
  assert.equal(found[0].via, 'MYSTERY_FIELDS');
});

test('buildFieldProbeEntries throws on an unresolvable list instead of skipping it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ddm-drift-'));
  const first = ARCGIS_FIELD_PROBES[0];
  await mkdir(join(root, first.file, '..'), { recursive: true });
  await writeFile(join(root, first.file), "const p = new URLSearchParams({ outFields: MYSTERY_FIELDS });\n");
  const urlEntries = ARCGIS_FIELD_PROBES.map((p) => ({ key: p.key, url: `https://example.test/${p.key}`, tier: DRIFT_TIERS.RUNTIME }));
  await assert.rejects(() => buildFieldProbeEntries(urlEntries, root), /neither a local constant nor an import/);
  await rm(root, { recursive: true, force: true });
});

test('every src file that sends outFields is probed or explicitly accounted for', async () => {
  const root = new URL('../', import.meta.url);
  const probed = new Set(ARCGIS_FIELD_PROBES.map((p) => p.file));
  const accounted = new Set([...probed, ...Object.keys(OUT_FIELDS_SENDERS_COVERED_ELSEWHERE)]);
  const senders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && /\boutFields\b/.test(await readFile(path, 'utf8'))) {
        senders.push(relative(fileURLToPath(root), path).replaceAll('\\', '/'));
      }
    }
  }
  await walk(fileURLToPath(new URL('src/', root)));
  assert.ok(senders.length >= 15, `expected the runtime's outFields senders, found ${senders.length}`);
  const missing = senders.filter((file) => !accounted.has(file));
  assert.deepEqual(missing, [], 'outFields senders with neither a probe row nor a recorded reason');
  for (const file of Object.keys(OUT_FIELDS_SENDERS_COVERED_ELSEWHERE)) {
    assert.ok(senders.includes(file), `${file} is listed as covered elsewhere but no longer sends outFields`);
  }
});
