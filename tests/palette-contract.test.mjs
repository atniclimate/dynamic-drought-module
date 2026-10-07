import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Same extensionless TypeScript resolver used by boot-idle-seam.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
        typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  }
});
const palette = await import('../src/config/palette.ts');
const wildfire = await import('../src/config/wildfire-presentation.ts');
const shade = await import('../src/config/whp-shade.ts');

test('R8 USDM change independently pins all eleven issuer classes and invalid inputs', async () => {
  const expected = [[-5,"#003D75"],[-4,"#016678"],[-3,"#359766"],[-2,"#8AD48C"],[-1,"#CCFFD4"],[0,"#CCCCCC"],[1,"#FFFF73"],[2,"#FFD438"],[3,"#FF9900"],[4,"#A87000"],[5,"#543005"]];
  const { buildUsdmChangeColorExpression, usdmChangeColor, usdmChangeLabel, usdmChangeLegendItems } =
    await import('../src/config/usdm-change.ts');
  const labels = ["Improved 5 categories","Improved 4 categories","Improved 3 categories","Improved 2 categories","Improved 1 category","No category change","Worsened 1 category","Worsened 2 categories","Worsened 3 categories","Worsened 4 categories","Worsened 5 categories"];
  const assertContract = () => {
    assert.deepEqual(palette.USDM_CHANGE_COLORS.map(({ dn, color }) => [dn, color]), expected);
    assert.deepEqual(buildUsdmChangeColorExpression(), ['match', ['get', 'DN'], ...expected.flat(), 'rgba(0,0,0,0)']);
    assert.deepEqual(usdmChangeLegendItems(), expected.map(([,color], i) => ({ color, label: labels[i] })));
  };
  assertContract();
  for (const [dn, color] of expected) assert.equal(usdmChangeColor(dn), color);
  for (const dn of [null, undefined, '', '0', '-5', false, NaN, Infinity, -6, 6, 0.5]) {
    assert.equal(usdmChangeColor(dn), undefined);
    assert.equal(usdmChangeLabel(dn), 'Unknown change class');
  }
  const row = palette.USDM_CHANGE_COLORS[0];
  const saved = row.color;
  try {
    row.color = '#CCFFD4';
    assert.throws(assertContract);
    assert.equal(usdmChangeColor(-5), '#CCFFD4');
    assert.equal(usdmChangeLegendItems()[0].color, '#CCFFD4');
    assert.equal(buildUsdmChangeColorExpression()[3], '#CCFFD4');
  } finally { row.color = saved; }
  assertContract();
});

// D3 M1 E: display transforms are separate from source-color tables and the
// named E1/E2 recolor exceptions. These pins observe shipped declarations;
// they do not claim rendered class-center, no-data or overlapping-drape proof.
const DISPLAY_TRANSFORMS = [
  { id: 'USDM', source: 'S1', file: 'layers/usdm.ts', paint: {
    'fill-opacity': [0.54], 'line-opacity': [0]
  } },
  { id: 'CDM', source: 'S3', file: 'layers/cdm-drought.ts', paint: {
    'fill-opacity': [0.54], 'line-opacity': [0.45]
  } },
  { id: 'NADM', source: 'S2', file: 'layers/nadm-drought.ts', paint: {
    'fill-opacity': [0.48]
  } },
  { id: 'BC', source: 'S4', file: 'layers/bc-drought.ts', paint: {
    'fill-opacity': [0.54], 'line-opacity': [0.48]
  } },
  { id: 'NWS', source: 'S6', file: 'layers/nws-alerts.ts', paint: {
    'fill-opacity': [0.35], 'line-opacity': [0.9]
  } },
  { id: 'SPC', source: 'S7', file: 'layers/spc-fire-weather.ts', paint: {
    'fill-opacity': [0.3], 'line-opacity': [0.9]
  } },
  { id: 'HeatRisk', source: 'S5', file: 'layers/heatrisk.ts', paint: {
    'raster-opacity': [0.55], 'raster-resampling': ['nearest']
  } },
  { id: 'WHP 2D', source: 'S9', file: 'layers/usfs-whp.ts', paint: {
    'raster-opacity': [0.55], 'raster-resampling': ['nearest']
  } },
  { id: 'SST', source: 'S11', file: 'layers/sst-anomaly.ts', paint: {
    'raster-opacity': ['opacity', 0.78], 'line-opacity': [0.9]
  } },
  { id: 'SPI', source: 'S12', file: 'layers/gridded-index.ts', paint: {
    'raster-opacity': [0.72]
  } },
  { id: 'CPC hatch', source: 'S8', file: 'layers/drought.ts', paint: {
    'fill-opacity': [1], 'line-opacity': [0.9]
  } },
  { id: 'NIFC pulse', source: 'DDM mapped-perimeter class', file: 'config/wildfire-presentation.ts', paint: {} }
];
const sourceText = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('M2 removes the dead D4 rim from USDM creation, fades and layer ordering', () => {
  assert.doesNotMatch(sourceText('layers/usdm.ts'), /USDM_D4_RIM|buildD4Rim|rimId|withD4Rim|d4-rim|#f87171/i);
  assert.doesNotMatch(sourceText('map/layer-order.ts'), /usdm-frame-[ab]-d4-rim/);
});
const withoutBlockComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
function paintValues(text, key) {
  const code = withoutBlockComments(text);
  const constants = new Map([...code.matchAll(/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*([0-9.]+)\s*;/gm)]
    .map((match) => [match[1], Number(match[2])]));
  // This is the one imported opacity in the inspected declarations. Its
  // independent literal value is pinned in E1 below.
  constants.set('WHP_SURFACE_OPACITY', shade.WHP_SURFACE_OPACITY);
  const pattern = new RegExp(`['"]${key}['"]\\s*:\\s*([^,}\\r\\n]+)`, 'g');
  return [...code.matchAll(pattern)].map((match) => {
    const expression = match[1].trim();
    if (/^[0-9.]+$/.test(expression)) return Number(expression);
    if (/^(['"]).*\1$/.test(expression)) return expression.slice(1, -1);
    return constants.get(expression) ?? expression;
  });
}
function assertTransform(row, text) {
  for (const [key, expected] of Object.entries(row.paint)) {
    assert.deepEqual(paintValues(text, key), expected, `${row.id} (${row.source}) ${key}`);
  }
}

test('named display transforms pin the actual current adapter paint independently of source colors', () => {
  assert.deepEqual(DISPLAY_TRANSFORMS.map(row => row.id), [
    'USDM', 'CDM', 'NADM', 'BC', 'NWS', 'SPC', 'HeatRisk', 'WHP 2D', 'SST', 'SPI', 'CPC hatch', 'NIFC pulse'
  ]);
  for (const row of DISPLAY_TRANSFORMS) assertTransform(row, sourceText(row.file));
  const hatch = withoutBlockComments(sourceText('util/hatch.ts'));
  assert.match(hatch, /^const STROKE_ALPHA = 0\.6;/m);
  assert.match(hatch, /ctx\.strokeStyle\s*=\s*withAlpha\(color,\s*STROKE_ALPHA\)/);
  assert.deepEqual(wildfire.WILDFIRE_PULSE_COLORS, ['#ff3300', '#ff4c00', '#ff6600']);
  assert.equal(wildfire.WILDFIRE_PULSE_DURATION_MS, 1800);
  assert.equal(wildfire.WILDFIRE_STATIC_COLOR, '#ff4c00');
  assert.deepEqual([0, 450, 900, 1350, 1800].map(wildfire.interpolateWildfirePulseColor),
    ['#ff3300', '#ff4c00', '#ff6600', '#ff4c00', '#ff3300']);
});

test('transform pins reject source-opacity, resampling and extra-declaration drift', () => {
  const cdm = DISPLAY_TRANSFORMS.find(row => row.id === 'CDM');
  const original = sourceText(cdm.file);
  const changed = original.replace('const FILL_OPACITY = 0.54;', 'const FILL_OPACITY = 0.55;');
  assert.notEqual(changed, original, 'the control must change actual candidate source');
  assert.throws(() => assertTransform(cdm, changed), /CDM \(S3\) fill-opacity/);
  const heat = DISPLAY_TRANSFORMS.find(row => row.id === 'HeatRisk');
  const heatSource = sourceText(heat.file);
  const linear = heatSource.replace("'raster-resampling': 'nearest'", "'raster-resampling': 'linear'");
  assert.notEqual(linear, heatSource);
  assert.throws(() => assertTransform(heat, linear), /HeatRisk \(S5\) raster-resampling/);
  assert.throws(() => assertTransform(heat, heatSource + "\nconst drift = { 'raster-opacity': 0.99 };"), /HeatRisk \(S5\) raster-opacity/);
});

// D3 M1 classification of every CURRENT export matched by the brief's rule.
// This is a drift/classification contract, not a scientific verification receipt.
const CLASSIFICATION = {
  palette: {
    ROAD_CLASS_COLORS: 'DDM neutral D8 class contract, M-027',
    CAUTION_LINE_COLORS: 'S15 FHWA MUTCD intent; adopted fallback; exact issuer hex UNVERIFIED, pending',
    MINIMAP_DROUGHT_COLORS: 'borrowed NADM overview mark',
    MINIMAP_WILDFIRE_COLORS: 'borrowed NIFC/WHP overview mark',
    ENSO_PHASE_COLORS: 'S13 current DDM chart colors, CPC receipt pending',
    ENSO_INDEX_GUIDE_COLORS: 'S13 product-specific CPC ONI HTML and RONI CSS, verified 2026-10-07',
    CPC_OUTLOOK_TERCILE_COLORS: 'S14 CPC exact cat/prob renderer rows, verified 2026-10-07',
    CPC_SEASONAL_COLORS: 'D6 CPC seasonal Lead 1 exact cat/prob renderer RGBA and labels, verified 2026-10-07',
    INDEX_SERIES_COLORS: 'DDM measured-index display transform',
    ECOREGION_COLORS: 'DDM geographic context',
    DROUGHT_COLORS: 'S8 CPC drought outlook, source receipt 2026-10-07',
    HEATRISK_CATEGORIES: 'S5 NWS HeatRisk, recorded 2026-07-28',
    USDM_CATEGORIES: 'S1 NDMC USDM metadata colors verified 2026-10-07; usdm ledger',
    USDM_CHANGE_COLORS: 'R8 NDMC USDM exact signed change classes, source receipt 2026-10-07',
    NADM_CATEGORIES: 'S2 NOAA NADM service renderer, verified 2026-10-07',
    CDM_CATEGORIES: 'S3 AAFC CDM service legend, verified 2026-10-07',
    BC_DROUGHT_LEVELS: 'S4 BC portal renderer verified 2026-10-07; DR-160 held',
    TREATY_COLORS: 'representation styling, not hazard',
    NWS_ALERT_COLORS: 'S6 five current NWS event colors verified 2026-10-07; legacy heat aliases retained compatibility; gray fallback DDM',
    SPC_FIREWX_CATEGORIES: 'S7 SPC fire weather, source receipt 2026-10-07',
    SST_ANOMALY_SCALE: 'S11 exact GIBS v1.3 intervals/colors verified 2026-10-07; qualitative labels remain separately unverified',
    GRIDDED_INDEX_RAMP: 'S12 ACIS five-window issuer legend pixels, verified 2026-10-07; bins unknown'
  },
  wildfire: {
    WILDFIRE_PULSE_COLORS: 'DDM current-perimeter display transform',
    NIFC_INCIDENT_PRESENTATION: 'DDM incident-class marks',
    HMS_DENSITY_PRESENTATION: 'DDM density display transform',
    HMS_VOLUME_HEIGHT_SCALE_METERS: 'DDM symbolic-height display transform',
    USFS_WHP_PRESENTATION: 'S9 issuer legend decoded; bake checks drift',
    FBFM40_PRESENTATION: 'S10 LANDFIRE pinned while present',
    POWER_PLANT_PRESENTATION: 'DDM infrastructure context',
    POWER_PLANT_CLUSTER_PRESENTATION: 'DDM infrastructure context',
    STRUCTURES_PRESENTATION: 'DDM infrastructure context'
  }
};
function assertClassified(actual, expected) {
  assert.deepEqual(Object.keys(actual).filter(name =>
    /COLORS|CATEGORIES|LEVELS|SCALE|PRESENTATION|RAMP/.test(name)).sort(),
  Object.keys(expected).sort());
}
test('every matching palette and wildfire export has an explicit classification', () => {
  assertClassified(palette, CLASSIFICATION.palette);
  assertClassified(wildfire, CLASSIFICATION.wildfire);
  assert.throws(() => assertClassified({ ...palette, FIFTH_MODE_COLORS: {} }, CLASSIFICATION.palette));
});

const DROUGHT = [
  ['D0', 'Abnormally dry', '#FFFF00'],
  ['D1', 'Moderate drought', '#FCD37F'],
  ['D2', 'Severe drought', '#FFAA00'],
  ['D3', 'Extreme drought', '#E60000'],
  ['D4', 'Exceptional drought', '#730000']
];

test('S12 SPI pins its own decoded legend classes, including the unlabeled slot', () => {
  const expected = [
    ['D4', '#730000'], ['D3', '#E60000'], ['D2', '#FFAA00'],
    ['D1', '#FCD37F'], ['D0', '#FFFF00'], [null, '#FFFFFF'],
    ['W0', '#AAFF55'], ['W1', '#01FFFF'], ['W2', '#00AAFF'],
    ['W3', '#0000FF'], ['W4', '#0000AA']
  ];
  const actual = () => palette.GRIDDED_INDEX_RAMP.map(({ code, color }) => [code, color]);
  assert.deepEqual(actual(), expected);
  const original = palette.GRIDDED_INDEX_RAMP[7].color;
  try {
    palette.GRIDDED_INDEX_RAMP[7].color = '#00FFFF';
    assert.throws(() => assert.deepEqual(actual(), expected));
  } finally {
    palette.GRIDDED_INDEX_RAMP[7].color = original;
  }
  assert.deepEqual(actual(), expected);
});
const droughtRows = rows => rows.map(({ code, label, color }) => [code, label, color]);
function assertUsdm(rows) { assert.deepEqual(droughtRows(rows), DROUGHT); }
test('S1 and S2 independently pin their issuer palettes and differ at D1', () => {
  assertUsdm(palette.USDM_CATEGORIES);
  assert.deepEqual(droughtRows(palette.NADM_CATEGORIES), [
    ['D0', 'Abnormally dry', '#FFFF00'], ['D1', 'Moderate drought', '#FCD27E'],
    ['D2', 'Severe drought', '#FFAA00'], ['D3', 'Extreme drought', '#E60000'],
    ['D4', 'Exceptional drought', '#730000']
  ]);
  assert.notDeepEqual(droughtRows(palette.USDM_CATEGORIES), droughtRows(palette.NADM_CATEGORIES));
  assert.deepEqual(palette.MINIMAP_DROUGHT_COLORS, {
    none: '#FFFFFF', D0: '#FFFF00', D1: '#FCD27E', D2: '#FFAA00', D3: '#E60000', D4: '#730000'
  });
  const nadmBefore = droughtRows(palette.NADM_CATEGORIES);
  const previous = palette.USDM_CATEGORIES[1].color;
  try {
    palette.USDM_CATEGORIES[1].color = '#010203';
    assert.deepEqual(droughtRows(palette.NADM_CATEGORIES), nadmBefore);
    assert.equal(palette.MINIMAP_DROUGHT_COLORS.D1, '#FCD27E');
  } finally {
    palette.USDM_CATEGORIES[1].color = previous;
  }
  const changed = palette.USDM_CATEGORIES.map(row => ({ ...row }));
  changed[2].color = '#FFAA01';
  assert.throws(() => assertUsdm(changed), 'a D2 color mutation must fail the pin');
});

test('S3 CDM pins the AAFC service legend independently of USDM and NADM', () => {
  const expected = [
    { code: 'D0', color: '#FFFF00' },
    { code: 'D1', color: '#FFD37F' },
    { code: 'D2', color: '#E69800' },
    { code: 'D3', color: '#E60000' },
    { code: 'D4', color: '#730000' }
  ];
  const rows = () => palette.CDM_CATEGORIES.map(({ code, color }) => ({ code, color }));
  assert.deepEqual(rows(), expected);
  // AAFC's D1 and D2 differ; neighboring source tables cannot substitute for CDM.
  for (const source of [palette.USDM_CATEGORIES, palette.NADM_CATEGORIES]) {
    assert.notDeepEqual(source.map(({ code, color }) => ({ code, color })), expected);
    const previous = source[2].color;
    try {
      source[2].color = '#FFAA01';
      assert.equal(source[2].color, '#FFAA01');
      assert.deepEqual(rows(), expected, 'another product must not mutate CDM');
    } finally {
      source[2].color = previous;
    }
  }
  const drifted = expected.map(row => ({ ...row }));
  drifted[2].color = '#FFAA01';
  assert.throws(() => assert.deepEqual(drifted, rows()), 'CDM drift is detected');
});

test('S4 BC levels and no-update stay a separate numeric scale', () => {
  assert.deepEqual(palette.BC_DROUGHT_LEVELS.map(({ value, code, label, color }) =>
    [value, code, label, color]), [
    [0, '0', 'Level 0', '#FFFFFF'], [1, '1', 'Level 1', '#EBD1B8'],
    [2, '2', 'Level 2', '#C2A57A'], [3, '3', 'Level 3', '#8C683A'],
    [4, '4', 'Level 4', '#5B3E22'], [5, '5', 'Level 5', '#261A0F']
  ]);
  assert.deepEqual(palette.BC_DROUGHT_NO_UPDATE,
    { value: 99, code: 'No update', label: 'Not measured right now',
      color: 'rgba(204, 204, 204, 0.7490196078431373)' });
  // Source alpha is not flattened to opaque gray or replaced with display opacity.
  const sourceAlpha = Number(palette.BC_DROUGHT_NO_UPDATE.color.match(/, ([0-9.]+)\)$/)[1]);
  assert.equal(sourceAlpha, 191 / 255);
  assert.notEqual(sourceAlpha, 0.54);
  const before = palette.BC_DROUGHT_LEVELS.map(row => ({ ...row }));
  const previous = palette.NADM_CATEGORIES[1].color;
  try {
    palette.NADM_CATEGORIES[1].color = '#010203';
    assert.deepEqual(palette.BC_DROUGHT_LEVELS, before);
  } finally {
    palette.NADM_CATEGORIES[1].color = previous;
  }
});
test('S5 HeatRisk retains issuer class identity and colors', () => {
  assert.deepEqual(palette.HEATRISK_CATEGORIES.map(({ value, label, color }) => [value, label, color]), [
    [0, 'Little to no risk', '#E8F9E7'], [1, 'Minor', '#F4F257'],
    [2, 'Moderate', '#F69632'], [3, 'Major', '#E22F33'], [4, 'Extreme', '#7A0E7F']
  ]);
});
test('S6-S8 current source tables are pinned without upgrading pending provenance', () => {
  assert.deepEqual(palette.NWS_ALERT_COLORS, {
    'Extreme Heat Warning': '#c71585', 'Excessive Heat Warning': '#c71585',
    'Extreme Heat Watch': '#800000', 'Excessive Heat Watch': '#800000',
    'Heat Advisory': '#ff7f50', 'Red Flag Warning': '#ff1493', 'Fire Weather Watch': '#ffdead'
  });
  assert.deepEqual(palette.SPC_FIREWX_CATEGORIES, [
    { dn: 5, label: 'Elevated', color: '#e69800' },
    { dn: 8, label: 'Critical', color: '#FF0000' },
    { dn: 10, label: 'Extremely Critical', color: '#E600A9' }
  ]);
  assert.deepEqual(palette.DROUGHT_COLORS,
    { PERSISTS: '#9B634A', DEVELOPS: '#FFDE63', IMPROVES: '#DED4BC', REMOVAL: '#B2AD69' });
});
const SST_SOURCE_EXPECTED = [
  [0, null, '#000000', true],
  [1, '[-INF,-3.0)', '#6b00db', false],
  [2, '[-3.0,-2.9)', '#7400d6', false],
  [3, '[-2.9,-2.8)', '#7f00d3', false],
  [4, '[-2.8,-2.7)', '#8900cf', false],
  [5, '[-2.7,-2.6)', '#9600ca', false],
  [6, '[-2.6,-2.5)', '#9109cc', false],
  [7, '[-2.5,-2.4)', '#7f1ad1', false],
  [8, '[-2.4,-2.3)', '#6031dc', false],
  [9, '[-2.3,-2.2)', '#414be6', false],
  [10, '[-2.2,-2.1)', '#2264f1', false],
  [11, '[-2.1,-2.0)', '#087cfb', false],
  [12, '[-2.0,-1.9)', '#0094ff', false],
  [13, '[-1.9,-1.8)', '#00aeff', false],
  [14, '[-1.8,-1.7)', '#00caff', false],
  [15, '[-1.7,-1.6)', '#00e3ff', false],
  [16, '[-1.6,-1.5)', '#03f8fa', false],
  [17, '[-1.5,-1.4)', '#18fce5', false],
  [18, '[-1.4,-1.3)', '#2fffce', false],
  [19, '[-1.3,-1.2)', '#47ffb6', false],
  [20, '[-1.2,-1.1)', '#60ff9e', false],
  [21, '[-1.1,-1.0)', '#76ff8c', false],
  [22, '[-1.0,-0.9)', '#88ff84', false],
  [23, '[-0.9,-0.8)', '#97ff8b', false],
  [24, '[-0.8,-0.7)', '#a4ff91', false],
  [25, '[-0.7,-0.6)', '#b1ff98', false],
  [26, '[-0.6,-0.5)', '#bdfe9e', false],
  [27, '[-0.5,-0.4)', '#bff4a3', false],
  [28, '[-0.4,-0.3)', '#bfe8a9', false],
  [29, '[-0.3,-0.2)', '#bfdbb0', false],
  [30, '[-0.2,-0.1)', '#bfd0b6', false],
  [31, '[-0.1,0.0)', '#c2cab8', false],
  [32, '[0.0,0.1)', '#cacab7', false],
  [33, '[0.1,0.2)', '#d5d5ac', false],
  [34, '[0.2,0.3)', '#e2e2a2', false],
  [35, '[0.3,0.4)', '#eded98', false],
  [36, '[0.4,0.5)', '#f9f88d', false],
  [37, '[0.5,0.6)', '#fff679', false],
  [38, '[0.6,0.7)', '#ffea5e', false],
  [39, '[0.7,0.8)', '#ffde43', false],
  [40, '[0.8,0.9)', '#ffd025', false],
  [41, '[0.9,1.0)', '#ffc209', false],
  [42, '[1.0,1.1)', '#ffb601', false],
  [43, '[1.1,1.2)', '#ffaa00', false],
  [44, '[1.2,1.3)', '#ff9d00', false],
  [45, '[1.3,1.4)', '#ff9100', false],
  [46, '[1.4,1.5)', '#ff8200', false],
  [47, '[1.5,1.6)', '#ff7100', false],
  [48, '[1.6,1.7)', '#ff5900', false],
  [49, '[1.7,1.8)', '#ff3d00', false],
  [50, '[1.8,1.9)', '#ff2100', false],
  [51, '[1.9,2.0)', '#fe0900', false],
  [52, '[2.0,2.1)', '#f90113', false],
  [53, '[2.1,2.2)', '#f3002d', false],
  [54, '[2.2,2.3)', '#ec004a', false],
  [55, '[2.3,2.4)', '#e60067', false],
  [56, '[2.4,2.5)', '#de007d', false],
  [57, '[2.5,2.6)', '#d30085', false],
  [58, '[2.6,2.7)', '#bf0068', false],
  [59, '[2.7,2.8)', '#ab0048', false],
  [60, '[2.8,2.9)', '#9a002c', false],
  [61, '[2.9,3.0)', '#88000f', false],
  [62, '[3.0,+INF)', '#800000', false]
];
test('S11 full issuer intervals and transparent no-data match the actual shared legend', async () => {
  const actual = () => palette.SST_ANOMALY_SCALE.map(({ ref, interval, color, transparent }) =>
    [ref, interval, color, transparent]);
  assert.deepEqual(actual(), SST_SOURCE_EXPECTED);
  const { sstAnomalyScaleHtml, renderSstAnomalyLegend } = await import('../src/ui/sst-anomaly-legend.ts');
  const emitted = () => [...sstAnomalyScaleHtml().matchAll(/data-sst-color="(\d+)" style="background:([^"]+)"/g)]
    .map(match => [Number(match[1]), match[2]]);
  const expectedColors = SST_SOURCE_EXPECTED.slice(1).reverse().map(([ref, , color]) => [ref, color]);
  assert.deepEqual(emitted(), expectedColors);
  assert.ok(!emitted().some(([ref]) => ref === 0), 'transparent no-data must not become a zero swatch');
  const body = { innerHTML: '' };
  renderSstAnomalyLegend(body);
  assert.ok(body.innerHTML.includes(sstAnomalyScaleHtml()));
  for (const label of ['Warmer than usual', 'Near usual', 'Cooler than usual']) {
    assert.ok(body.innerHTML.includes(label));
  }
  const middle = palette.SST_ANOMALY_SCALE[31];
  const originalColor = middle.color;
  const originalInterval = middle.interval;
  try {
    middle.color = '#123456';
    assert.throws(() => assert.deepEqual(actual(), SST_SOURCE_EXPECTED));
    assert.ok(emitted().some(([ref, color]) => ref === 31 && color === '#123456'));
    middle.color = originalColor;
    middle.interval = '[-0.2,0.0)';
    assert.throws(() => assert.deepEqual(actual(), SST_SOURCE_EXPECTED));
  } finally {
    middle.color = originalColor;
    middle.interval = originalInterval;
  }
  assert.deepEqual(actual(), SST_SOURCE_EXPECTED);
  assert.deepEqual(emitted(), expectedColors);
});
test('S9 WHP issuer legend categories remain pinned independently of E1', () => {
  assert.deepEqual(wildfire.USFS_WHP_PRESENTATION.categories.map(({ label, color }) => [label, color]), [
    ['Very Low', '#38a300'], ['Low', '#a3ff94'], ['Moderate', '#ffff63'],
    ['High', '#ffa300'], ['Very High', '#ed1e00'], ['Non-burnable', '#e1e1e1'], ['Water', '#0070e1']
  ]);
});
test('S10 LANDFIRE class-code/color pairs stay pinned while this source remains', () => {
  assert.deepEqual(wildfire.FBFM40_PRESENTATION.classes.map(({ code, color }) => [code, color]), [
    ['NB1','#686868'],['NB2','#e1e1e1'],['NB3','#ffeded'],['NB8','#000ed6'],['NB9','#4d6e70'],
    ['GR1','#ffebbe'],['GR2','#ffd373'],['GR3','#ffec8b'],['GR4','#ffff73'],
    ['GR5','#f5de29'],['GR6','#e6e640'],['GR7','#cdc673'],['GR8','#8b864e'],
    ['GS1','#ffaa00'],['GS2','#ffa77f'],['GS3','#ff6300'],['GS4','#cd6600'],
    ['SH1','#d7c29e'],['SH2','#d7b09e'],['SH3','#cd8966'],['SH4','#895a44'],
    ['SH5','#cdaa66'],['SH6','#ed7044'],['SH7','#cd7d39'],['SH8','#a83800'],['SH9','#731a00'],
    ['TU1','#e9ffbe'],['TU2','#aaff00'],['TU3','#b4d79e'],['TU4','#70a800'],['TU5','#267300'],
    ['TL1','#beffe8'],['TL2','#00ffc5'],['TL3','#bed2ff'],['TL4','#7b68ee'],
    ['TL5','#bee8ff'],['TL6','#00c5ff'],['TL7','#0084a8'],['TL8','#005ce6'],['TL9','#4d6e91'],
    ['SB1','#e8beff'],['SB2','#c500ff'],['SB3','#ffbee8'],['SB4','#ff7f7f']
  ]);
});
function assertE1(rows) {
  assert.deepEqual(rows.map(row => row.opacity), [0, 0.15, 0.38, 0.68, 1, 0, 0]);
  assert.deepEqual(rows.map(({ label, color }) => ({ label, color })), wildfire.USFS_WHP_PRESENTATION.categories);
  for (let i = 1; i < 5; i++) assert.ok(rows[i].opacity >= rows[i - 1].opacity);
}
test('E1 preserves WHP order, monotone hazard alphas and transparent non-hazard classes', () => {
  assertE1(shade.WHP_SHADE_CATEGORIES);
  assert.equal(shade.WHP_SURFACE_OPACITY, 0.55);
  assert.match(shade.WHP_SHADE_QUALIFICATION, /not an all-clear/);
  assert.match(shade.WHP_SHADE_QUALIFICATION, /2023/);
  const changed = shade.WHP_SHADE_CATEGORIES.map(row => ({ ...row }));
  changed[2].opacity = 0.39;
  assert.throws(() => assertE1(changed), 'an E1 alpha mutation must fail the pin');
});
// E2 VHI source/order and rendered proof remain pending D5; no test claims them.
test('the ruled Tribal family is preserved independently of ATNI brand tokens', () => {
  for (const name of ['TRIBAL_FAMILY_COLOR', 'TRIBAL_FILL_COLOR', 'TRIBAL_OUTLINE_COLOR',
    'RESERVATION_FILL_COLOR', 'RESERVATION_OUTLINE_COLOR', 'AIANNH_FILL_COLOR', 'AIANNH_OUTLINE_COLOR']) {
    assert.equal(palette[name], '#8d006b', name);
  }
});
