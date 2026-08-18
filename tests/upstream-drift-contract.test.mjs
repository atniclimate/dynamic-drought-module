import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRIFT_TIERS,
  classifyDriftResults,
  extractUrls,
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
  assert.equal(
    byKey.get('eoxCloudless2016')?.tier,
    DRIFT_TIERS.CANDIDATE,
  );
  assert.equal(
    byKey.get('eoxCloudless2016Probe')?.tier,
    DRIFT_TIERS.CANDIDATE,
  );
  assert.equal(new Set(entries.map(({ key }) => key)).size, entries.length);
});
