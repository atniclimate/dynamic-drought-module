/**
 * Validate a landscape-signature artifact against the normative schema
 * (schema/landscape-signature.schema.json, schemaVersion 1.3.0).
 *
 * Usage:
 *   node scripts/validate-landscape-artifact.mjs <artifact.json>
 *   node scripts/validate-landscape-artifact.mjs --self-test
 *
 * The embedded self-test runs before artifact validation. Its pinned case
 * inventory red-proves every family branch, the unavailable ledger, the
 * level branches, provenance, and every numeric bound used below.
 *
 * Exit codes: 0 = valid; 1 = invalid or self-test failure; 2 = usage,
 * file, parse, or schema compilation error.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const SCHEMA_PATH = fileURLToPath(
  new URL('../schema/landscape-signature.schema.json', import.meta.url)
);

function rasterSource(methodVersion, resolutionMeters) {
  return {
    source: 'Test source',
    sourceUrl: 'https://example.test/source',
    vintage: '2025 test vintage',
    resolutionMeters,
    method: 'Pinned test method',
    methodVersion,
    acquired: '2026-01-01',
    materializedRasterSha256: 'a'.repeat(64)
  };
}

/** A compact, valid artifact containing every accepted family and source. */
function baseArtifact() {
  const terrain = {
    elevMeanM: 591.6,
    elevMinM: 580.8,
    elevMaxM: 599.5,
    slopeMeanDeg: 5.44,
    aspectMeanDeg: 196.5,
    aspectCardinal: 'S',
    coveragePct: 49.5,
    elevBands: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    aspectDistribution: {
      N: 0,
      NE: 0,
      E: 0,
      SE: 0,
      S: 1,
      SW: 0,
      W: 0,
      NW: 0,
      flat: 0,
      excluded: 0
    }
  };
  const soil = {
    awsRootZoneMm: 143.2,
    awsP10: 100.1,
    awsP90: 201.4,
    rootZoneDepthCm: 150,
    dominantTexture: 'loam',
    ssurgoFraction: 0.8,
    statsgo2Fraction: 0.2,
    coveragePct: 98.4,
    rootZoneCoveragePct: 95.2,
    textureCoveragePct: 94.1,
    cellCount: 1234,
    coarse: false,
    generalized: false
  };
  const landcoverFuels = {
    fbfm40: {
      dominantCode: 101,
      dominantFraction: 0.5,
      nonburnableFraction: 0.2,
      classes: [{ code: 101, fraction: 0.5 }],
      otherBurnableFraction: 0.3,
      coveragePct: 99.1
    },
    evt: {
      dominantCode: 7292,
      dominantName: 'Test vegetation',
      dominantFraction: 0.6,
      coveragePct: 98.2
    },
    landcover: {
      forestFraction: 0.4,
      croplandFraction: 0.2,
      wetlandFraction: 0.1,
      openWaterFraction: 0.05,
      coveragePct: 97.3
    },
    whp: {
      classMean: 3.2,
      classFractions: {
        1: 0.1,
        2: 0.1,
        3: 0.3,
        4: 0.2,
        5: 0.2,
        6: 0.05,
        7: 0.05
      },
      cellCount: 99,
      coarse: true,
      coveragePct: 96.4
    }
  };
  return {
    schemaVersion: '1.3.0',
    retrieved: '2026-01-01',
    analysisCrs: 'EPSG:5070',
    gridResolutionMeters: 30,
    aggregationUnit:
      'EPA Omernik ecoregion (unsimplified Region 10 Albers source)',
    sources: {
      terrain: rasterSource(3, 10),
      soilMukey: rasterSource(1, 30),
      soilSda: {
        ...rasterSource(1, null),
        materializedRasterSha256: null
      },
      fuelsFbfm40: rasterSource(1, 30),
      fuelsEvt: rasterSource(1, 30),
      landcoverNlcd: rasterSource(1, 30),
      hazardWhp: rasterSource(1, 270)
    },
    bundles: {
      '1': {
        level: 3,
        usL3Code: '1',
        usL3Name: 'Test Flats',
        unavailable: [],
        terrain,
        soil,
        landcoverFuels
      }
    }
  };
}

const SELF_TEST_CASES = [
  ['fail-missing-retrieved', 'fail', (a) => { delete a.retrieved; }],
  ['fail-bad-retrieved-date', 'fail', (a) => { a.retrieved = '2026-1-1'; }],
  ['fail-wrong-grid-resolution', 'fail', (a) => { a.gridResolutionMeters = 31; }],
  ['fail-foreign-schema-version', 'fail', (a) => { a.schemaVersion = '1.2.0'; }],
  ['fail-extra-top-level', 'fail', (a) => { a.extra = true; }],
  ['fail-foreign-source-family', 'fail', (a) => { a.sources.other = rasterSource(1, 30); }],
  ['fail-extra-source-property', 'fail', (a) => { a.sources.terrain.extra = true; }],
  ['fail-wrong-terrain-method', 'fail', (a) => { a.sources.terrain.methodVersion = 2; }],
  ['fail-wrong-raster-method', 'fail', (a) => { a.sources.soilMukey.methodVersion = 2; }],
  ['fail-zero-source-resolution', 'fail', (a) => { a.sources.terrain.resolutionMeters = 0; }],
  ['fail-soil-sda-resolution', 'fail', (a) => { a.sources.soilSda.resolutionMeters = 30; }],
  ['fail-soil-sda-digest', 'fail', (a) => { a.sources.soilSda.materializedRasterSha256 = 'b'.repeat(64); }],
  ['fail-empty-vintage', 'fail', (a) => { a.sources.landcoverNlcd.vintage = ''; }],
  ['fail-malformed-sha', 'fail', (a) => { a.sources.terrain.materializedRasterSha256 = 'xyz'; }],
  ['fail-bad-acquired-date', 'fail', (a) => { a.sources.terrain.acquired = 'yesterday'; }],
  ['fail-omitted-acquired', 'fail', (a) => { delete a.sources.terrain.acquired; }],
  ['fail-empty-bundles', 'fail', (a) => { a.bundles = {}; }],
  ['fail-extra-bundle-property', 'fail', (a) => { a.bundles['1'].extra = true; }],
  ['fail-missing-ledger', 'fail', (a) => { delete a.bundles['1'].unavailable; }],
  ['fail-bad-ledger-path', 'fail', (a) => { a.bundles['1'].unavailable = ['soil.unknown']; }],
  ['fail-duplicate-ledger-path', 'fail', (a) => { a.bundles['1'].unavailable = ['soil', 'soil']; }],
  ['fail-missing-terrain', 'fail', (a) => { delete a.bundles['1'].terrain; }],
  ['fail-extra-terrain-property', 'fail', (a) => { a.bundles['1'].terrain.extra = true; }],
  ['fail-missing-elev-bands', 'fail', (a) => { delete a.bundles['1'].terrain.elevBands; }],
  ['fail-short-elev-bands', 'fail', (a) => { a.bundles['1'].terrain.elevBands.pop(); }],
  ['fail-missing-aspect-distribution', 'fail', (a) => { delete a.bundles['1'].terrain.aspectDistribution; }],
  ['fail-extra-aspect-bin', 'fail', (a) => { a.bundles['1'].terrain.aspectDistribution.other = 0; }],
  ['fail-one-sided-aspect-null', 'fail', (a) => { a.bundles['1'].terrain.aspectMeanDeg = null; }],
  ['fail-one-sided-cardinal-null', 'fail', (a) => { a.bundles['1'].terrain.aspectCardinal = null; }],
  ['fail-aspect-360', 'fail', (a) => { a.bundles['1'].terrain.aspectMeanDeg = 360; }],
  ['fail-negative-slope', 'fail', (a) => { a.bundles['1'].terrain.slopeMeanDeg = -0.1; }],
  ['fail-coverage-above-100', 'fail', (a) => { a.bundles['1'].terrain.coveragePct = 100.1; }],
  ['fail-fraction-below-zero', 'fail', (a) => { a.bundles['1'].terrain.elevBands[0] = -0.1; }],
  ['fail-fraction-above-one', 'fail', (a) => { a.bundles['1'].terrain.elevBands[0] = 1.1; }],
  ['fail-mixed-terrain-unavailable', 'fail', (a) => { a.bundles['1'].terrain.unavailable = true; }],
  ['fail-empty-unavailable-reason', 'fail', (a) => { a.bundles['1'].terrain = { unavailable: true, reason: '' }; }],
  ['fail-extra-unavailable-property', 'fail', (a) => { a.bundles['1'].terrain = { unavailable: true, reason: 'test', extra: true }; }],
  ['fail-missing-soil-field', 'fail', (a) => { delete a.bundles['1'].soil.awsRootZoneMm; }],
  ['fail-extra-soil-property', 'fail', (a) => { a.bundles['1'].soil.extra = true; }],
  ['fail-negative-root-zone', 'fail', (a) => { a.bundles['1'].soil.rootZoneDepthCm = -1; }],
  ['fail-mixed-soil-unavailable', 'fail', (a) => { a.bundles['1'].soil.unavailable = true; }],
  ['fail-missing-landcover-fuels-field', 'fail', (a) => { delete a.bundles['1'].landcoverFuels.whp; }],
  ['fail-extra-landcover-fuels-property', 'fail', (a) => { a.bundles['1'].landcoverFuels.extra = true; }],
  ['fail-fbfm-pairing', 'fail', (a) => { a.bundles['1'].landcoverFuels.fbfm40.dominantCode = null; }],
  ['fail-extra-fbfm-class-property', 'fail', (a) => { a.bundles['1'].landcoverFuels.fbfm40.classes[0].extra = true; }],
  ['fail-evt-missing-name', 'fail', (a) => { delete a.bundles['1'].landcoverFuels.evt.dominantName; }],
  ['fail-landcover-fraction', 'fail', (a) => { a.bundles['1'].landcoverFuels.landcover.forestFraction = 2; }],
  ['fail-whp-class-mean', 'fail', (a) => { a.bundles['1'].landcoverFuels.whp.classMean = 6; }],
  ['fail-whp-missing-class', 'fail', (a) => { delete a.bundles['1'].landcoverFuels.whp.classFractions['7']; }],
  ['fail-l3-with-l4-field', 'fail', (a) => { a.bundles['1'].usL4Code = '1a'; }],
  ['fail-level4-missing-parent', 'fail', (a) => { a.bundles['1'].level = 4; }],
  ['pass-full-stats', 'pass', () => {}],
  ['pass-null-provenance', 'pass', (a) => {
    for (const source of Object.values(a.sources)) {
      source.acquired = null;
      source.materializedRasterSha256 = null;
    }
  }],
  ['pass-null-soil-fields', 'pass', (a) => {
    a.bundles['1'].soil.rootZoneDepthCm = null;
    a.bundles['1'].soil.dominantTexture = null;
  }],
  ['pass-null-terrain-aspect-pair', 'pass', (a) => {
    a.bundles['1'].terrain.aspectMeanDeg = null;
    a.bundles['1'].terrain.aspectCardinal = null;
  }],
  ['pass-family-unavailable-shapes', 'pass', (a) => {
    a.bundles['1'].unavailable = ['soil', 'landcoverFuels'];
    a.bundles['1'].soil = { unavailable: true, reason: 'test soil gap' };
    a.bundles['1'].landcoverFuels = {
      unavailable: true,
      reason: 'test landcover and fuels gap'
    };
  }],
  ['pass-landcover-subblock-unavailable', 'pass', (a) => {
    a.bundles['1'].unavailable = ['landcoverFuels.whp'];
    a.bundles['1'].landcoverFuels.whp = {
      unavailable: true,
      reason: 'test WHP gap'
    };
  }],
  ['pass-level4-bundle', 'pass', (a) => {
    const bundle = a.bundles['1'];
    bundle.level = 4;
    bundle.usL4Code = '1a';
    bundle.usL4Name = 'Test Flats Subunit';
    bundle.parent = '1';
  }]
].map(([name, kind, mutate]) => ({ name, kind, mutate }));

const EXPECTED_CASE_NAMES = [
  'fail-missing-retrieved',
  'fail-bad-retrieved-date',
  'fail-wrong-grid-resolution',
  'fail-foreign-schema-version',
  'fail-extra-top-level',
  'fail-foreign-source-family',
  'fail-extra-source-property',
  'fail-wrong-terrain-method',
  'fail-wrong-raster-method',
  'fail-zero-source-resolution',
  'fail-soil-sda-resolution',
  'fail-soil-sda-digest',
  'fail-empty-vintage',
  'fail-malformed-sha',
  'fail-bad-acquired-date',
  'fail-omitted-acquired',
  'fail-empty-bundles',
  'fail-extra-bundle-property',
  'fail-missing-ledger',
  'fail-bad-ledger-path',
  'fail-duplicate-ledger-path',
  'fail-missing-terrain',
  'fail-extra-terrain-property',
  'fail-missing-elev-bands',
  'fail-short-elev-bands',
  'fail-missing-aspect-distribution',
  'fail-extra-aspect-bin',
  'fail-one-sided-aspect-null',
  'fail-one-sided-cardinal-null',
  'fail-aspect-360',
  'fail-negative-slope',
  'fail-coverage-above-100',
  'fail-fraction-below-zero',
  'fail-fraction-above-one',
  'fail-mixed-terrain-unavailable',
  'fail-empty-unavailable-reason',
  'fail-extra-unavailable-property',
  'fail-missing-soil-field',
  'fail-extra-soil-property',
  'fail-negative-root-zone',
  'fail-mixed-soil-unavailable',
  'fail-missing-landcover-fuels-field',
  'fail-extra-landcover-fuels-property',
  'fail-fbfm-pairing',
  'fail-extra-fbfm-class-property',
  'fail-evt-missing-name',
  'fail-landcover-fraction',
  'fail-whp-class-mean',
  'fail-whp-missing-class',
  'fail-l3-with-l4-field',
  'fail-level4-missing-parent',
  'pass-full-stats',
  'pass-null-provenance',
  'pass-null-soil-fields',
  'pass-null-terrain-aspect-pair',
  'pass-family-unavailable-shapes',
  'pass-landcover-subblock-unavailable',
  'pass-level4-bundle'
];

function loadValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020.default({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function runSelfTest(validate) {
  const names = SELF_TEST_CASES.map((testCase) => testCase.name);
  if (
    names.length !== EXPECTED_CASE_NAMES.length ||
    names.some((name, index) => name !== EXPECTED_CASE_NAMES[index])
  ) {
    console.error(
      'self-test inventory drift: the case table and EXPECTED_CASE_NAMES ' +
      'must match in order'
    );
    return false;
  }
  let ok = true;
  for (const testCase of SELF_TEST_CASES) {
    const artifact = baseArtifact();
    testCase.mutate(artifact);
    const valid = validate(artifact);
    const wantValid = testCase.kind === 'pass';
    if (valid !== wantValid) {
      ok = false;
      console.error(
        `self-test case ${testCase.name}: expected ` +
        `${wantValid ? 'VALID' : 'INVALID'}, got ` +
        `${valid ? 'VALID' : 'INVALID'}`
      );
      for (const err of validate.errors ?? []) {
        console.error(`  ${err.instancePath || '/'}: ${err.message}`);
      }
    }
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error(
      'usage: node scripts/validate-landscape-artifact.mjs ' +
      '<artifact.json> | --self-test'
    );
    return 2;
  }
  const selfTestOnly = args[0] === '--self-test';

  let validate;
  try {
    validate = loadValidator();
  } catch (err) {
    console.error(`cannot load or compile the schema at ${SCHEMA_PATH}:`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (!runSelfTest(validate)) return 1;
  console.log(`self-test OK (${SELF_TEST_CASES.length} pinned cases)`);
  if (selfTestOnly) return 0;

  const artifactPath = args[0];
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (err) {
    console.error(`cannot read or parse ${artifactPath}:`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (!validate(artifact)) {
    console.error(`${artifactPath} is INVALID against schemaVersion 1.3.0:`);
    for (const err of validate.errors ?? []) {
      console.error(`  ${err.instancePath || '/'}: ${err.message}`);
    }
    return 1;
  }
  const bundleCount = Object.keys(artifact.bundles ?? {}).length;
  console.log(
    `${artifactPath} is valid (schemaVersion ${artifact.schemaVersion}, ` +
      `${bundleCount} bundles)`
  );
  return 0;
}

process.exit(main());
