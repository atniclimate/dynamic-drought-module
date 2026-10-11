import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import pngjs from 'pngjs';

// Historical observed palette, 2026-09-26, week 2026038, tile 5/5/11:
// https://www.star.nesdis.noaa.gov/smcd/emb/vci/VH/image_mapTile.php?type=/j01_500m_VHI/2026038&Z=5&X=5&Y=11
// The fixture is SYNTHETIC: one pixel for each observed palette index.
// It is not an upstream image, current source-health check, or numeric VHI receipt.
// The historical comparison favored index = VHI + 1 (mean offset +1.1 over
// 56,155 pixels), but did not establish that relationship. A future display
// transform must key on exact colors, never infer a numeric value from index.
const png = Buffer.from(readFileSync(new URL('./fixtures/vhi/lb5-palette.png.base64', import.meta.url), 'utf8').trim(), 'base64');
const expectedRuns = [
  [1, 6, [255, 0, 160]], [7, 12, [240, 0, 80]],
  [13, 24, [255, 120, 120]], [25, 36, [255, 170, 0]],
  [37, 48, [255, 255, 85]], [49, 60, [85, 255, 85]],
  [61, 72, [0, 170, 0]], [73, 84, [85, 85, 255]],
  [85, 101, [0, 0, 170]]
];
function chunks(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const result = new Map();
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + 12 + size <= bytes.length);
    result.set(type, bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  return result;
}
function assertObservedPalette(palette, transparency) {
  assert.equal(palette.length, 102 * 3);
  assert.deepEqual([...transparency], [0]);
  assert.deepEqual([...palette.subarray(0, 3)], [180, 180, 255]);
  for (const [first, last, rgb] of expectedRuns) {
    for (let index = first; index <= last; index++) {
      assert.deepEqual([...palette.subarray(index * 3, index * 3 + 3)], rgb, `palette index ${index}`);
    }
  }
}
test('synthetic STAR receipt pins all nine observed RGB runs and transparent index zero', () => {
  const parts = chunks(png);
  const header = parts.get('IHDR');
  assert.equal(header.readUInt32BE(0), 102);
  assert.equal(header.readUInt32BE(4), 1);
  assert.equal(header[8], 8);
  assert.equal(header[9], 3);
  assertObservedPalette(parts.get('PLTE'), parts.get('tRNS'));
  // All 102 indices really occur in the fixture, including every run boundary.
  assert.deepEqual([...inflateSync(parts.get('IDAT'))], [0, ...Array.from({ length: 102 }, (_, index) => index)]);
  // Decode actual PNG pixels through the installed image decoder, including CRC.
  const decoded = pngjs.PNG.sync.read(png);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [180, 180, 255, 0]);
  for (const [first, last, rgb] of expectedRuns) {
    for (let index = first; index <= last; index++) {
      assert.deepEqual([...decoded.data.subarray(index * 4, index * 4 + 4)], [...rgb, 255]);
    }
  }
});
test('receipt rejects a shifted class boundary, changed color, and lost transparency', () => {
  const parts = chunks(png);
  const shifted = Buffer.from(parts.get('PLTE'));
  shifted.set([240, 0, 80], 6 * 3);
  assert.throws(() => assertObservedPalette(shifted, parts.get('tRNS')), /palette index 6/);
  const changed = Buffer.from(parts.get('PLTE'));
  changed[101 * 3 + 2] = 169;
  assert.throws(() => assertObservedPalette(changed, parts.get('tRNS')), /palette index 101/);
  assert.throws(() => assertObservedPalette(parts.get('PLTE'), Buffer.from([255])), assert.AssertionError);
});

// D5 N8 pure consumer. No live layer, canvas, MapLibre or protocol registration.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts')) {
      const target = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(target))) return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  }
});
const { shadeDrynessPixels } = await import('../src/layers/dryness-grey-protocol.ts');
const { STAR_DRYNESS_CLASSES, RG_DRYNESS_CLASSES, RG_NOT_ASSESSED_COLORS } = await import('../src/config/dryness-ground.ts');
const rgba = (hex, alpha = 255) => [...hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16)), alpha];
const STAR_GREYS = ['#1F1F1F', '#262626', '#2D2D2D', '#343434', '#3B3B3B', '#434343', '#4A4A4A', '#525252', '#595959'];
const RG_SOURCE = ['#732600', '#E60000', '#F57A7A', '#FFD37F', '#FFFF00', '#C7D79E', '#89CD66', '#98E600', '#70A800', '#5C8944'];
const RG_GREYS = ['#1F1F1F', '#252525', '#2C2C2C', '#323232', '#383838', '#3F3F3F', '#454545', '#4C4C4C', '#535353', '#595959'];

test('dryness STAR consumer transforms the decoded independent102-index fixture by class, not numeric index', () => {
  assert.deepEqual(STAR_DRYNESS_CLASSES.map(row => rgba(row.source).slice(0, 3)), expectedRuns.map(row => row[2]));
  assert.deepEqual(STAR_DRYNESS_CLASSES.map(row => row.grey), STAR_GREYS);
  const decoded = pngjs.PNG.sync.read(png);
  const pixels = new Uint8ClampedArray(decoded.data);
  const expected = [...rgba('#858585')];
  for (let index = 1; index <= 101; index++) {
    const run = expectedRuns.findIndex(([first, last]) => index >= first && index <= last);
    expected.push(...rgba(STAR_GREYS[run]));
  }
  shadeDrynessPixels(pixels, 'star-vhi');
  assert.deepEqual([...pixels], expected);
});

test('dryness RG source receipt pins issuer bytes separately from the ten DDM grey outputs', () => {
  const bytes = readFileSync(new URL('./fixtures/vhi/rg-legend.json', import.meta.url));
  // Preserve issuer content while tolerating checkout newline conversion.
  const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n').trim() + '\n';
  assert.equal(createHash('sha256').update(normalized).digest('hex'), '3d403f26eb6f1a0ba9ea55829b6d13311b6bc6dce18e093fba65b35128b937c1');
  const entries = JSON.parse(bytes).Legend[0].rules[0].symbolizers[0].Raster.colormap.entries;
  const measured = entries.filter(row => Number(row.quantity) >= 11 && Number(row.quantity) <= 101);
  assert.deepEqual(measured.map(row => row.color), RG_SOURCE);
  assert.ok(measured.every(row => row.opacity === '1.0'));
  assert.deepEqual(RG_DRYNESS_CLASSES.map(row => row.source), RG_SOURCE);
  assert.deepEqual(RG_DRYNESS_CLASSES.map(row => row.grey), RG_GREYS);
  assert.deepEqual(RG_NOT_ASSESSED_COLORS, ['#FFFFFF', '#1E1E1E', '#73B2FF']);
  assert.deepEqual(entries.filter(row => row.color === '#FFFFFF').map(row => row.quantity), ['1.0', '251.0']);
  const pixels = new Uint8ClampedArray(measured.flatMap(row => rgba(row.color)));
  shadeDrynessPixels(pixels, 'relative-greenness');
  assert.deepEqual([...pixels], RG_GREYS.flatMap(color => rgba(color)));
});

test('dryness absence is opaque neutral, including ambiguous RG white and transparent unknown RGB', () => {
  const rgPixels = new Uint8ClampedArray(['#FFFFFF', '#1E1E1E', '#73B2FF'].flatMap(color => rgba(color)).concat(rgba('#123456', 0)));
  shadeDrynessPixels(rgPixels, 'relative-greenness');
  assert.deepEqual([...rgPixels], Array.from({ length: 4 }, () => rgba('#858585')).flat());
  const starPixels = new Uint8ClampedArray([...rgba('#B4B4FF', 0), ...rgba('#123456', 0)]);
  shadeDrynessPixels(starPixels, 'star-vhi');
  assert.deepEqual([...starPixels], [...rgba('#858585'), ...rgba('#858585')]);
});

test('unknown visible class rejects the whole tile without changing earlier known or absent pixels', () => {
  for (const [product, known] of [['star-vhi', '#FF00A0'], ['relative-greenness', '#732600']]) {
    const pixels = new Uint8ClampedArray([...rgba(known), ...rgba('#123456', 0), ...rgba('#123456')]);
    const before = pixels.slice();
    assert.throws(() => shadeDrynessPixels(pixels, product), /Unrecognized dryness class/);
    assert.deepEqual(pixels, before);
  }
  // RG's opaque white exception must not leak across product identity.
  assert.throws(() => shadeDrynessPixels(new Uint8ClampedArray(rgba('#FFFFFF')), 'star-vhi'), /Unrecognized dryness class/);
});

test('partial alpha and malformed RGBA fail before mutation instead of inventing an interpolated class', () => {
  for (const [product, known] of [['star-vhi', '#FF00A0'], ['relative-greenness', '#732600']]) {
    for (const alpha of [1, 127, 254]) {
      const pixels = new Uint8ClampedArray([...rgba(known), ...rgba(known, alpha)]);
      const before = pixels.slice();
      assert.throws(() => shadeDrynessPixels(pixels, product), /Unsupported dryness alpha/);
      assert.deepEqual(pixels, before);
    }
    const malformed = new Uint8ClampedArray([...rgba(known), 0]);
    const before = malformed.slice();
    assert.throws(() => shadeDrynessPixels(malformed, product), /Invalid dryness RGBA length/);
    assert.deepEqual(malformed, before);
    assert.doesNotThrow(() => shadeDrynessPixels(new Uint8ClampedArray(), product));
  }
});

test('lightness contract: High and Very High fuel risk read brighter than every plant-stress grey; Low and Moderate overlap', async () => {
  const { WHP_SHADE_CATEGORIES } = await import('../src/config/whp-shade.ts');
  const { DRAPE_OPACITY } = await import('../src/config/wildfire-presentation.ts');
  const { MAP_GROUND_COLOR } = await import('../src/config/interface-tokens.ts');
  const { DRYNESS_NOT_ASSESSED_COLOR } = await import('../src/config/dryness-ground.ts');
  // CIE L* of an sRGB grey level 0..1 (D65); the drape is white, blended in sRGB as c = g(1 - a) + a.
  const lstar = (level) => {
    const y = level <= 0.04045 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4;
    return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
  };
  const level = (hex) => rgba(hex)[0] / 255;
  // The CIEDE2000 lightness term alone, a lower bound on the full difference.
  const lightnessDe = (a, b) => {
    const mean = (a + b) / 2 - 50;
    return Math.abs(a - b) / (1 + (0.015 * mean ** 2) / Math.sqrt(20 + mean ** 2));
  };
  const alphas = WHP_SHADE_CATEGORIES.slice(0, 5).map(row => row.opacity * DRAPE_OPACITY);
  assert.deepEqual(alphas.map(value => +value.toFixed(3)), [0, 0.075, 0.19, 0.34, 0.5]);
  for (const classes of [STAR_DRYNESS_CLASSES, RG_DRYNESS_CLASSES]) {
    const greys = classes.map(row => level(row.grey));
    greys.slice(1).forEach((grey, index) => assert.ok(lstar(grey) - lstar(greys[index]) >= 2.5, `step ${index}`));
    const darkest = greys[0], lightest = lstar(greys.at(-1));
    const over = (alpha) => lstar(darkest * (1 - alpha) + alpha);
    assert.ok(over(alphas[3]) >= lightest + 1 && over(alphas[4]) >= lightest + 1);
    // Low and Moderate land inside the grey range: the briefing's fuelRiskOverlap sentence is owed.
    assert.ok(over(alphas[1]) < lightest && over(alphas[2]) < lightest);
    const neutral = lstar(level(DRYNESS_NOT_ASSESSED_COLOR));
    for (const other of [...greys, rgba(MAP_GROUND_COLOR)[1] / 255]) assert.ok(lightnessDe(neutral, lstar(other)) >= 10);
  }
});

test('the Impact Briefing carries the plant-stress full text, with NOAA STAR\'s disclaimer whole only beside STAR data', async () => {
  const { DRYNESS_BRIEFING_NOTES: notes, DRYNESS_KEY, drynessBriefing } = await import('../src/layers/wildfire-dryness.ts');
  const { renderMapTechnicalInformation, setPlantStressBriefing } = await import('../src/ui/map-technical-information.ts');
  const { escapeHtml } = await import('../src/util/escape.ts');
  const frame = (productKey) => ({ productKey, clockLabel: 'Week 40: Oct 1 to Oct 7, 2026', qualification: 'definition', coverage: 'coverage' });
  assert.ok(notes.starDisclaimer.includes('not official NOAA operational products') && notes.starDisclaimer.endsWith('redundant operations."'));

  assert.ok(!renderMapTechnicalInformation().includes('Plant stress ground'));
  setPlantStressBriefing(drynessBriefing(frame('star-vhi')));
  const star = renderMapTechnicalInformation();
  for (const line of [DRYNESS_KEY.starTitle, 'Week 40: Oct 1 to Oct 7, 2026', notes.starMeaning, notes.starScope, notes.starRevision,
    notes.starDesert, notes.starMiddle, notes.fuelRiskOverlap, notes.fuelRiskVintage, notes.twoProducts, notes.starDisclaimer]) {
    assert.ok(star.includes(`<p>${escapeHtml(line)}</p>`), line);
  }
  assert.ok(star.includes(`href="${notes.starDisclaimerUrl}"`));

  setPlantStressBriefing(drynessBriefing(frame('usgs-relative-greenness')));
  const rg = renderMapTechnicalInformation();
  assert.ok(rg.includes(escapeHtml(notes.rgLowValues)) && rg.includes(escapeHtml(DRYNESS_KEY.rgTitle)));
  assert.ok(!rg.includes('STAR says') && !rg.includes(notes.starDisclaimerUrl));

  setPlantStressBriefing(null);
  assert.ok(!renderMapTechnicalInformation().includes('Plant stress ground'));
});
