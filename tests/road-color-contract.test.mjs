import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { lab, deltaLab, de, ramp, contrast, rgb } from './road-color-math.mjs';

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
const p = await import('../src/config/palette.ts');
const w = await import('../src/config/wildfire-presentation.ts');
const near = (actual, expected, tolerance = 0.00005) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' != ' + expected);

test('independent color arithmetic matches published CIEDE2000 references', () => {
  // Sharma/Wu/Dalal supplemental testdata rows 1, 7, 11 and 17.
  // https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
  for (const [a, b, expected] of [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, 2.5, 0], [73, 25, -18], 27.1492]
  ]) {
    near(deltaLab(a, b), expected);
    near(deltaLab(b, a), expected);
  }
  near(contrast('#000000', '#FFFFFF'), 21);
  near(lab('#FFFFFF')[0], 100);
  near(de('#636363', '#636363'), 0);
});

test('D8 class 1 to 3 contract uses retokened OKLab steps and separate treatment tokens', () => {
  assert.deepEqual(p.ROAD_CLASS_COLORS, { 1: '#898A8B', 2: '#767677', 3: '#636363' });
  [0.30, 0.15, 0].forEach((t, i) =>
    assert.equal(ramp(t).toUpperCase(), p.ROAD_CLASS_COLORS[i + 1]));
  assert.equal(p.ROAD_CASING, '#010B13');
  assert.deepEqual(p.ROAD_HALO, { color: '#E8ECF0', opacity: 0.6 });
  assert.deepEqual(p.ROAD_NOT_ASSESSED_KNOCKOUT, { color: '#010B13', opacity: 0.9 });
  // The endpoint remains the halo, not a permissible road core.
  assert.ok(de('#E8ECF0', '#cbd5e1') < 10);
});

// These are actual current hazard/perimeter line uses, not raster fill colors.
// BC No update contributes its RGB class value; transparent fallbacks have no ink.
// USDM outlines currently have opacity zero; include their declared ink defensively.
// ENSO flow is observational, included conservatively; context boundaries excluded.
function actualLineColors() {
  return [
    ...Object.values(p.DROUGHT_COLORS),
    ...p.CDM_CATEGORIES.map(row => row.color),
    ...p.USDM_CATEGORIES.map(row => row.color),
    ...p.BC_DROUGHT_LEVELS.map(row => row.color), '#CCCCCC',
    ...Object.values(p.NWS_ALERT_COLORS), p.NWS_ALERT_DEFAULT_COLOR,
    ...p.SPC_FIREWX_CATEGORIES.map(row => row.color), p.SPC_FIREWX_DEFAULT_COLOR,
    ...Object.values(w.NIFC_INCIDENT_PRESENTATION).map(row => row.lineColor),
    '#e2e8f0', '#142137', '#f8fafc',
    ...p.USDM_CHANGE_COLORS.map(row => row.color),
    // All possible rounded pulse RGB values, not just endpoint samples.
    ...Array.from({ length: 52 }, (_, i) => '#ff' + (51 + i).toString(16).padStart(2, '0') + '00')
  ];
}
test('every road step meets the unchanged ground, NIFC and actual line-color floors', () => {
  for (const core of Object.values(p.ROAD_CLASS_COLORS)) {
    for (const background of ['#010B13', '#0b1220', '#FFFFFF']) {
      assert.ok(Math.max(contrast(core, background), contrast(p.ROAD_CASING, background)) >= 3,
        core + ' package on ' + background);
    }
    for (const neutral of ['#94a3b8', '#cbd5e1']) {
      assert.ok(de(core, neutral) >= 10, core + ' vs NIFC ' + neutral);
    }
    for (const line of actualLineColors()) {
      assert.ok(de(core, line) >= 5, core + ' vs line ' + line);
    }
  }
});

test('S15 conditional fallback has internal and universal two-ink contrast, not issuer certification', () => {
  assert.deepEqual(p.CAUTION_LINE_COLORS, { yellow: '#FFD100', black: '#000000' });
  const { yellow, black } = p.CAUTION_LINE_COLORS;
  const internal = contrast(yellow, black);
  assert.ok(internal >= 7);
  // For any background luminance between the ink luminances, the minimum
  // possible max contrast is sqrt(internal); outside the interval it is larger.
  assert.ok(Math.sqrt(internal) >= 3);
  const sourceColors = JSON.stringify([p, w]).match(/#[a-fA-F0-9]{6}/g);
  assert.ok(sourceColors?.length);
  for (const color of new Set(sourceColors)) {
    for (const background of ['#010B13', '#0b1220', '#FFFFFF', '#000000', '#808080']) {
      for (const alpha of [0, 0.35, 0.42, 0.45, 0.48, 0.54, 0.78, 0.82, 0.92, 1]) {
        const base = rgb(background);
        const composite = '#' + rgb(color).map((v, i) =>
          Math.round(v * alpha + base[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
        assert.ok(Math.max(contrast(yellow, composite), contrast(black, composite)) >= 3);
      }
    }
  }
});

test('known unresolved S15 versus official USDM change +2 conflict stays explicit', () => {
  // This is a diagnostic ratchet, NOT acceptance of the every-source dE>=5 criterion.
  const worsenedTwo = p.USDM_CHANGE_COLORS.find(row => row.dn === 2)?.color;
  assert.equal(worsenedTwo, '#FFD438');
  const distance = de(p.CAUTION_LINE_COLORS.yellow, worsenedTwo);
  near(distance, 2.1311919162711885, 1e-9);
  assert.ok(distance < 5, 'If changed, reassess the unresolved owner decision; do not silently certify S15');
});
