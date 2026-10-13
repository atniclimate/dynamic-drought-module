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
const { STAR_DRYNESS_CLASSES, RG_DRYNESS_CLASSES, RG_NOT_ASSESSED_COLORS, STAR_LAND_COVER_DRAWN, STAR_LAND_COVER_MASKED } =
  await import('../src/config/dryness-ground.ts');
const rgba = (hex, alpha = 255) => [...hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16)), alpha];
// DR-199: white at a per-class alpha, most stressed 40%, healthiest 4%, even steps; no value is fully transparent.
const STAR_ALPHAS = [0.4, 0.355, 0.31, 0.265, 0.22, 0.175, 0.13, 0.085, 0.04];
const RG_SOURCE = ['#732600', '#E60000', '#F57A7A', '#FFD37F', '#FFFF00', '#C7D79E', '#89CD66', '#98E600', '#70A800', '#5C8944'];
const RG_ALPHAS = [0.4, 0.36, 0.32, 0.28, 0.24, 0.2, 0.16, 0.12, 0.08, 0.04];
const CLEAR = [0, 0, 0, 0];
const white = (alpha) => [255, 255, 255, Math.round(alpha * 255)];

test('dryness STAR consumer transforms the decoded independent102-index fixture by class, not numeric index', () => {
  assert.deepEqual(STAR_DRYNESS_CLASSES.map(row => rgba(row.source).slice(0, 3)), expectedRuns.map(row => row[2]));
  assert.deepEqual(STAR_DRYNESS_CLASSES.map(row => row.alpha), STAR_ALPHAS);
  const decoded = pngjs.PNG.sync.read(png);
  const pixels = new Uint8ClampedArray(decoded.data);
  const expected = [...CLEAR];
  for (let index = 1; index <= 101; index++) {
    const run = expectedRuns.findIndex(([first, last]) => index >= first && index <= last);
    expected.push(...white(STAR_ALPHAS[run]));
  }
  shadeDrynessPixels(pixels, 'star-vhi');
  assert.deepEqual([...pixels], expected);
});

test('dryness RG source receipt pins issuer bytes separately from the ten DDM white-alpha outputs', () => {
  const bytes = readFileSync(new URL('./fixtures/vhi/rg-legend.json', import.meta.url));
  // Preserve issuer content while tolerating checkout newline conversion.
  const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n').trim() + '\n';
  assert.equal(createHash('sha256').update(normalized).digest('hex'), '3d403f26eb6f1a0ba9ea55829b6d13311b6bc6dce18e093fba65b35128b937c1');
  const entries = JSON.parse(bytes).Legend[0].rules[0].symbolizers[0].Raster.colormap.entries;
  const measured = entries.filter(row => Number(row.quantity) >= 11 && Number(row.quantity) <= 101);
  assert.deepEqual(measured.map(row => row.color), RG_SOURCE);
  assert.ok(measured.every(row => row.opacity === '1.0'));
  assert.deepEqual(RG_DRYNESS_CLASSES.map(row => row.source), RG_SOURCE);
  assert.deepEqual(RG_DRYNESS_CLASSES.map(row => row.alpha), RG_ALPHAS);
  assert.deepEqual(RG_NOT_ASSESSED_COLORS, ['#FFFFFF', '#1E1E1E', '#73B2FF']);
  assert.deepEqual(entries.filter(row => row.color === '#FFFFFF').map(row => row.quantity), ['1.0', '251.0']);
  const pixels = new Uint8ClampedArray(measured.flatMap(row => rgba(row.color)));
  shadeDrynessPixels(pixels, 'relative-greenness');
  assert.deepEqual([...pixels], RG_ALPHAS.flatMap(alpha => white(alpha)));
});

test('dryness absence is fully transparent, including ambiguous RG white and transparent unknown RGB', () => {
  const rgPixels = new Uint8ClampedArray(['#FFFFFF', '#1E1E1E', '#73B2FF'].flatMap(color => rgba(color)).concat(rgba('#123456', 0)));
  shadeDrynessPixels(rgPixels, 'relative-greenness');
  assert.deepEqual([...rgPixels], Array.from({ length: 4 }, () => CLEAR).flat());
  const starPixels = new Uint8ClampedArray([...rgba('#B4B4FF', 0), ...rgba('#123456', 0)]);
  shadeDrynessPixels(starPixels, 'star-vhi');
  assert.deepEqual([...starPixels], [...CLEAR, ...CLEAR]);
});

// NOAA STAR's land-cover tile palette, observed live 2026-10-11 (ancillary//IGBPlandtype, tiles 0/0/0, 3/2/2, 5/5/11
// and six more): eighteen entries, index 0 transparent. Classes 15, 16 and 17 and the transparent index are not drawn.
const LAND_COVER = ['#008000', '#00FF00', '#99CC00', '#99FF99', '#339966', '#993366', '#FFCC99', '#CCFFCC', '#FFCC00',
  '#FF9900', '#006699', '#FFFF00', '#FF0000', '#999966', '#FFFFFF', '#808080', '#000080'];

test('land-cover mask: snow and ice, bare ground, water and unclassed pixels are fully transparent; the fourteen other classes keep their plant stress', () => {
  assert.deepEqual([...STAR_LAND_COVER_DRAWN, ...STAR_LAND_COVER_MASKED], LAND_COVER);
  assert.deepEqual(STAR_LAND_COVER_MASKED, ['#FFFFFF', '#808080', '#000080']);
  // Every land-cover class over the most stressed plant-health class, then the transparent index 0 (STAR: "0 - Undefined").
  const mask = new Uint8ClampedArray([...LAND_COVER.flatMap(color => rgba(color)), ...rgba('#000080', 0)]);
  const pixels = new Uint8ClampedArray(Array.from({ length: 18 }, () => rgba('#FF00A0')).flat());
  shadeDrynessPixels(pixels, 'star-vhi', mask);
  assert.deepEqual([...pixels], [...Array.from({ length: 14 }, () => white(0.4)).flat(), ...CLEAR, ...CLEAR, ...CLEAR, ...CLEAR]);
  // A source pixel with no measurement stays transparent under a drawn class.
  const absent = new Uint8ClampedArray(rgba('#B4B4FF', 0));
  shadeDrynessPixels(absent, 'star-vhi', new Uint8ClampedArray(rgba('#008000')));
  assert.deepEqual([...absent], CLEAR);
});

test('land-cover mask fails closed: an unknown colour, a partial alpha or a different size rejects the whole tile without changing it', () => {
  const source = [...rgba('#FF00A0'), ...rgba('#0000AA')];
  for (const [mask, expected] of [
    [[...rgba('#008000'), ...rgba('#123456')], /Unrecognized land-cover class/],
    [[...rgba('#008000'), ...rgba('#808080', 128)], /Unrecognized land-cover class/],
    [rgba('#008000'), /Invalid dryness land-cover mask/]
  ]) {
    const pixels = new Uint8ClampedArray(source), before = pixels.slice();
    assert.throws(() => shadeDrynessPixels(pixels, 'star-vhi', new Uint8ClampedArray(mask)), expected);
    assert.deepEqual(pixels, before);
  }
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

test('whiteness contract (DR-199): whiter means higher risk in both layers; the flat fuel-risk view is unchanged', async () => {
  const { WHP_SHADE_CATEGORIES, WHP_3D_SHADE_CATEGORIES, WHP_SHADE_QUALIFICATION, WHP_SURFACE_OPACITY } = await import('../src/config/whp-shade.ts');
  const { shadeWhpPixels, WHP_3D_SHADE_ALPHA_BY_RGB } = await import('../src/layers/whp-shade-protocol.ts');
  // Plant stress: strictly whiter with stress, 40% at the top, a 4% lift at the bottom, even steps.
  for (const classes of [STAR_DRYNESS_CLASSES, RG_DRYNESS_CLASSES]) {
    const alphas = classes.map(row => row.alpha);
    assert.equal(alphas[0], 0.4);
    assert.equal(alphas.at(-1), 0.04);
    const step = 0.36 / (alphas.length - 1);
    alphas.slice(1).forEach((alpha, index) => {
      assert.ok(alpha < alphas[index], `step ${index} is not monotone`);
      assert.ok(Math.abs(alphas[index] - alpha - step) < 1e-9, `step ${index} is not even`);
    });
  }
  // Fuel risk in Wildfire 3D: the table IS the effective white opacity, because the drape layer draws at opacity 1.
  assert.deepEqual(WHP_3D_SHADE_CATEGORIES.map(row => row.opacity), [0, 0.1, 0.2, 0.4, 0.8, 0, 0]);
  assert.deepEqual(WHP_3D_SHADE_CATEGORIES.map(({ label, color }) => ({ label, color })),
    WHP_SHADE_CATEGORIES.map(({ label, color }) => ({ label, color })));
  assert.match(readFileSync(new URL('../src/layers/whp-3d.ts', import.meta.url), 'utf8'), /'raster-opacity': 1,/);
  const whp = () => new Uint8ClampedArray(WHP_SHADE_CATEGORIES.flatMap(row => rgba(row.color)));
  const alphaBytes = (pixels) => [...pixels].filter((_, index) => index % 4 === 3);
  const drape = whp();
  shadeWhpPixels(drape, WHP_3D_SHADE_ALPHA_BY_RGB);
  assert.deepEqual(alphaBytes(drape), [0, 26, 51, 102, 204, 0, 0]);
  // The flat Wildfire view keeps its own picture.
  assert.deepEqual(WHP_SHADE_CATEGORIES.map(row => row.opacity), [0, 0.15, 0.38, 0.68, 1, 0, 0]);
  assert.equal(WHP_SURFACE_OPACITY, 0.55);
  const flat = whp();
  shadeWhpPixels(flat);
  assert.deepEqual(alphaBytes(flat), [0, 38, 97, 173, 255, 0, 0]);
  assert.ok(WHP_SHADE_QUALIFICATION.includes('whiter means higher risk') && !WHP_SHADE_QUALIFICATION.includes('a higher class'));
});

test('the two Wildfire 3D ground switches are on by default, session only, and tell a subscriber which layer changed', async () => {
  const { getFire3DGroundLayer, setFire3DGroundLayer, onFire3DGroundLayerChange } = await import('../src/state/fire3d-ground-layers.ts');
  assert.deepEqual([getFire3DGroundLayer('plantStress'), getFire3DGroundLayer('fuelRisk')], [true, true]);
  const changes = [];
  const release = onFire3DGroundLayerChange(layer => changes.push([layer, getFire3DGroundLayer(layer)]));
  setFire3DGroundLayer('fuelRisk', false);
  setFire3DGroundLayer('fuelRisk', false);
  assert.deepEqual([getFire3DGroundLayer('plantStress'), getFire3DGroundLayer('fuelRisk')], [true, false]);
  setFire3DGroundLayer('plantStress', false);
  setFire3DGroundLayer('fuelRisk', true);
  assert.deepEqual(changes, [['fuelRisk', false], ['plantStress', false], ['fuelRisk', true]]);
  release();
  setFire3DGroundLayer('plantStress', true);
  assert.equal(changes.length, 3);
  // Session state only: the module reads and writes no URL and no storage.
  assert.doesNotMatch(readFileSync(new URL('../src/state/fire3d-ground-layers.ts', import.meta.url), 'utf8'), /import |location|history|Storage/);
});

test('the Impact Briefing carries the plant-stress full text, with NOAA STAR\'s disclaimer whole only beside STAR data', async () => {
  const { DRYNESS_BRIEFING_NOTES: notes, DRYNESS_KEY, drynessBriefing } = await import('../src/layers/wildfire-dryness.ts');
  const { renderMapTechnicalInformation, setPlantStressBriefing } = await import('../src/ui/map-technical-information.ts');
  const { escapeHtml } = await import('../src/util/escape.ts');
  const frame = (productKey) => ({ productKey, clockLabel: 'Week 40: Oct 1 to Oct 7, 2026', qualification: 'definition', coverage: 'coverage' });
  assert.ok(notes.starDisclaimer.includes('not official NOAA operational products') && notes.starDisclaimer.endsWith('redundant operations."'));
  // The owner's words, 2026-10-11 (DR-199).
  assert.equal(DRYNESS_KEY.starTitle, 'Plant stress (NOAA-STAR)');
  assert.equal(DRYNESS_KEY.rgTitle, 'Relative "Greenness" (USGS), whiter is less green');
  assert.equal(DRYNESS_KEY.starNoValue, 'No value shown (snow, ice, water, desert, or missing data)');
  assert.equal(notes.starDesert, 'NOAA STAR: "For the area without vegetation (desert, high mountains, etc.), the displayed indices characterize surface conditions." Bare ground, snow and ice, and water, as NOAA STAR\'s land-cover layer marks them, are not drawn.');
  assert.equal(notes.fuelRiskOverlap, 'Whiter ground means higher fuel risk, more plant stress, or both. They are two separate products drawn together; the brightness is not a combined fire-danger rating.');
  assert.ok(notes.starMiddle.endsWith('read the 48 to 60 class with caution.') && !notes.starMiddle.includes('grey'));
  assert.equal(drynessBriefing(frame('star-vhi')).lines.at(-1), notes.starDisclaimer);

  // The fuel-risk vintage stays in the briefing whether or not Plant stress is switched on.
  const vintage = '<p>Wildfire Hazard Potential 2023 reflects landscape conditions as of the end of 2020 (USFS), so areas burned since then still show their earlier class.</p>';
  assert.ok(!renderMapTechnicalInformation().includes('Plant stress ground') && renderMapTechnicalInformation().includes(vintage));
  // The cut is said in the briefing, and in five words in the Wildfire 3D key only.
  assert.ok(renderMapTechnicalInformation().includes('<p>In Wildfire 3D, fuel risk is not drawn inside current fire perimeters (NIFC).</p>'));
  const shade = await import('../src/config/whp-shade.ts');
  assert.equal(shade.WHP_3D_SHADE_QUALIFICATION, `${shade.WHP_SHADE_QUALIFICATION} Not drawn inside fire perimeters.`);
  setPlantStressBriefing(drynessBriefing(frame('star-vhi')));
  const star = renderMapTechnicalInformation();
  for (const line of [DRYNESS_KEY.starTitle, 'Week 40: Oct 1 to Oct 7, 2026', notes.starMeaning, notes.starScope, notes.starRevision,
    notes.starDesert, notes.starMiddle, notes.fuelRiskOverlap, notes.twoProducts, notes.starDisclaimer]) {
    assert.ok(star.includes(`<p>${escapeHtml(line)}</p>`), line);
  }
  assert.equal(star.split(vintage).length, 2);
  assert.ok(star.includes(`href="${notes.starDisclaimerUrl}"`));

  setPlantStressBriefing(drynessBriefing(frame('usgs-relative-greenness')));
  const rg = renderMapTechnicalInformation();
  assert.ok(rg.includes(escapeHtml(notes.rgLowValues)) && rg.includes(escapeHtml(DRYNESS_KEY.rgTitle)));
  assert.ok(!rg.includes('STAR says') && !rg.includes(notes.starDisclaimerUrl));

  setPlantStressBriefing(null);
  assert.ok(!renderMapTechnicalInformation().includes('Plant stress ground'));

  // An unavailable ground names no product, even when a frame was attempted.
  const { describe: describeGround } = await import('../src/layers/wildfire-dryness.ts');
  const none = describeGround({ state: 'unavailable', selected: null, attempted: frame('usgs-relative-greenness'), sourceId: null, failures: [] },
    { getLayer: () => undefined });
  assert.equal(none.title, null);
  assert.deepEqual(none.lines, [DRYNESS_KEY.unavailable]);
});
