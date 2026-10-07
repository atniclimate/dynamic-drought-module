import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
        context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  }
});
const charts = await import('../src/ui/charts.ts');
const palette = await import('../src/config/palette.ts');

function cpcWidths(svg) {
  return [...svg.matchAll(/<rect\b[^>]*\swidth="([\d.]+)"[^>]*>/g)]
    .map(match => Number(match[1]));
}

test('CPC inferred bar areas preserve source percentages across the issuer breakpoint', () => {
  // Independent worked distributions from the CPC reading guide, Below/Near/Above.
  const aboveCases = [
    [33, [33.67, 33.33, 33]],
    [40, [26.67, 33.33, 40]],
    [60, [6.67, 33.33, 60]],
    [63.32, [3.35, 33.33, 63.32]],
    [63.33, [3.33, 33.34, 63.33]],
    [70, [3.33, 26.67, 70]],
    [90, [3.33, 6.67, 90]]
  ];
  for (const variable of ['temperature', 'precipitation']) {
    for (const window of ['6-10 day', '8-14 day']) {
      for (const cat of ['Above', 'Below']) {
        for (const [prob, distribution] of aboveCases) {
          const expected = cat === 'Above' ? distribution : [...distribution].reverse();
          const svg = charts.cpcOutlookBarsSvg({ variable, cat, prob, window });
          const widths = cpcWidths(svg);
          assert.equal(widths.length, 3);
          // The actual SVG's 268px plotting area must give the source favored
          // probability its stated share, rather than normalize a 103.3 total.
          expected.forEach((pct, i) =>
            assert.ok(Math.abs(widths[i] - pct * 2.68) <= 0.051, cat + '/' + prob + '/' + i));
          assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 268) <= 0.11);
          assert.ok(svg.includes(cat + ' normal favored at ' + Math.round(prob) + ' percent'));
        }
      }
    }
  }
});

test('CPC Normal has its stated distribution while EC has no favored chart', () => {
  const normal = charts.cpcOutlookBarsSvg({ variable: 'temperature', cat: 'Normal', prob: 36, window: '6-10 day' });
  assert.deepEqual(cpcWidths(normal), [85.8, 96.5, 85.8]);
  assert.match(normal, /near-normal favored at 36 percent/);
  for (const prob of [0, 33, NaN, undefined]) {
    const ec = charts.cpcOutlookBarsSvg({ variable: 'temperature', cat: 'EC', prob, window: '6-10 day' });
    assert.equal(ec, '');
  }
});

test('CPC missing or unsupported reconstruction input does not fabricate a chart', () => {
  for (const prob of [NaN, Infinity, undefined, null, -1, 0, 32, 97, 101]) {
    assert.equal(charts.cpcOutlookBarsSvg({ variable: 'temperature', cat: 'Above', prob, window: '6-10 day' }), '');
  }
  assert.equal(charts.cpcOutlookBarsSvg({ variable: 'temperature', cat: 'unknown', prob: 50, window: '6-10 day' }), '');
});
const phases = [
  { seas: 'DJF', year: 2025, anom: -0.7 },
  { seas: 'JFM', year: 2025, anom: 0.6 }
];
test('ONI reference guides use historical CPC colors while measured series stay neutral', () => {
  const svg = charts.oniLineSvg(phases, { title: 'Fixture', source: 'Fixture',
    compare: { label: 'RONI', values: phases } });
  const colored = [...svg.matchAll(/<(?:line|polyline|circle)\b[^>]+(?:stroke|fill)="([^"]+)"[^>]*>/g)].map(m => m[0]);
  for (const color of ['#ff0000', '#0000ff', '#f1f5f9', '#94a3b8']) {
    assert.ok(colored.some(tag => tag.includes('"' + color + '"')), color);
  }
  assert.doesNotMatch(svg, /var\(--(?:warn|good|accent)\)/);
  assert.match(svg, /El Nino \+0\.5/);
  assert.match(svg, /La Nina -0\.5/);
});
test('ENSO plume lines preserve three phase colors and redundant line styles', () => {
  const svg = charts.ensoPlumeSvg([
    { seas: 'DJF', elNino: 20, neutral: 30, laNina: 50 },
    { seas: 'JFM', elNino: 30, neutral: 40, laNina: 30 }
  ], { title: 'Fixture', source: 'Fixture' });
  const lines = [...svg.matchAll(/<polyline\b[^>]*>/g)].map(m => m[0]);
  assert.equal(lines.length, 3);
  ['#f59e0b', '#94a3b8', '#06b6d4'].forEach((color, i) =>
    assert.ok(lines[i].includes('stroke="' + color + '"')));
  assert.match(lines[1], /stroke-dasharray="4 2"/);
  assert.match(lines[2], /stroke-dasharray="2 2"/);
});
const INDEX_GUIDE_EXPECTED = {
  ONI: { warm: '#ff0000', cold: '#0000ff' },
  RONI: { warm: '#e80016', cold: '#195fe4' }
};
function indexGuideMarks(svg) {
  return [...svg.matchAll(/<line\b[^>]*data-index-guide="(?:warm|cold)"[^>]*>/g)]
    .map(match => match[0].match(/stroke="([^"]+)"/)[1]);
}
test('S13 guide source is explicit and does not follow arbitrary primary-label wording', () => {
  assert.deepEqual(palette.ENSO_INDEX_GUIDE_COLORS, INDEX_GUIDE_EXPECTED);
  for (const guideSource of ['ONI', 'RONI']) {
    const svg = charts.oniLineSvg(phases, {
      title: 'Fixture', source: 'Fixture', primaryLabel: 'Arbitrary series label', guideSource
    });
    const expected = INDEX_GUIDE_EXPECTED[guideSource];
    assert.deepEqual(indexGuideMarks(svg), [expected.warm, expected.cold]);
    const casings = [...svg.matchAll(/<line\b[^>]*data-index-guide-casing="(?:warm|cold)"[^>]*>/g)].map(m => m[0]);
    assert.equal(casings.length, 2);
    for (const casing of casings) {
      assert.ok(casing.includes('stroke="var(--fg-1)"'));
      assert.ok(casing.includes('stroke-width="1.6"'));
      assert.ok(casing.includes('stroke-dasharray="3 3"'));
    }
    assert.ok(svg.includes('fill="var(--fg-1)" font-size="7.5" text-anchor="end">El Nino +0.5'));
    assert.ok(svg.includes('fill="var(--fg-1)" font-size="7.5" text-anchor="end">La Nina -0.5'));
  }
});
test('S13 source-table mutation reaches actual guide markup and leaves the plume untouched', () => {
  assert.deepEqual(palette.ENSO_INDEX_GUIDE_COLORS, INDEX_GUIDE_EXPECTED);
  const plumeValues = [{ seas: 'DJF', elNino: 20, neutral: 30, laNina: 50 },
    { seas: 'JFM', elNino: 30, neutral: 40, laNina: 30 }];
  const opts = { title: 'Fixture', source: 'Fixture' };
  const beforePlume = charts.ensoPlumeSvg(plumeValues, opts);
  const beforeOni = charts.oniLineSvg(phases, opts);
  const saved = palette.ENSO_INDEX_GUIDE_COLORS.RONI.warm;
  try {
    palette.ENSO_INDEX_GUIDE_COLORS.RONI.warm = '#123456';
    assert.throws(() => assert.deepEqual(palette.ENSO_INDEX_GUIDE_COLORS, INDEX_GUIDE_EXPECTED));
    assert.deepEqual(indexGuideMarks(charts.oniLineSvg(phases, { ...opts, guideSource: 'RONI' })),
      ['#123456', '#195fe4']);
    assert.equal(charts.oniLineSvg(phases, opts), beforeOni);
    assert.equal(charts.ensoPlumeSvg(plumeValues, opts), beforePlume);
  } finally {
    palette.ENSO_INDEX_GUIDE_COLORS.RONI.warm = saved;
  }
  assert.deepEqual(palette.ENSO_INDEX_GUIDE_COLORS, INDEX_GUIDE_EXPECTED);
});
// Independent literal pins from NOAA's uniqueValue renderer rows, 2026-10-07.
// These are exact cat,prob pairs, not intervals or a general probability domain.
const CPC_RENDERER_EXPECTED = {
  temperature: {
    'Above,33': '#E7B168',
    'Above,40': '#E38B4B',
    'Above,50': '#DA5731',
    'Above,60': '#C93B1A',
    'Above,70': '#B32E05',
    'Above,80': '#912600',
    'Above,90': '#702100',
    'Normal,36': '#A0A0A0',
    'Below,33': '#BFCBE4',
    'Below,40': '#A0C0DF',
    'Below,50': '#77B5E2',
    'Below,60': '#389FDC',
    'Below,70': '#005DA1',
    'Below,80': '#2E216F',
    'Below,90': '#221852'
  },
  precipitation: {
    'Above,33': '#B3D9AB',
    'Above,40': '#95CE7F',
    'Above,50': '#48B430',
    'Above,60': '#009620',
    'Above,70': '#007814',
    'Above,80': '#28600A',
    'Above,90': '#285300',
    'Normal,36': '#A0A0A0',
    'Below,33': '#F0D493',
    'Below,40': '#D8A74F',
    'Below,50': '#BB6D33',
    'Below,60': '#9B5031',
    'Below,70': '#934639',
    'Below,80': '#804000',
    'Below,90': '#4F2F2F'
  }
};

function cpcFills(svg) {
  return [...svg.matchAll(/<rect\b[^>]*fill="([^"]+)"[^>]*>/g)].map(match => match[1]);
}

test('S14 exact source rows and actual favored SVG colors agree for both windows', () => {
  assert.deepEqual(palette.CPC_OUTLOOK_TERCILE_COLORS, CPC_RENDERER_EXPECTED);
  for (const [variable, rows] of Object.entries(CPC_RENDERER_EXPECTED)) {
    for (const [key, color] of Object.entries(rows)) {
      const [cat, probability] = key.split(',');
      const index = cat === 'Below' ? 0 : cat === 'Normal' ? 1 : 2;
      for (const window of ['6-10 day', '8-14 day']) {
        const svg = charts.cpcOutlookBarsSvg({ variable, cat, prob: Number(probability), window });
        const expected = ['var(--bg-3)', 'var(--bg-3)', 'var(--bg-3)'];
        expected[index] = color;
        assert.deepEqual(cpcFills(svg), expected, variable + '/' + key + '/' + window);
        assert.doesNotMatch(svg, /var\(--(?:warn|good|accent)\)/);
      }
    }
  }
});

test('S14 unmatched probability, variable or window never borrows an issuer hue', () => {
  for (const input of [
    { variable: 'temperature', cat: 'Above', prob: 33.33, window: '6-10 day' },
    { variable: 'temperature', cat: 'Above', prob: 63.33, window: '6-10 day' },
    { variable: 'precipitation', cat: 'Below', prob: 39, window: '8-14 day' },
    { variable: 'temperature', cat: 'Normal', prob: 50, window: '6-10 day' },
    { variable: 'humidity', cat: 'Above', prob: 70, window: '6-10 day' },
    { variable: 'temperature', cat: 'Above', prob: 70, window: 'seasonal' }
  ]) {
    const svg = charts.cpcOutlookBarsSvg(input);
    assert.deepEqual(cpcFills(svg), ['var(--bg-3)', 'var(--bg-3)', 'var(--bg-3)']);
    assert.ok(svg.includes('at ' + Math.round(input.prob) + ' percent'));
  }
});

test('S14 actual consumer observes a source-table mutation and independent pins reject it', () => {
  const actual = palette.CPC_OUTLOOK_TERCILE_COLORS.temperature;
  const hadRow = Object.hasOwn(actual, 'Above,70');
  const saved = actual['Above,70'];
  try {
    actual['Above,70'] = '#123456';
    assert.throws(() => assert.deepEqual(palette.CPC_OUTLOOK_TERCILE_COLORS, CPC_RENDERER_EXPECTED));
    const svg = charts.cpcOutlookBarsSvg({
      variable: 'temperature', cat: 'Above', prob: 70, window: '6-10 day'
    });
    assert.deepEqual(cpcFills(svg), ['var(--bg-3)', 'var(--bg-3)', '#123456']);
  } finally {
    if (hadRow) actual['Above,70'] = saved;
    else delete actual['Above,70'];
  }
});
test('observation sparkline and index trend retain cyan independent of interface accent', () => {
  for (const svg of [
    charts.sparklineSvg([1, 2, 3], { title: 'Fixture' }),
    charts.trendLineSvg([{ t: 1, v: 10 }, { t: 2, v: 20 }], { title: 'Fixture', yMax: 500, yLabel: 'DSCI' })
  ]) {
    assert.match(svg, /stroke="#06b6d4"/);
    assert.match(svg, /fill="#06b6d4"/);
    assert.doesNotMatch(svg, /var\(--accent\)/);
  }
});
